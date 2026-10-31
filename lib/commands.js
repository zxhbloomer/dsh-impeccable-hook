// 宿主命令 `/impeccable-hook status|on|off|log`：0-Token，不产生 model message（C6）。
//
// 设计依据（docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md）：
//   §6.2 命令面收敛为 4 个：status（默认）/ on / off / log；doctor 已并入 status，engine 子命令已删除。
//   C7   **绝不注册 `/impeccable`** —— client 端优先把 `/name` 解析成宿主命令，注册同名命令
//        会抢掉 skill 的用户入口，`/impeccable audit` 全废。本文件只注册 `impeccable-hook`。
//   AC1  status 必须打印**实际解析到的** SKILL.md 绝对路径（走 ctx.skills，不自己拼路径假装），
//        并与包内路径比对，明确打印「一致 / 不一致」。
//   D3   on/off 只写**插件 config**（cordis.patch.yml 的 config 段），绝不写用户仓库的
//        `.impeccable/config.json`（那个文件只读，引擎自己会写，C11）。
//   D10  log/status 的计数来自 lib/log.js 的进程内统计。
//   D12  下载只发生在 status（显式动作）；hook 热路径只定位。
//   AC3  引擎找不到时，status 必须写明「未找到及原因」。
//   AC10 启动自检失败时 status 要标红（CommandResult.kind='error'）+ 打印失败原因。
//
// 命令契约（cordis_inspect_query host/Service commands）：
//   register({ name, description, input?, handler(invocation) }) → disposer
//   handler 返回 { kind:'success', text } | { kind:'error', text }；rawInput 是命令行里名字之后的全部内容（C6）。

import { join } from 'node:path'

import { PLUGIN_NAME } from './config.js'
import { probeEngineVersion, resolveEngine } from './engine.js'
import { buildVersionReport } from './version.js'

/** 宿主命令名。C7：绝不能是 `impeccable`。 */
export const COMMAND_NAME = 'impeccable-hook'

/** 包内 skill 的名字（它由 skill 自己注册 `/impeccable`，插件不碰）。 */
export const SKILL_NAME = 'impeccable'

/** log 子命令默认显示多少条最近记录。 */
const DEFAULT_LOG_LIMIT = 20

/**
 * 从插件上下文里取一个可选 Service（commands 之外的都按可选处理）。
 * @param {object} ctx 插件上下文。
 * @param {string} key Service 名。
 * @returns {object | undefined} Service 实例，取不到则 undefined。
 */
function getService(ctx, key) {
  const direct = ctx?.[key]
  if (direct !== undefined && direct !== null) return direct
  if (typeof ctx?.get === 'function') {
    try {
      const viaGet = ctx.get(key)
      if (viaGet !== undefined && viaGet !== null) return viaGet
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 把版本号并排显示成一行（AC1 的「verified:false 时两个版本号并排」用）。
 * @param {string | undefined} actual 实际版本。
 * @param {string | undefined} pinned 钉死版本。
 * @returns {string} 一行文案。
 */
function sideBySide(actual, pinned) {
  if (pinned === undefined) return actual ?? '未知'
  if (actual === undefined) return `未知（钉死 ${pinned}）`
  return actual === pinned ? `${actual}（与钉死版本一致）` : `${actual} ≠ 钉死 ${pinned}`
}

/**
 * 通过 skills 服务拿**实际解析到的那一份** skill（AC1）。
 * 先试 agent 视图（preset 层可能自带同名 skill），再退回 global 视图。
 * @param {object} ctx 插件上下文。
 * @param {object} [agent] 命令调用方的 agent（CommandInvocation.agent）。
 * @returns {Promise<{summary?: object, definition?: object, view?: string, error?: string}>} 解析结果。
 */
async function resolveSkillView(ctx, agent) {
  const skills = getService(ctx, 'skills')
  if (skills === undefined) return { error: 'skills 服务不可用（插件注入失败）' }

  const views = []
  if (agent !== undefined && agent !== null) views.push({ scope: agent, label: 'scoped' })
  views.push({ label: 'global' })

  const failures = []
  for (const view of views) {
    const options = view.scope === undefined ? {} : { scope: view.scope }
    try {
      const listed = await skills.list(options)
      const summary = Array.isArray(listed) ? listed.find((item) => item?.name === SKILL_NAME) : undefined
      if (summary === undefined) continue
      let definition
      try {
        definition = await skills.get(SKILL_NAME, options)
      } catch (error) {
        failures.push(`skills.get 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return { summary, definition, view: view.label }
    } catch (error) {
      failures.push(`skills.list(${view.label}) 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    error:
      failures.length > 0
        ? failures.join('；')
        : `skills 注册表里没有名为 ${SKILL_NAME} 的 skill（包内 skills/ 是否已同步？）`
  }
}

/**
 * 路径比较：Windows 下大小写不敏感，其余按原样比。
 * @param {string | undefined} left 左路径。
 * @param {string | undefined} right 右路径。
 * @returns {boolean} 是否指向同一份文件。
 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

/**
 * 深度体检：跑一次 engine-probe 握手，把引擎自报的版本与钉死版本对照（C10：只认 VERSION 文件定版本，
 * 这里只是「它自己说自己是哪个版本」的旁证，不参与可用性判定，失败也只提示一句）。
 * @param {string | null | undefined} binPath 引擎绝对路径。
 * @param {string | undefined} pinned 钉死（lock）的引擎版本。
 * @returns {Promise<string>} 一行文案。
 */
async function describeProbe(binPath, pinned) {
  const probed = await probeEngineVersion(binPath, { timeoutMs: 3000 })
  if (typeof probed !== 'string' || probed === '') {
    return '深度体检 engine-probe 无响应（不影响上面的判定：摘要校验通过即可用）'
  }
  const agree = typeof pinned === 'string' && probed === pinned
  return `深度体检 engine-probe 自报 ${probed}${typeof pinned === 'string' ? `（钉死 ${pinned}${agree ? '，一致' : '，不一致 ⚠'}）` : ''}`
}

/**
 * 渲染 `/impeccable-hook status`。
 * @param {{
 *   ctx: object,
 *   handle: object,
 *   agent?: object,
 *   pkgRoot: string,
 *   skillDir: string,
 *   engineOptions?: object,
 *   download?: boolean,
 *   engineResolver?: typeof resolveEngine
 * }} input 上下文与句柄（engineResolver 只为单测注入假引擎）。
 * @returns {Promise<{kind: 'success' | 'error', text: string}>} 命令结果（自检失败时 kind=error 以便标红）。
 */
export async function renderStatus(input) {
  const {
    ctx,
    handle,
    agent,
    pkgRoot,
    skillDir,
    engineOptions = {},
    download = false,
    engineResolver = resolveEngine
  } = input
  const lines = [`[${COMMAND_NAME}] 状态`]

  // 1) hook 开关（D3：真源是插件 config，运行期由 switch 承载以便立刻生效）
  const enabled = handle?.switch?.enabled === true
  lines.push(`hook 开关    ${enabled ? '开' : '关'}（config.hook.enabled=${enabled}；改它用 /${COMMAND_NAME} on|off）`)

  // 2) 启动自检（D11/AC10）
  const selfCheck = handle?.selfCheck
  let selfCheckFailed = false
  if (selfCheck === undefined) {
    lines.push(`启动自检     进行中（apply() 的异步自检尚未结算）`)
  } else if (selfCheck.ok === true) {
    lines.push(`启动自检     通过：tools/post-execute 已挂载，PostToolDecision 形状存活（${selfCheck.at}）`)
  } else {
    selfCheckFailed = true
    lines.push(`启动自检     ✗ 失败：${selfCheck.reason}`)
    lines.push(`             含义：本版插件与当前 DSH 的 tools/post-execute 契约不匹配，design hook 不会生效。`)
  }

  // 3) skill 实际解析路径（AC1）
  const resolved = await resolveSkillView(ctx, agent)
  if (resolved.error !== undefined) {
    lines.push(`skill 解析   ✗ ${resolved.error}`)
  } else {
    const summary = resolved.summary ?? resolved.definition ?? {}
    const actualPath = resolved.definition?.path ?? summary.path
    const packagedPath = join(skillDir, 'SKILL.md')
    const agrees = samePath(actualPath, packagedPath)
    lines.push(`skill 解析   ${actualPath ?? '（provider 未提供 path）'}`)
    lines.push(
      `             provider=${summary.provider ?? '未知'} ｜ source=${summary.source ?? '未知'} ｜ 视图=${resolved.view}`
    )
    lines.push(
      `             与包内路径 ${agrees ? '一致 ✓' : `不一致 ✗（包内应为 ${packagedPath}，实际解析到 ${actualPath ?? '未知'}）`}`
    )
    if (!agrees) {
      lines.push(`             含义：同层有更高优先级/同名的 impeccable（例如 $DSH_HOME/skills/impeccable），包内副本未生效。`)
    }
    lines.push(`             rank 不在 SkillSummary 上（只有 provider 层候选才有），故此处不打印；排序结论以本路径为准。`)
  }

  // 4) 引擎（D12：默认只定位；只有显式 `status download` 才允许下载）
  let engine
  try {
    engine = await engineResolver({ ...engineOptions, allowDownload: download === true })
  } catch (error) {
    engine = { available: false, reason: `引擎定位抛错：${error instanceof Error ? error.message : String(error)}` }
  }
  const versionReport = await buildVersionReport({
    pkgRoot,
    skillDir,
    engineVersion: typeof engine?.engineVersion === 'string' ? engine.engineVersion : undefined
  })
  const lockEngine = typeof versionReport.lock?.engineVersion === 'string' ? versionReport.lock.engineVersion : undefined

  if (engine?.available === true) {
    const engineVersion = typeof engine.engineVersion === 'string' ? engine.engineVersion : undefined
    lines.push(`引擎         level=${engine.level ?? '未知'}（${engine.label ?? '未标注'}）`)
    lines.push(`             path=${engine.path ?? '未知'}`)
    lines.push(`             版本 ${sideBySide(engineVersion, lockEngine)} ｜ verified=${String(engine.verified)}`)
    if (engine.verified !== true) {
      // 一级引擎（用户自己装的）摘要不符时仍可用，但必须把差异摆出来（captain 裁决 m00258 第 1 条）。
      const reason = engine.verifyReason ?? '未通过'
      const warning = typeof engine.warning === 'string' && engine.warning !== reason ? `；${engine.warning}` : ''
      lines.push(`             摘要校验 ${reason}${warning}`)
    }
    // 深度体检：让引擎自己报一句版本（engine-probe 握手）。这不是 `--version`（C10），
    // 也不参与上面「能不能用」的判定 —— 只在这里把「它自称是谁」摆出来，供人对照。
    lines.push(`             ${await describeProbe(engine.path, lockEngine)}`)
  } else {
    lines.push(`引擎         未找到（三级降级全部失败）`)
    lines.push(`             原因：${engine?.reason ?? '未知'}`)
    for (const attempt of Array.isArray(engine?.attempts) ? engine.attempts : []) {
      lines.push(`             · ${attempt.level}（${attempt.label ?? ''}）${attempt.ok === true ? '可用' : '不可用'}：${attempt.reason}`)
    }
    if (download !== true) {
      lines.push(`             如需插件下载官方引擎（约 20MB、sha256 校验）：/${COMMAND_NAME} status download`)
    }
  }

  // 5) 注入统计（D10/AC9）
  const stats = handle?.log?.stats?.() ?? {}
  const findings = Number.isFinite(stats.findings) ? stats.findings : 0
  const chars = Number.isFinite(stats.chars) ? stats.chars : 0
  const injected = Number.isFinite(stats.injections) ? stats.injections : 0
  lines.push(
    `注入统计     已注入 ${injected} 次 / ${findings} 条 / ${chars} 字符 ｜ 去重跳过 ${stats.dedup ?? 0} 条 ｜ 配额用尽 ${stats.quota ?? 0} 条`
  )
  lines.push(
    `             引擎调用 ${stats.calls ?? 0} 次 ｜ 超时 ${stats.timeouts ?? 0} ｜ 无引擎 ${stats.noEngine ?? 0} ｜ 错误 ${stats.errors ?? 0} ｜ 白名单外跳过 ${stats.extSkip ?? 0} ｜ 写失败跳过 ${stats.errorSkip ?? 0}`
  )
  const last = stats.last
  lines.push(
    `             上次结果 ${last?.result ?? '暂无记录'}${last?.at === undefined ? '' : ` @ ${last.at}`}${last?.reason === undefined ? '' : `（${last.reason}）`}`
  )
  if (handle?.state !== undefined) {
    lines.push(
      `会话配额     已用 ${handle.state.injectedFindings ?? 0}/${handle.config?.maxFindingsPerSession ?? '?'} 条、${handle.state.injectedChars ?? 0}/${handle.config?.maxCharsPerSession ?? '?'} 字符 ｜ top-N ${handle.config?.topN ?? '?'}`
    )
  }

  // 6) 版本与上游（G4）
  for (const line of versionReport.lines) lines.push(line)

  // 7) 已知盲区（R2：如实说明，不许让用户以为全覆盖）
  lines.push(`已知盲区     只覆盖带 file_path 的写类工具（edit/write/apply_patch…）；用 shell 重定向写文件抓不到。`)

  const text = lines.join('\n')
  return selfCheckFailed ? { kind: 'error', text } : { kind: 'success', text }
}

/**
 * 在 configEditor 的可寻址行里找本插件那一行。
 * 优先用 `ctx.fiber.entry`（Loader 记录的「我自己这一行」），拿不到再按名字找。
 * @param {object} configEditor configEditor Service。
 * @param {object} [ctx] 插件上下文（可能带 fiber）。
 * @returns {object | undefined} Loader Entry。
 */
function findPluginEntry(configEditor, ctx) {
  // ctx.fiber.entry 就是本插件自己那一行（Loader 记录），最准，优先用；
  // 但它可能不存在（不是从 Loader 起的场景），所以下面仍要按名字在 profile 里找一遍。
  const own = ctx?.fiber?.entry
  if (own !== undefined && own !== null) {
    if (typeof own === 'object' && own.name !== undefined) return own
    if (typeof own === 'string') {
      const matched = findEntryByField(collectEntries(configEditor), own)
      if (matched !== undefined) return matched
    }
  }
  return findEntryByField(collectEntries(configEditor), PLUGIN_NAME)
}

/**
 * 收集 profile 里可寻址的配置行。
 * @param {object} configEditor configEditor Service。
 * @returns {object[]} Entry 列表。
 */
function collectEntries(configEditor) {
  let entries = []
  try {
    entries = typeof configEditor?.entries === 'function' ? configEditor.entries() : []
  } catch {
    entries = []
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    try {
      const configuration = typeof configEditor?.configuration === 'function' ? configEditor.configuration() : []
      entries = Array.isArray(configuration) ? configuration.map((row) => row?.entry).filter(Boolean) : []
    } catch {
      entries = []
    }
  }
  return Array.isArray(entries) ? entries.filter((entry) => entry !== null && typeof entry === 'object') : []
}

/**
 * 在一组 Entry 里按名字找目标行。
 * 候选字段按「越像插件身份越靠前」排序：Loader 的 entry.name 最常见，
 * 有些 profile 把身份写在 options 里（`{ options: { name } }`），历史字段再兜底。
 * @param {object[]} entries Entry 列表。
 * @param {string} expected 期望的插件名。
 * @returns {object | undefined} 命中的 Entry。
 */
function findEntryByField(entries, expected) {
  return entries.find((entry) => {
    const candidates = [
      entry?.name,
      entry?.id,
      entry?.options?.name,
      entry?.options?.id,
      entry?.plugin,
      entry?.package,
      entry?.module
    ]
    return candidates.some((value) => typeof value === 'string' && value === expected)
  })
}

/**
 * 从一份原始 config 里取 hook 段（兼容 `{hook:{...}}` 与扁平两种写法）。
 * @param {unknown} value 原始 config。
 * @returns {Record<string, unknown>} hook 段（一定是对象）。
 */
function hookSection(value) {
  if (value === null || typeof value !== 'object') return {}
  const record = /** @type {Record<string, unknown>} */ (value)
  const nested = record.hook
  if (nested !== null && typeof nested === 'object') return /** @type {Record<string, unknown>} */ (nested)
  return record
}

/**
 * 执行 `/impeccable-hook on|off`：先切运行期开关（立刻生效），再写回插件 config（持久化，D3）。
 * @param {{ctx: object, handle: object, enabled: boolean}} input 上下文与目标状态。
 * @returns {Promise<{kind: 'success' | 'error', text: string}>} 命令结果。
 */
export async function setEnabled(input) {
  const { ctx, handle, enabled } = input
  const label = enabled ? '开' : '关'
  const previous = handle?.switch?.enabled === true
  // 1) 立刻生效：hook 每轮读 switch，所以哪怕持久化失败，本次会话也已经切换（不会假装成功）。
  if (handle?.switch !== undefined) handle.switch.enabled = enabled

  const configEditor = getService(ctx, 'configEditor')
  if (configEditor === undefined || typeof configEditor.edit !== 'function') {
    return {
      kind: 'error',
      text:
        `已把 hook 切换为「${label}」（本会话立即生效），但 configEditor 服务不可用，**没能持久化**。\n` +
        `请手动把 profile 里本插件的 config 改成 hook.enabled=${enabled}（通常是 cordis.patch.yml 的 config 段）。`
    }
  }

  const entry = findPluginEntry(configEditor, ctx)
  if (entry === undefined) {
    return {
      kind: 'error',
      text:
        `已把 hook 切换为「${label}」（本会话立即生效），但没在 profile 里定位到 ${PLUGIN_NAME} 这一行，**没能持久化**。\n` +
        `请手动把该插件的 config 改成 hook.enabled=${enabled}。`
    }
  }

  try {
    await configEditor.edit(entry, (current, inherited) => {
      const base = current !== null && typeof current === 'object' ? current : {}
      // 优先沿用本行已有的 hook 段；本行没写过就沿用继承层的值，避免把用户继承来的设置拍平成默认值。
      const own = hookSection(current)
      const section = Object.keys(own).length > 0 ? own : hookSection(inherited)
      return { ...base, hook: { ...section, enabled } }
    })
  } catch (error) {
    return {
      kind: 'error',
      text:
        `已把 hook 切换为「${label}」（本会话立即生效），但写回插件 config 失败：` +
        `${error instanceof Error ? error.message : String(error)}。\n请手动把 hook.enabled 改成 ${enabled}。`
    }
  }

  return {
    kind: 'success',
    text:
      `design hook 已${enabled ? '开启' : '关闭'}（之前是「${previous ? '开' : '关'}」）。\n` +
      `已写回插件 config 的 hook.enabled=${enabled}，并立刻生效，不用重启。\n` +
      `没有触碰用户仓库的 .impeccable/config.json（D3：那份只读，引擎自己会写）。`
  }
}

/**
 * 渲染 `/impeccable-hook log [n]`：计数汇总 + 最近 N 条明细（D10）。
 * @param {{handle: object, limit?: number}} input 句柄与条数。
 * @returns {{kind: 'success' | 'error', text: string}} 命令结果。
 */
export function renderLog(input) {
  const { handle, limit } = input
  const log = handle?.log
  if (log === undefined) {
    return { kind: 'error', text: '日志器不可用（插件未完成挂载）。' }
  }
  const requested = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LOG_LIMIT
  const stats = log.stats()
  const entries = log.entries(requested)

  const head =
    `[${COMMAND_NAME}] 注入日志（最近 ${entries.length} 条）\n` +
    `计数：注入 ${stats.injections} 次 / ${stats.findings} 条 / ${stats.chars} 字符 ｜ ` +
    `去重跳过 ${stats.dedup} 条 ｜ 配额用尽 ${stats.quota} 条 ｜ 引擎调用 ${stats.calls} 次\n` +
    `    超时 ${stats.timeouts} ｜ 无引擎 ${stats.noEngine} ｜ 错误 ${stats.errors} ｜ 中断 ${stats.aborted} ｜ 白名单外跳过 ${stats.extSkip} ｜ 写失败跳过 ${stats.errorSkip}`

  if (entries.length === 0) {
    return { kind: 'success', text: `${head}\n\n暂无记录（本进程还没有发生过注入或跳过）。` }
  }

  const rows = entries.map((entry) => {
    const counts = entry.findings > 0 || entry.injected > 0 ? `${entry.injected}/${entry.findings}` : '-'
    const reason = entry.reason === undefined ? '' : `  ${entry.reason}`
    return `${entry.at}  ${entry.result.padEnd(9)}  ${(entry.file ?? '-').padEnd(44)}  ${counts.padStart(5)}  ${String(entry.ms).padStart(5)}ms${reason}`
  })
  return { kind: 'success', text: `${head}\n\n时间                       结果       文件                                            条数   耗时\n${rows.join('\n')}` }
}

/**
 * 解析 rawInput：`status` / `on` / `off` / `log 30`。
 * @param {string} rawInput 命令行里命令名之后的全部内容（C6）。
 * @returns {{action: string, args: string[]}} 动作与剩余参数。
 */
export function parseAction(rawInput) {
  const tokens = String(rawInput ?? '')
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '')
  if (tokens.length === 0) return { action: 'status', args: [] }
  return { action: tokens[0].toLowerCase(), args: tokens.slice(1) }
}

/** 用法说明（未知动作/出错时打印）。 */
const USAGE = [
  `/${COMMAND_NAME} status        查看引擎、skill 实际路径、开关、注入统计与版本（默认动作）`,
  `/${COMMAND_NAME} status download  同上，并在引擎缺失时下载官方引擎（约 20MB，sha256 校验）`,
  `/${COMMAND_NAME} on | off      开关 design hook（写插件 config，立刻生效）`,
  `/${COMMAND_NAME} log [n]       最近 n 条注入/跳过记录（默认 ${DEFAULT_LOG_LIMIT} 条）`
].join('\n')

/**
 * 注册宿主命令（C6/C7：只注册 `impeccable-hook`，绝不注册 `impeccable`）。
 * @param {object} ctx 插件上下文。
 * @param {{
 *   handle: object,
 *   pkgRoot: string,
 *   skillDir: string,
 *   engineOptions?: object
 * }} deps 命令需要的依赖（句柄 + 路径）。
 * @returns {Array<() => void>} 注册产生的 disposer 列表。
 */
export function registerCommands(ctx, deps) {
  const commands = getService(ctx, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    throw new Error('commands 服务不可用：无法注册 /impeccable-hook（宿主缺 commands Service？）')
  }

  const disposer = commands.register({
    name: COMMAND_NAME,
    description: '查看/开关 dsh-impeccable-hook 的 design hook（引擎、skill 实际路径、注入统计、日志）',
    input: { hint: 'status | on | off | log [n]' },
    async handler(invocation) {
      const { action, args } = parseAction(invocation?.rawInput)
      try {
        if (action === 'status') {
          return await renderStatus({
            ctx,
            handle: deps.handle,
            agent: invocation?.agent,
            pkgRoot: deps.pkgRoot,
            skillDir: deps.skillDir,
            ...(deps.engineOptions === undefined ? {} : { engineOptions: deps.engineOptions }),
            download: args.includes('download')
          })
        }
        if (action === 'on' || action === 'off') {
          return await setEnabled({ ctx, handle: deps.handle, enabled: action === 'on' })
        }
        if (action === 'log') {
          const parsed = Number.parseInt(args[0] ?? '', 10)
          return renderLog({ handle: deps.handle, ...(Number.isFinite(parsed) ? { limit: parsed } : {}) })
        }
        return { kind: 'error', text: `未知动作「${action}」。\n\n${USAGE}` }
      } catch (error) {
        // 命令是给人看的，任何异常都要变成可读文本，而不是把栈甩到会话里。
        return { kind: 'error', text: `/${COMMAND_NAME} ${action} 执行失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }
  })
  return [disposer]
}
