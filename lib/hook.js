// design hook 链路：把 impeccable 引擎的检测结论回灌给模型。
//
// 数据流（设计文档 §7）：
//   tools/post-execute(exec, result, next)
//     → 从 exec.name / exec.arguments 提取 file_path
//     → 扩展名不在白名单 → 直接 next()，零开销（AC8）
//     → engine.js 定位引擎（**只定位、绝不下载**，D12）
//     → 调 `impeccable hook`（stdin JSON、3s 超时、观察 exec.signal）
//     → 解析 stdout 的 hookSpecificOutput.additionalContext
//     → severity top-N（默认 8）+ 全会话配额（40 条 / 12k 字符）+ 同文件指纹去重（D9/D2）
//     → 记一行日志（D10）
//     → 返回 { ...downstream, additionalContexts: [UserMessage, ...下游] }（C2）
//
// 三条硬契约（本文件必须一直守住）：
//   C2  additionalContexts 是 UserMessage[]，用 createInjectionMessage() 构造，
//       与内置插件 dsh-repeat-tool-reminder 同形：{ id, role:'user', content:[{type:'text',text}], source:{...} }。
//   C3  异步工作必须观察 exec.signal；被取消就当跳过，不注入。
//   A1  任何失败都不许向会话抛错：引擎缺失/超时/输出怪，一律静默跳过 + 记日志。
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'

import { normalizeConfig, WRITE_TOOL_PATTERN } from './config.js'
import { locateEngine } from './engine.js'
import { getSharedLog } from './log.js'

/** additionalContexts 里消息的来源标记（与内置插件用 source.kind 区分不同来源）。 */
const SOURCE_KIND = 'dsh-impeccable-hook'

/** 引擎注入文本的分组头，例如 `[impeccable@1] Design hook findings requiring review in a.html (2 issue(s)):`。 */
const HEADER_PATTERN = /^\[impeccable@\d+\]/

/** 引擎注入文本的一条 finding：`- L12 [gradient-text] 描述`，行号在 html 引擎里可以没有。 */
const ITEM_PATTERN = /^-\s+(?:L(\d+)\s+)?\[([^\]]+)\]\s*(.*)$/

/** 工具参数里可能承载文件路径的键名，按优先级排列。 */
const PATH_KEYS = Object.freeze(['file_path', 'filePath', 'path', 'target_file', 'file'])

/**
 * 从一次工具调用里提取被写入的文件路径。
 * 只有写类工具（edit/write/multi_edit/apply_patch…）才看参数：读类工具即使带路径
 * 也不触发检测，避免一次读取就白跑引擎（A1）。
 * @param {{name?: unknown, arguments?: unknown}} exec tools/post-execute 的 exec。
 * @returns {string | undefined} 绝对或相对路径；提取不到返回 undefined。
 */
export function extractFilePath(exec) {
  if (exec === null || typeof exec !== 'object') return undefined
  if (typeof exec.name !== 'string' || !WRITE_TOOL_PATTERN.test(exec.name)) return undefined
  const args = exec.arguments
  if (args === null || typeof args !== 'object') return undefined
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * 构造给引擎 hook 的 harness 事件（上游 CLI-CONTRACT §1 的 Claude 形状）。
 * 引擎只认事件对象：hook_event_name 不是 'Stop' 就走 per-edit 即时检测（D1 只做即时层）。
 * @param {{filePath: string, sessionId: string, toolName?: string, callId?: string}} input 事件要素。
 * @returns {object} 可直接 JSON.stringify 的事件对象。
 */
export function buildEngineEvent({ filePath, sessionId, toolName, callId }) {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const cwd = cut > 0 ? filePath.slice(0, cut) : '.'
  return {
    session_id: sessionId,
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: typeof toolName === 'string' && toolName !== '' ? toolName : 'Write',
    tool_input: { file_path: filePath },
    // 引擎用它在 hook_claim 里认领事件，避免同一编辑被多个监听器重复检测。
    tool_use_id: typeof callId === 'string' && callId !== '' ? callId : `${sessionId}:${filePath}`
  }
}

/**
 * 跑一次 `impeccable hook`：写 stdin、读 stdout、按时超时、跟着 exec.signal 取消。
 * 永远 resolve，永不 reject（A1）：失败只是「本次跳过」。
 * @param {string} binPath 引擎可执行文件的本地绝对路径。
 * @param {object} event 事件对象。
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] 超时与取消信号。
 * @returns {Promise<{ok: boolean, result: 'ok'|'timeout'|'aborted'|'error', stdout?: string, stderr?: string, reason?: string}>} 调用结果。
 */
export function runEngineHook(binPath, event, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 3000
  const signal = options.signal
  return new Promise((resolve) => {
    let child
    let timer
    let settled = false
    let onAbort
    /** 收尾：只结算一次，顺手清定时器/信号监听/子进程。 */
    const finish = (payload) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort)
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill()
        } catch {
          /* 杀掉失败不影响结论 */
        }
      }
      resolve(payload)
    }

    try {
      child = spawn(binPath, ['hook'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      finish({ ok: false, result: 'error', reason: `引擎无法启动：${String(error?.message ?? error)}` })
      return
    }

    let stdout = ''
    let stderr = ''
    timer = setTimeout(() => {
      finish({ ok: false, result: 'timeout', reason: `引擎 hook 超过 ${timeoutMs}ms 未返回（D4：跳过不重试）` })
    }, timeoutMs)

    if (signal !== undefined) {
      onAbort = () => finish({ ok: false, result: 'aborted', reason: '工具调用已取消（exec.signal）' })
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 8192) stderr = stderr.slice(-8192)
    })
    child.on('error', (error) => {
      finish({ ok: false, result: 'error', reason: `引擎进程出错：${String(error?.message ?? error)}` })
    })
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, result: 'ok', stdout, stderr })
      else finish({ ok: false, result: 'error', reason: `引擎退出码 ${String(code)}`, stdout, stderr })
    })
    // 引擎不读 stdin 时可能 EPIPE，忽略即可。
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(event))
  })
}

/**
 * 从引擎 stdout 里取出注入文本。
 * 引擎按 harness 输出三种信封（Claude/Grok/Codex、Cursor、Copilot），这里三种都认。
 * @param {unknown} stdout 引擎标准输出原文。
 * @returns {string | undefined} 注入文本；没有内容时 undefined。
 */
export function parseEngineOutput(stdout) {
  const raw = typeof stdout === 'string' ? stdout.trim() : ''
  if (raw === '') return undefined
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object') return undefined
  const candidates = [
    payload.hookSpecificOutput?.additionalContext,
    payload.additionalContext,
    payload.additional_context
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return undefined
}

/**
 * 把引擎注入文本解析成「分组 → findings」结构。
 * 只认 `[impeccable@N]` 开头的分组头：clean/pending ack、抑制提示等文案没有 findings 行，
 * 解析结果里 items 为空，调用方据此丢弃（我们不回灌 ack 噪声，A2）。
 * @param {string} text 引擎注入文本。
 * @returns {{header: string, items: {line?: number, antipattern: string, description: string}[], tail: string[]}[]} 分组列表。
 */
export function parseInjection(text) {
  const blocks = []
  let current
  for (const line of String(text).split('\n')) {
    if (HEADER_PATTERN.test(line)) {
      current = { header: line, items: [], tail: [] }
      blocks.push(current)
      continue
    }
    if (current === undefined) continue
    const match = ITEM_PATTERN.exec(line)
    if (match !== null) {
      current.items.push({
        ...(match[1] === undefined ? {} : { line: Number(match[1]) }),
        antipattern: match[2],
        description: match[3].trim()
      })
    } else {
      current.tail.push(line)
    }
  }
  return blocks
}

/**
 * 按保留的 findings 重建注入文本（丢弃 footer 之外的噪声，保持引擎原有措辞）。
 * @param {{header: string, items: object[], tail: string[]}} block 分组。
 * @param {{line?: number, antipattern: string, description: string}[]} items 本次要注入的 findings。
 * @returns {string} 注入文本（不含首尾空行）。
 */
export function renderInjection(block, items) {
  const lines = [block.header]
  for (const item of items) {
    const where = item.line === undefined ? '' : `L${item.line} `
    lines.push(`- ${where}[${item.antipattern}] ${item.description}`)
  }
  for (const line of block.tail) lines.push(line)
  return lines.join('\n').replace(/\s+$/, '')
}

/**
 * 深冻结（消息对象是不可变的，与内置插件一致）。
 * @template T
 * @param {T} value 待冻结的值。
 * @returns {T} 冻结后的值。
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 构造一条 UserMessage（C2 的唯一正确形状）。
 * 与内置插件 dsh-repeat-tool-reminder 的 createUserMessage 同形：
 * { id, role:'user', content:[{type:'text', text}], source:{kind, form, summary} }。
 * @param {string} text 注入文本。
 * @param {{summary?: string}} [options] 来源摘要，供 UI 折叠显示。
 * @returns {object} 冻结的 UserMessage。
 */
export function createInjectionMessage(text, options = {}) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary: typeof options.summary === 'string' && options.summary !== '' ? options.summary : 'impeccable findings'
    }
  })
}

/**
 * 把一条上下文消息合并进下游判定（C2 的唯一正确合并方式）。
 *
 * 两种判定形状都要照顾：
 *   - `{kind:'block', feedback}`：必须重建对象，否则丢掉 feedback；
 *   - 其余（`accept` 的 content / value 两种变体）：展开下游字段后只追加 additionalContexts。
 * 下游的 additionalContexts 一条都不丢，我们的消息排在最前面（先看到的先修）。
 *
 * 单独导出是为了让 apply() 的启动自检（D11）能在不跑引擎的情况下验证这份形状。
 * @param {object} decision 下游 PostToolDecision。
 * @param {object} message 要追加的 UserMessage。
 * @returns {object} 新的 PostToolDecision。
 */
export function mergeAdditionalContexts(decision, message) {
  if (decision?.kind === 'block') {
    return {
      kind: 'block',
      feedback: decision.feedback,
      additionalContexts: [message, ...(decision.additionalContexts ?? [])]
    }
  }
  return { ...decision, additionalContexts: [message, ...(decision.additionalContexts ?? [])] }
}

/**
 * 建 hook 的会话状态（进程内存，不落盘，D2）。
 * @returns {{instanceId: string, seen: Map<string, number>, injectedFindings: number, injectedChars: number}} 状态。
 */
export function createHookState() {
  return {
    /** 本进程内插件实例的身份，作为没有 agent 时的引擎 session_id。 */
    instanceId: randomUUID(),
    /** 已注入过的 findings 指纹：`文件::antipattern` → 注入时间戳（去重，AC5）。 */
    seen: new Map(),
    /** 已注入的条数与字符数（全会话配额，D9）。 */
    injectedFindings: 0,
    injectedChars: 0
  }
}

/**
 * 创建 tools/post-execute 监听器。
 * @param {{
 *   config?: unknown,
 *   log?: ReturnType<typeof getSharedLog>,
 *   state?: ReturnType<typeof createHookState>,
 *   locate?: (options?: object) => Promise<object>,
 *   runEngine?: typeof runEngineHook,
 *   engineOptions?: object,
 *   isEnabled?: () => boolean
 * }} [deps] 依赖注入（测试用假引擎，生产用真引擎）。
 * @returns {(exec: object, result: object, next: () => Promise<object>) => Promise<object>} 监听器。
 */
export function createPostExecuteHook(deps = {}) {
  const config = deps.config !== null && typeof deps.config === 'object' && 'allowedExts' in deps.config
    ? deps.config
    : normalizeConfig(deps.config)
  const log = deps.log ?? getSharedLog()
  const state = deps.state ?? createHookState()
  const locate = deps.locate ?? locateEngine
  const runEngine = deps.runEngine ?? runEngineHook
  const engineOptions = deps.engineOptions ?? {}
  // 开关的读取点（D3）：`/impeccable-hook on|off` 改的是**同一次运行内**这份开关，
  // 所以这里走闭包而不是直接读 config.enabled —— 改完立刻生效，不用重启（S5 硬要求 3）。
  const isEnabled = deps.isEnabled ?? (() => config.enabled !== false)

  /**
   * 跑检测并决定本轮要不要注入。永远不抛错（A1）。
   * @param {object} exec 工具调用。
   * @param {string} filePath 已通过白名单的文件路径。
   * @returns {Promise<{message?: object, injected: number}>} 注入结果。
   */
  async function detect(exec, filePath) {
    const startedAt = Date.now()
    const base = { file: filePath, tool: typeof exec.name === 'string' ? exec.name : undefined }

    const engine = await locate({ ...engineOptions, signal: exec.signal })
    if (engine?.available !== true || typeof engine.path !== 'string') {
      // AC3：静默关闭，只在日志/status 里说明原因。
      log.record({ ...base, result: 'no-engine', ms: Date.now() - startedAt, reason: engine?.reason })
      return { injected: 0 }
    }
    if (typeof engine.warning === 'string' && engine.warning !== '') {
      // 同会话同告警只记一次（captain 裁决 m00258 第 1 条）。
      log.warningOnce(`engine:${engine.warning}`, engine.warning)
    }

    const event = buildEngineEvent({
      filePath,
      sessionId: typeof exec.agent?.id === 'string' && exec.agent.id !== '' ? exec.agent.id : state.instanceId,
      toolName: exec.name,
      callId: exec.callId
    })
    const run = await runEngine(engine.path, event, { timeoutMs: config.timeoutMs, signal: exec.signal })
    const ms = Date.now() - startedAt
    const engineInfo = { level: engine.level ?? undefined, engineVersion: engine.engineVersion ?? undefined }

    if (!run.ok) {
      log.record({ ...base, ...engineInfo, result: run.result, ms, reason: run.reason })
      return { injected: 0 }
    }

    const text = parseEngineOutput(run.stdout)
    if (text === undefined) {
      log.record({ ...base, ...engineInfo, result: 'ok', findings: 0, injected: 0, ms })
      return { injected: 0 }
    }

    const blocks = parseInjection(text)
    const total = blocks.reduce((sum, block) => sum + block.items.length, 0)
    if (total === 0) {
      // clean ack / pending ack / 抑制提示：没有 findings 行，不回灌（A2 不灌噪声）。
      log.record({ ...base, ...engineInfo, result: 'ok', findings: 0, injected: 0, ms })
      return { injected: 0 }
    }

    // 1) 同文件同规则指纹去重（D2/AC5）。
    const fresh = []
    let deduped = 0
    for (const block of blocks) {
      const kept = []
      for (const item of block.items) {
        const fingerprint = `${filePath}::${item.antipattern}`
        if (state.seen.has(fingerprint)) {
          deduped += 1
          continue
        }
        kept.push({ item, fingerprint })
      }
      if (kept.length > 0) fresh.push({ block, kept })
    }
    if (fresh.length === 0) {
      log.record({ ...base, ...engineInfo, result: 'dedup', findings: total, injected: 0, ms })
      return { injected: 0 }
    }

    // 2) severity top-N（D9）：引擎按严重度渲染，这里按其顺序取前 N 条。
    const remainingQuota = Math.max(0, config.maxFindingsPerSession - state.injectedFindings)
    const budget = Math.min(config.topN, remainingQuota)
    if (budget === 0) {
      log.record({ ...base, ...engineInfo, result: 'quota', findings: total, injected: 0, ms })
      return { injected: 0 }
    }

    // 3) 逐条累加字符预算（D9），超了就停在配额上。
    const remainingChars = Math.max(0, config.maxCharsPerSession - state.injectedChars)
    const injectedFingerprints = []
    const rendered = []
    /** 已定稿分组的字符总数（含分组之间的空行）。 */
    let committedChars = 0
    let dropped = 0
    for (const { block, kept } of fresh) {
      const keep = []
      // 本组起始偏移：第一组从头算，之后每组前面多一个空行。
      const baseChars = rendered.length === 0 ? 0 : committedChars + 2
      for (const { item, fingerprint } of kept) {
        if (injectedFingerprints.length >= budget) {
          dropped += 1
          continue
        }
        // 组文本随 keep 增长，所以每条都按「本组当前文本」重算一次。
        const projectedChars = baseChars + renderInjection(block, [...keep, item]).length
        if (projectedChars > remainingChars) {
          dropped += 1
          continue
        }
        keep.push(item)
        injectedFingerprints.push(fingerprint)
      }
      if (keep.length > 0) {
        const text = renderInjection(block, keep)
        rendered.push(text)
        committedChars = baseChars + text.length
      }
    }

    if (injectedFingerprints.length === 0) {
      log.record({ ...base, ...engineInfo, result: 'quota', findings: total, injected: 0, ms })
      return { injected: 0 }
    }

    const injectionText = rendered.join('\n\n')
    const chars = injectionText.length
    state.injectedFindings += injectedFingerprints.length
    state.injectedChars += chars
    for (const fingerprint of injectedFingerprints) state.seen.set(fingerprint, Date.now())

    log.record({
      ...base,
      ...engineInfo,
      result: 'ok',
      findings: total,
      injected: injectedFingerprints.length,
      chars,
      ms,
      ...(deduped > 0 || dropped > 0
        ? { reason: `去重 ${deduped} 条、超出 top-N/配额 ${dropped} 条` }
        : {})
    })
    return {
      injected: injectedFingerprints.length,
      message: createInjectionMessage(injectionText, {
        summary: `impeccable findings × ${injectedFingerprints.length}`
      })
    }
  }

  /**
   * tools/post-execute 监听器本体。
   * 契约：next() 恰好调用一次；下游判定原样透传，只追加 additionalContexts（C2）。
   * @param {object} exec 工具调用。
   * @param {object} result 工具执行结果（Readonly<ToolExecutionResult>，只用来看 isError）。
   * @param {() => Promise<object>} next 取下游判定。
   * @returns {Promise<object>} PostToolDecision。
   */
  return async function postExecute(exec, result, next) {
    if (!isEnabled()) return next()

    // 0) 写工具自己就失败了（权限/路径不存在/编辑冲突）：文件没被写成功，
    //    再去扫它并把 findings 灌给模型等于对着「没生效的改动」报问题，纯误导（N3）。
    //    放在最前面，与扩展名白名单同等零开销：不提取路径、不 locate、不调引擎。
    if (result?.isError === true) {
      log.count('errorSkip')
      return next()
    }

    // 1) 提取路径：只有写类工具才值得看一眼参数。
    const filePath = extractFilePath(exec)
    if (filePath === undefined) return next()

    // 2) 扩展名白名单：不在名单里就在调引擎之前放行，零开销（AC8）。
    if (!config.allowedExts.has(extname(filePath).toLowerCase())) {
      log.count('extSkip')
      return next()
    }

    // 3) 与下游并行：引擎检测不额外增加会话等待时间（AC4）。
    //    detect 内部已吞掉所有异常，这里再兜一层，保证「检测失败绝不影响工具结果」（A1）。
    const [decision, detected] = await Promise.all([
      next(),
      detect(exec, filePath).catch(() => ({ injected: 0 }))
    ])
    const { message } = detected
    if (message === undefined) return decision

    // 4) 合并：前置我们的消息，下游的 additionalContexts 一条不丢。
    return mergeAdditionalContexts(decision, message)
  }
}

/**
 * 把 hook 挂到插件上下文上。
 * @param {import('cordis').Context} ctx 插件上下文。
 * @param {unknown} rawConfig 插件 config（cordis.patch.yml 的 config 段）。
 * @param {{log?: object, state?: object, locate?: Function, runEngine?: Function, engineOptions?: object, switch?: {enabled: boolean}}} [deps] 依赖注入。
 * @returns {{
 *   log: object,
 *   state: object,
 *   config: object,
 *   switch: {enabled: boolean},
 *   listener: Function,
 *   isEnabled: () => boolean
 * }} 供命令层（status/on/off/log）与启动自检复用的句柄。
 */
export function attachHook(ctx, rawConfig, deps = {}) {
  const config = normalizeConfig(rawConfig)
  const log = deps.log ?? getSharedLog()
  const state = deps.state ?? createHookState()
  // 运行期开关：初值来自插件 config，之后由 `/impeccable-hook on|off` 直接改这个对象（D3），
  // hook 热路径每轮读它，所以改完立刻生效、不用重启。
  const switchState = deps.switch ?? { enabled: config.enabled === true }
  const isEnabled = () => switchState.enabled === true
  const listener = createPostExecuteHook({ ...deps, config, log, state, isEnabled })
  // 监听器随插件 fiber 卸载自动注销，所以不显式保存 disposer。
  ctx.on('tools/post-execute', listener)
  return { log, state, config, switch: switchState, listener, isEnabled }
}
