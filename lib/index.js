// dsh-impeccable-hook —— 把 impeccable 设计 skill 随包分发到 DeepSeek Harness，
// 并在工具执行后把 design hook 的检测结论回灌给模型。
//
// 当前处于设计文档 S5（宿主命令 + 启动自检），apply() 做四件事：
//   1) 向宿主 skills 注册表注册包内 skill provider（G1：装完 /impeccable 即可用）
//   2) 挂 tools/post-execute 监听器，把引擎 findings 组装成 additionalContexts 回灌（G2）
//   3) 注册宿主命令 `/impeccable-hook status|on|off|log`（G3：0-Token 自查，C6/C7）
//   4) 启动自检（D11）：事件与 PostToolDecision 形状存活，失败则由 status 标红 + 启动一行 warning（AC10）
//
// 设计依据：docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md
//   C2 回灌内容必须放在 PostToolDecision.additionalContexts（类型 UserMessage[]）
//   C3 异步监听器必须观察 exec.signal
//   C4 registerProvider 注册到「调用上下文的层」，同名冲突只在同一层内按 rank 决胜
//   C5 SkillSummary 带 path / provider，status 靠它断言实际加载的是哪一份（AC1）
//   C7 绝不注册 `/impeccable` 命令（会抢掉 skill 的用户入口）
//   D11 apply() 时做一次事件与签名存活自检
//   D12 hook 热路径只定位引擎、绝不下载（下载只发生在 status/显式动作）
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { PLUGIN_NAME } from './config.js'
import { registerCommands } from './commands.js'
import { attachHook, createInjectionMessage, mergeAdditionalContexts } from './hook.js'

/** 插件名，同时作为 skill provider 名（同一层内重名会抛错，必须全局唯一）。 */
const name = PLUGIN_NAME

/** 硬依赖 skills（注册 provider）与 commands（注册 /impeccable-hook）。 */
const inject = ['skills', 'commands']

/** 包根目录：本模块位于 `<包根>/lib/index.js`。 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 包内 skill 根目录 `<包根>/skills`：由本模块位置推导，是包自身的事实，不读用户配置。 */
const SKILLS_ROOT = join(PKG_ROOT, 'skills')

/** 包内 impeccable skill 目录：S6 由 scripts/sync-upstream.mjs 从上游落地。 */
const SKILL_DIR = join(SKILLS_ROOT, 'impeccable')

/**
 * 包内 skill 的注册优先级。
 * 层由调用上下文决定（C4），rank 只在同一层内决胜；D5 要求包内副本优先于用户目录
 * `$DSH_HOME/skills/impeccable`，所以取一个明显高于文件系统 provider 的值。
 * 具体数值在 S5 用 `/impeccable-hook status` 打印的实际解析路径（AC1）校准。
 */
const PACKAGED_SKILL_RANK = 900

/** 包内 skill 在提示词里显示的来源桶（自定义来源，与内置 bundled 区分）。 */
const SOURCE = 'custom'

/**
 * 解析 SKILL.md 开头 `---` 包裹的 YAML frontmatter。
 * 只取 DSH skill 发现需要的标量字段（name / description / whenToUse），
 * 其余键原样透传，不做 YAML 全语法解析 —— 避免为骨架引入依赖。
 * @param {string} text SKILL.md 全文。
 * @returns {{metadata: Record<string, string>, body: string} | null} 无 frontmatter 时返回 null。
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const block = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const metadata = {}
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    metadata[match[1]] = value
  }
  return { metadata, body }
}

/**
 * 读取并解析一个 skill 目录的 SKILL.md。
 * @param {string} skillFile SKILL.md 绝对路径。
 * @param {AbortSignal} [signal] 取消信号；已取消则不再解析。
 * @returns {Promise<object | undefined>} 文件不存在或无 frontmatter 时返回 undefined。
 */
async function parseSkillFile(skillFile, signal) {
  let text
  try {
    text = await readFile(skillFile, 'utf8')
  } catch {
    return undefined
  }
  if (signal?.aborted) return undefined
  const parsed = parseFrontmatter(text)
  if (parsed === null) return undefined
  return {
    name: parsed.metadata.name ?? '',
    description: parsed.metadata.description ?? '',
    whenToUse: parsed.metadata.whenToUse,
    metadata: parsed.metadata,
    content: parsed.body
  }
}

/**
 * 扫描包内 skills 目录，产出候选列表（正文延后到 get() 才读）。
 * 包内快照由 `node scripts/sync-upstream.mjs` 落到 skills/impeccable（已入库，C8）；
 * 目录不存在时返回空列表（正常状态，不抛错）——此时 status 的「与包内路径」比对会报不一致。
 * @param {string} skillsRoot 包内 skills 目录绝对路径。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<object[]>} 候选 skill 列表。
 */
async function discoverCandidates(skillsRoot, signal) {
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (signal?.aborted) break
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    const parsed = await parseSkillFile(skillFile, signal)
    if (parsed === undefined) continue
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      source: SOURCE,
      provider: name,
      rank: PACKAGED_SKILL_RANK,
      locator: skillDir,
      // C5：path 是 status 断言「实际解析到哪一份」的依据。
      path: skillFile,
      ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {})
    })
  }
  return candidates
}

/**
 * 向宿主 skills 注册表注册包内 provider。
 * 未 scoped 的调用上下文进 global 层（C4），因此所有 agent preset 都能看到包内 skill。
 * @param {import('cordis').Context} ctx 插件上下文。
 */
function registerSkillProvider(ctx) {
  ctx.skills.registerProvider(() => ({
    name,
    list: (options) => discoverCandidates(SKILLS_ROOT, options.signal),
    async get(candidate, options) {
      const parsed = await parseSkillFile(candidate.path, options.signal)
      if (parsed === undefined) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        invocation: { modelInvocable: true, userInvocable: true },
        source: SOURCE,
        provider: name,
        // 相对引用（references/*.md 等）以 skill 目录为资源根。
        resourceBase: { kind: 'directory', path: candidate.locator },
        path: candidate.path,
        ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {}),
        content: parsed.content
      }
    }
  }))
}

/**
 * 启动自检（D11 / AC10）：确认事件与判定形状在当前 DSH 上仍然存活。
 *
 * 三条设计取舍：
 *   1) 用**真实监听器**走一遍假 exec（不带文件路径 ⇒ 引擎一次都不会被调用，A1/A4 不受影响）；
 *   2) 既验「下游判定被原样透传」（别被上游改动改写），也验 C2 的
 *      `additionalContexts: UserMessage[]` 形状（这是最容易在升级后静默变异的契约）；
 *   3) 失败只打**一行** warning 并把结论放进 status（AC10：启动失败要响，运行失败可静默）。
 * @param {object} ctx 插件上下文。
 * @param {object} handle attachHook 返回的句柄。
 * @returns {Promise<{ok: boolean, at: string, reason?: string}>} 自检结论。
 */
async function runStartupSelfCheck(ctx, handle) {
  const at = new Date().toISOString()
  try {
    if (typeof ctx?.on !== 'function') throw new Error('ctx.on 不可用：拿不到事件总线')
    if (typeof handle?.listener !== 'function') throw new Error('tools/post-execute 监听器未挂载')

    const downstream = { kind: 'accept', value: { selfCheck: true } }
    const decision = await handle.listener({ name: 'read', arguments: {} }, {}, async () => downstream)
    if (decision !== downstream) throw new Error('下游 PostToolDecision 未被原样透传（事件契约可能变了）')

    const merged = mergeAdditionalContexts(downstream, createInjectionMessage('self-check'))
    if (!Array.isArray(merged.additionalContexts) || merged.additionalContexts.length !== 1) {
      throw new Error('PostToolDecision.additionalContexts 不是 UserMessage[]（C2 契约变动）')
    }
    const message = merged.additionalContexts[0]
    if (message?.role !== 'user' || !Array.isArray(message?.content) || message.content[0]?.type !== 'text') {
      throw new Error('UserMessage 形状不符（C2 契约变动）')
    }
    if (merged.kind !== 'accept' || merged.value !== downstream.value) {
      throw new Error('合并 additionalContexts 时丢了下游字段（accept.value 变体）')
    }

    handle.selfCheck = { ok: true, at }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    handle.selfCheck = { ok: false, at, reason }
    const warn = typeof ctx?.logger?.warn === 'function' ? ctx.logger.warn.bind(ctx.logger) : undefined
    warn?.(`[${PLUGIN_NAME}] 启动自检失败：${reason}（详情见 /impeccable-hook status）`)
  }
  return handle.selfCheck
}

/**
 * 插件入口：注册 skill provider → 挂 design hook → 注册宿主命令 → 启动自检。
 * 顺序有意义：skill 先注册好，hook 才可能拿到引擎（引擎位置来自 skill 目录约定）。
 * hook 内部所有失败都收敛成「静默跳过 + 记日志」，不会让插件加载失败（A1/AC3）。
 * @param {import('cordis').Context} ctx 插件上下文。
 * @param {unknown} [config] 来自 cordis.patch.yml 的插件配置（D3：hook 开关写这里）。
 * @returns {Array<() => void>} 命令注册产生的 disposer（fiber 卸载时自动执行）。
 */
function apply(ctx, config) {
  registerSkillProvider(ctx)
  const handle = attachHook(ctx, config)
  // 自检是异步的，但 apply() 不能等它（会拖慢启动）；结论落在 handle 上供 status 读。
  void runStartupSelfCheck(ctx, handle)

  try {
    return registerCommands(ctx, { handle, pkgRoot: PKG_ROOT, skillDir: SKILL_DIR })
  } catch (error) {
    // 命令注册失败不影响 skill 与 hook 生效，但必须可见（否则用户以为 status 能用）。
    const reason = error instanceof Error ? error.message : String(error)
    handle.commandsError = reason
    const warn = typeof ctx?.logger?.warn === 'function' ? ctx.logger.warn.bind(ctx.logger) : undefined
    warn?.(`[${PLUGIN_NAME}] /impeccable-hook 命令注册失败：${reason}`)
    return []
  }
}

// runStartupSelfCheck 单独导出：单测要能直接驱动自检（AC10），排错时也能手动跑一遍。
export { apply, name, inject, runStartupSelfCheck }
export default { apply, name, inject }
