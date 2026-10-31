// 插件层测试（设计 §5 的 test/plugin.test.mjs）：宿主命令、启动自检、版本三件套。
//
// 覆盖的验收点：
//   AC1  status 打印实际解析到的 SKILL.md 绝对路径，并断言与包内路径「一致/不一致」
//   AC3  引擎缺失时 status 写明「未找到及原因」
//   AC10 启动自检失败时 status 标红（CommandResult.kind='error'）
//   C7   只注册 `impeccable-hook`，绝不注册 `impeccable`
//   D3   on/off 只写插件 config，不碰 .impeccable/config.json
//   D10  log 渲染统计 + 明细
//
// 这些用例不联网、不用真引擎（引擎用 engineResolver 注入假对象）。

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  COMMAND_NAME,
  parseAction,
  registerCommands,
  renderLog,
  renderStatus,
  setEnabled
} from '../lib/commands.js'
import { apply, runStartupSelfCheck } from '../lib/index.js'
import { createHookLog, getSharedLog } from '../lib/log.js'
import { buildVersionReport, compareVersions, readLock } from '../lib/version.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 造一个假插件上下文，记录事件监听、命令注册与 warning。
 * @param {{skills?: object, configEditor?: object, services?: object}} [options] 可选 Service。
 * @returns {{ctx: object, listeners: object[], commands: object[], warnings: string[]}} 夹具。
 */
function createFakeCtx(options = {}) {
  const listeners = []
  const commands = []
  const warnings = []
  const services = options.services ?? {}
  const ctx = {
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    logger: { warn: (message) => warnings.push(String(message)) },
    skills: options.skills,
    configEditor: options.configEditor,
    commands: { register: (definition) => (commands.push(definition), () => {}) },
    get(key) {
      return services[key]
    }
  }
  return { ctx, listeners, commands, warnings }
}

/**
 * 造一个 attachHook 形状的句柄（命令层只需要这些字段）。
 * @param {{enabled?: boolean, selfCheck?: object, log?: object}} [options] 覆盖项。
 * @returns {object} 句柄。
 */
function createHandle(options = {}) {
  return {
    switch: { enabled: options.enabled ?? true },
    selfCheck: 'selfCheck' in options ? options.selfCheck : { ok: true, at: '2026-10-31T00:00:00.000Z' },
    log: options.log ?? createHookLog(),
    state: { injectedFindings: 0, injectedChars: 0 },
    config: { topN: 8, maxFindingsPerSession: 40, maxCharsPerSession: 12000 }
  }
}

/**
 * 造一个「skills 里已经有 impeccable」的假服务。
 * @param {string} actualPath 报告出来的 SKILL.md 路径。
 * @returns {object} 假 skills 服务。
 */
function createSkills(actualPath) {
  const summary = { name: 'impeccable', provider: 'dsh-impeccable-hook', source: 'custom', path: actualPath }
  return {
    registerProvider() {
      return () => {}
    },
    async list() {
      return [summary]
    },
    async get() {
      return { ...summary }
    }
  }
}

test('parseAction：默认 status，其余按首词分派', () => {
  assert.deepEqual(parseAction(''), { action: 'status', args: [] })
  assert.deepEqual(parseAction('   '), { action: 'status', args: [] })
  assert.deepEqual(parseAction('on'), { action: 'on', args: [] })
  assert.deepEqual(parseAction('LOG 30'), { action: 'log', args: ['30'] })
  assert.deepEqual(parseAction('status download'), { action: 'status', args: ['download'] })
})

test('C7：只注册 impeccable-hook，绝不注册 impeccable', () => {
  const { ctx, commands } = createFakeCtx({ services: { commands: undefined } })
  // 用 ctx.commands（上面的假 registry）注册
  registerCommands(ctx, { handle: createHandle(), pkgRoot: PKG_ROOT, skillDir: join(PKG_ROOT, 'skills', 'impeccable') })
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, COMMAND_NAME)
  assert.equal(commands[0].name, 'impeccable-hook')
  assert.notEqual(commands[0].name, 'impeccable')
  // 防御：任何人改成 impeccable 都会在下面这条断言上炸
  assert.ok(!commands.some((definition) => definition.name === 'impeccable'))
  assert.equal(typeof commands[0].handler, 'function')
})

test('AC1：status 打印实际路径并判定与包内路径一致', async () => {
  const skillDir = join(PKG_ROOT, 'skills', 'impeccable')
  const packaged = join(skillDir, 'SKILL.md')
  const { ctx } = createFakeCtx({ skills: createSkills(packaged) })
  const result = await renderStatus({
    ctx,
    handle: createHandle(),
    pkgRoot: PKG_ROOT,
    skillDir,
    engineResolver: async () => ({ available: false, reason: '测试夹具：三级全失败' })
  })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes(packaged), '必须打印实际解析到的绝对路径')
  assert.match(result.text, /一致 ✓/)
  assert.match(result.text, /provider=dsh-impeccable-hook/)
  assert.match(result.text, /source=custom/)
})

test('AC1：实际路径不是包内那份时明确打印「不一致」', async () => {
  const skillDir = join(PKG_ROOT, 'skills', 'impeccable')
  const foreign = 'C:\\Users\\somebody\\.dsh\\skills\\impeccable\\SKILL.md'
  const { ctx } = createFakeCtx({ skills: createSkills(foreign) })
  const result = await renderStatus({
    ctx,
    handle: createHandle(),
    pkgRoot: PKG_ROOT,
    skillDir,
    engineResolver: async () => ({ available: false, reason: '测试夹具：三级全失败' })
  })
  assert.ok(result.text.includes(foreign))
  assert.match(result.text, /不一致 ✗/)
  assert.match(result.text, /包内应为/)
})

test('AC3：引擎缺失时 status 写明未找到与原因，并给出下载入口', async () => {
  const { ctx } = createFakeCtx({ skills: createSkills(join(PKG_ROOT, 'skills', 'impeccable', 'SKILL.md')) })
  const result = await renderStatus({
    ctx,
    handle: createHandle(),
    pkgRoot: PKG_ROOT,
    skillDir: join(PKG_ROOT, 'skills', 'impeccable'),
    engineResolver: async () => ({
      available: false,
      reason: '三级降级全部失败；skill 照常可用，hook 静默关闭',
      attempts: [{ level: 'user-skill', label: '用户级已装', ok: false, reason: '不存在' }]
    })
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /未找到/)
  assert.match(result.text, /三级降级全部失败/)
  assert.match(result.text, /status download/)
  assert.match(result.text, /user-skill/)
})

test('verified:false 时两个版本号并排显示', async () => {
  const { ctx } = createFakeCtx({ skills: createSkills(join(PKG_ROOT, 'skills', 'impeccable', 'SKILL.md')) })
  const result = await renderStatus({
    ctx,
    handle: createHandle(),
    pkgRoot: PKG_ROOT,
    skillDir: join(PKG_ROOT, 'skills', 'impeccable'),
    engineResolver: async () => ({
      available: true,
      level: 'user-skill',
      label: '用户级已装',
      path: 'C:\\fake\\impeccable.exe',
      engineVersion: '0.1.17',
      verified: false,
      verifyReason: 'sha256 与 engine-checksums.txt 不符',
      warning: '本机引擎版本与内置钉死版本不同'
    })
  })
  assert.match(result.text, /0\.1\.17 ≠ 钉死 0\.1\.18/)
  assert.match(result.text, /verified=false/)
  assert.match(result.text, /sha256 与 engine-checksums\.txt 不符/)
})

test('AC10：启动自检失败时 status 标红（kind=error）', async () => {
  const { ctx } = createFakeCtx({ skills: createSkills(join(PKG_ROOT, 'skills', 'impeccable', 'SKILL.md')) })
  const result = await renderStatus({
    ctx,
    handle: createHandle({ selfCheck: { ok: false, at: '2026-10-31T00:00:00.000Z', reason: 'PostToolDecision.additionalContexts 不是 UserMessage[]' } }),
    pkgRoot: PKG_ROOT,
    skillDir: join(PKG_ROOT, 'skills', 'impeccable'),
    engineResolver: async () => ({ available: false, reason: '测试夹具' })
  })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /✗ 失败/)
  assert.match(result.text, /additionalContexts 不是 UserMessage/)
})

test('D3：on/off 立刻生效并写回插件 config，不碰 .impeccable/config.json', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'impeccable-hook-cmd-'))
  const edits = []
  const entry = { name: 'dsh-impeccable-hook' }
  const configEditor = {
    entries: () => [entry],
    configuration: () => [],
    edit: async (target, change) => {
      assert.equal(target, entry)
      edits.push(change({ hook: { enabled: true, topN: 8 } }, {}))
    }
  }
  const { ctx } = createFakeCtx({ configEditor })
  const handle = createHandle({ enabled: true })

  const off = await setEnabled({ ctx, handle, enabled: false })
  assert.equal(off.kind, 'success')
  assert.equal(handle.switch.enabled, false, '开关必须立刻生效（hook 每轮读 switch）')
  assert.deepEqual(edits[0], { hook: { enabled: false, topN: 8 } }, '只改 enabled，其余字段保留')
  await assert.rejects(readFile(join(tmp, '.impeccable', 'config.json')), '绝不创建用户仓库的 .impeccable/config.json')

  const on = await setEnabled({ ctx, handle, enabled: true })
  assert.equal(on.kind, 'success')
  assert.equal(handle.switch.enabled, true)
  assert.equal(edits[1].hook.enabled, true)
})

test('D3：插件行只有 options.name 时也能定位（findPluginEntry 候选补齐）', async () => {
  const edits = []
  const entry = { options: { name: 'dsh-impeccable-hook' } }
  const configEditor = {
    entries: () => [{ name: 'some-other-plugin' }, entry],
    configuration: () => [],
    edit: async (target, change) => {
      assert.equal(target, entry)
      edits.push(change({}, {}))
    }
  }
  const { ctx } = createFakeCtx({ configEditor })
  const result = await setEnabled({ ctx, handle: createHandle({ enabled: true }), enabled: false })
  assert.equal(result.kind, 'success')
  assert.equal(edits.length, 1)
  assert.equal(edits[0].hook.enabled, false)
})

test('D3：优先用 ctx.fiber.entry（Loader 记录的那一行），不按名字猜', async () => {
  const own = { name: 'dsh-impeccable-hook', id: 'own-row' }
  const decoy = { name: 'dsh-impeccable-hook', id: 'decoy-row' }
  const edits = []
  const configEditor = {
    entries: () => [decoy],
    configuration: () => [],
    edit: async (target, change) => {
      edits.push({ target, next: change({}, {}) })
    }
  }
  const { ctx } = createFakeCtx({ configEditor })
  ctx.fiber = { entry: own }
  const result = await setEnabled({ ctx, handle: createHandle({ enabled: true }), enabled: false })
  assert.equal(result.kind, 'success')
  assert.equal(edits.length, 1)
  assert.equal(edits[0].target.id, 'own-row', '必须写回自己那一行，而不是同名诱饵')
  assert.equal(edits[0].next.hook.enabled, false)
})

test('status：打一行深度体检（engine-probe 无响应也不影响「可用」判定）', async () => {
  const skillDir = join(PKG_ROOT, 'skills', 'impeccable')
  const { ctx } = createFakeCtx({ skills: createSkills(join(skillDir, 'SKILL.md')) })
  const result = await renderStatus({
    ctx,
    handle: createHandle(),
    pkgRoot: PKG_ROOT,
    skillDir,
    engineResolver: async () => ({
      available: true,
      level: 'user-skill',
      label: '①用户级已装 skill 的引擎',
      path: join(tmpdir(), 'no-such-impeccable-engine-xyz.exe'),
      engineVersion: '0.1.18',
      verified: true
    })
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /深度体检 engine-probe/)
  assert.match(result.text, /无响应/)
  assert.match(result.text, /不影响上面的判定/)
})

test('configEditor 不可用：开关仍立刻生效，但如实报告「没能持久化」', async () => {
  const { ctx } = createFakeCtx()
  const handle = createHandle({ enabled: true })
  const result = await setEnabled({ ctx, handle, enabled: false })
  assert.equal(result.kind, 'error')
  assert.equal(handle.switch.enabled, false)
  assert.match(result.text, /没能持久化/)
  assert.match(result.text, /cordis\.patch\.yml/)
})

test('D10：log 渲染统计 + 明细（文件、条数、结果、时间）', () => {
  const log = createHookLog()
  log.record({ result: 'ok', file: 'C:\\proj\\hero.html', tool: 'write', findings: 3, injected: 2, chars: 900, ms: 42 })
  log.record({ result: 'dedup', file: 'C:\\proj\\hero.html', tool: 'write', findings: 2, injected: 0, ms: 21 })
  const result = renderLog({ handle: createHandle({ log }) })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /注入 1 次 \/ 2 条 \/ 900 字符/)
  assert.match(result.text, /去重跳过 2 条/)
  assert.match(result.text, /hero\.html/)
  assert.match(result.text, /ok/)
  assert.match(result.text, /dedup/)
})

test('log 无记录时给出明确提示', () => {
  const result = renderLog({ handle: createHandle() })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /暂无记录/)
})

test('D11：自检通过——监听器原样透传 + additionalContexts 形状正确', async () => {
  const { ctx } = createFakeCtx()
  const handle = { listener: async (_exec, _result, next) => next() }
  const result = await runStartupSelfCheck(ctx, handle)
  assert.equal(result.ok, true)
  assert.equal(typeof result.at, 'string')
})

test('AC10：自检发现下游判定被改写时失败并给出原因', async () => {
  const { ctx, warnings } = createFakeCtx()
  // 模拟 DSH 升级后事件契约变化：监听器拿到的东西不再是原来那个对象
  const handle = { listener: async (_exec, _result, next) => ({ ...(await next()) }) }
  const result = await runStartupSelfCheck(ctx, handle)
  assert.equal(result.ok, false)
  assert.match(result.reason, /未被原样透传/)
  assert.equal(warnings.length, 1, '启动失败必须打一行 warning（AC10）')
  assert.match(warnings[0], /启动自检失败/)
})

test('AC10：拿不到事件总线时自检也失败（而不是静默）', async () => {
  const handle = { listener: async (_exec, _result, next) => next() }
  const result = await runStartupSelfCheck({}, handle)
  assert.equal(result.ok, false)
  assert.match(result.reason, /ctx\.on 不可用/)
})

test('apply()：挂 tools/post-execute、注册命令、不抛错', async () => {
  const { ctx, listeners, commands } = createFakeCtx({ skills: createSkills(join(PKG_ROOT, 'skills', 'impeccable', 'SKILL.md')) })
  const disposers = apply(ctx, { hook: { enabled: true } })
  assert.equal(listeners.filter((item) => item.event === 'tools/post-execute').length, 1)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'impeccable-hook')
  assert.equal(disposers.length, 1)
  // 让 fire-and-forget 的自检跑完，避免留下未处理的 rejection
  await new Promise((resolve) => setTimeout(resolve, 10))
})

test('apply()：commands 服务不可用时不拖垮插件，但要 warning', async () => {
  const { ctx, listeners, warnings } = createFakeCtx({ skills: createSkills(join(PKG_ROOT, 'skills', 'impeccable', 'SKILL.md')) })
  ctx.commands = undefined
  const disposers = apply(ctx, {})
  assert.deepEqual(disposers, [])
  assert.equal(listeners.filter((item) => item.event === 'tools/post-execute').length, 1, 'hook 仍然要挂上')
  assert.ok(warnings.some((message) => message.includes('命令注册失败')))
  await new Promise((resolve) => setTimeout(resolve, 10))
})

test('version：compareVersions 三段比较', () => {
  assert.equal(compareVersions('0.1.18', '0.1.18'), 0)
  assert.equal(compareVersions('0.1.17', '0.1.18'), -1)
  assert.equal(compareVersions('0.2.0', '0.1.18'), 1)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
})

test('version：lock 可读且带两个版本号（G4/D7）', async () => {
  const { lock, error } = await readLock(PKG_ROOT)
  assert.equal(error, undefined)
  assert.equal(typeof lock.skillVersion, 'string')
  assert.equal(typeof lock.engineVersion, 'string')
  assert.equal(lock.repo, 'pbakaus/impeccable')
})

test('version：lock 的 tarball 钉的是 commit 快照，不是移动分支（R2-2）', async () => {
  const { lock, error } = await readLock(PKG_ROOT)
  assert.equal(error, undefined)
  assert.match(lock.tarballSha256, /^[0-9a-f]{64}$/, 'tarballSha256 必须是 sha256 十六进制')
  assert.equal(typeof lock.tarballSource, 'string', '必须记录 tarball 来源 URL')
  assert.ok(lock.tarballSource.includes(lock.commit), 'tarballSource 必须钉 commit sha')
  assert.ok(!lock.tarballSource.includes('refs/heads'), 'tarballSource 不许指向移动分支（那样哈希无法复算）')
  assert.ok(lock.tarballSource.endsWith(`/tar.gz/${lock.commit}`), 'URL 形状：.../tar.gz/<commit>')
})

test('version：快照未落地时如实报告，不假装有版本', async () => {
  const report = await buildVersionReport({
    pkgRoot: PKG_ROOT,
    skillDir: join(PKG_ROOT, 'skills', 'impeccable'),
    engineVersion: undefined
  })
  assert.equal(typeof report.packageVersion, 'string')
  assert.equal(report.upstream.state, 'unknown')
  assert.ok(report.lines.some((line) => line.includes('lock 钉死')))
})

// ───────────────── 整链集成：index.js → hook.js → engine.js（真实链路，不联网） ─────────────────
//
// 与 hook.test.mjs 的区别：这里不注入假 locate / 假 runEngine，用 apply() 挂上去的**真实监听器**，
// 一路走到 lib/engine.js 的 locateEngine()。为了让「引擎不存在」可复现、并证明热路径零网络，
// 把全局 fetch 换成计数器、把 DSH_HOME / IMPECCABLE_HOME 指到临时空目录（t6 硬要求 2）。

/** 起一个临时工程目录，写入一个含渐变的 .html（模拟用户编辑的 UI 文件）。 */
async function makeProject() {
  const projectDir = await mkdtemp(join(tmpdir(), 'impeccable-chain-'))
  const htmlPath = join(projectDir, 'hero.html')
  await writeFile(htmlPath, '<h1 style="background:linear-gradient(#fff,#000)">hi</h1>\n')
  return { projectDir, htmlPath }
}

/** 换成「没有引擎、没有网络」的沙箱；返回计数器和还原函数。 */
async function sandboxNoEngine() {
  const { projectDir, htmlPath } = await makeProject()
  const saved = {
    fetch: globalThis.fetch,
    dshHome: process.env.DSH_HOME,
    impeccableHome: process.env.IMPECCABLE_HOME
  }
  const counter = { fetches: 0 }
  globalThis.fetch = async () => {
    counter.fetches += 1
    throw new Error('热路径不允许联网（D12）')
  }
  process.env.DSH_HOME = join(projectDir, 'no-dsh-home')
  process.env.IMPECCABLE_HOME = join(projectDir, 'no-impeccable-home')
  const restore = () => {
    globalThis.fetch = saved.fetch
    if (saved.dshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.dshHome
    if (saved.impeccableHome === undefined) delete process.env.IMPECCABLE_HOME
    else process.env.IMPECCABLE_HOME = saved.impeccableHome
  }
  return { projectDir, htmlPath, counter, restore }
}

/** 取出 apply() 挂上的 tools/post-execute 监听器。 */
function pickHookListener(listeners) {
  const hit = listeners.find((entry) => entry.event === 'tools/post-execute')
  assert.ok(hit, 'apply() 必须挂上 tools/post-execute')
  return hit.listener
}

test('整链：index.js → hook.js → engine.js 热路径 fetch 调用数为 0（D12 / AC3）', async () => {
  const sandbox = await sandboxNoEngine()
  const before = getSharedLog().stats()
  try {
    const { ctx, listeners } = createFakeCtx({ skills: createSkills(join(PKG_ROOT, 'skills', 'impeccable', 'SKILL.md')) })
    apply(ctx, { hook: { enabled: true } })
    const listener = pickHookListener(listeners)

    const decision = { kind: 'accept', value: 'tool-result' }
    const exec = {
      callId: 'call-chain-1',
      name: 'Write',
      arguments: { file_path: sandbox.htmlPath },
      signal: new AbortController().signal,
      agent: { id: 'sess-chain-1' }
    }
    const out = await listener(exec, {}, async () => decision)

    assert.equal(out, decision, '没有引擎时下游判定原样透传')
    assert.equal(sandbox.counter.fetches, 0, '整条链一次网络请求都不许发（D12）')
    const after = getSharedLog().stats()
    assert.equal(after.calls - before.calls, 0, '引擎一次都没被调起来（所以 calls 不增）')
    assert.equal(after.noEngine - before.noEngine, 1, '由 engine.js 的 locateEngine() 报「找不到引擎」')
    assert.equal(after.last.result, 'no-engine')
    assert.match(after.last.reason, /三级降级|静默关闭/, '原因要能解释给用户（AC3）')
  } finally {
    sandbox.restore()
  }
})

test('整链：白名单外扩展名（.md）连 engine.js 都不进（AC8）', async () => {
  const sandbox = await sandboxNoEngine()
  const mdPath = join(sandbox.projectDir, 'README.md')
  await writeFile(mdPath, '# 不是 UI 文件\n')
  const before = getSharedLog().stats()
  try {
    const { ctx, listeners } = createFakeCtx({ skills: createSkills(join(PKG_ROOT, 'skills', 'impeccable', 'SKILL.md')) })
    apply(ctx, { hook: { enabled: true } })
    const listener = pickHookListener(listeners)

    const decision = { kind: 'accept', value: 42 }
    const exec = {
      callId: 'call-chain-md',
      name: 'Write',
      arguments: { file_path: mdPath },
      signal: new AbortController().signal,
      agent: { id: 'sess-chain-md' }
    }
    const out = await listener(exec, {}, async () => decision)

    assert.equal(out, decision)
    assert.equal(sandbox.counter.fetches, 0)
    const after = getSharedLog().stats()
    assert.equal(after.calls - before.calls, 0, '.md 不该触发一次检测')
    assert.equal(after.noEngine - before.noEngine, 0, '不该走到 engine.js')
    assert.equal(after.extSkip - before.extSkip, 1, '只加一个 extSkip 计数（D10）')
  } finally {
    sandbox.restore()
  }
})

test('整链：hook.enabled=false 时零引擎调用（不是只 return next 却仍去 locate）', async () => {
  const sandbox = await sandboxNoEngine()
  const before = getSharedLog().stats()
  try {
    const { ctx, listeners } = createFakeCtx({ skills: createSkills(join(PKG_ROOT, 'skills', 'impeccable', 'SKILL.md')) })
    apply(ctx, { hook: { enabled: false } })
    const listener = pickHookListener(listeners)

    const decision = { kind: 'accept', value: 'off' }
    const exec = {
      callId: 'call-chain-off',
      name: 'Write',
      arguments: { file_path: sandbox.htmlPath },
      signal: new AbortController().signal,
      agent: { id: 'sess-chain-off' }
    }
    const out = await listener(exec, {}, async () => decision)

    assert.equal(out, decision, '关闭时判定原样透传')
    assert.equal(sandbox.counter.fetches, 0)
    const after = getSharedLog().stats()
    assert.equal(after.calls - before.calls, 0, '开关关闭时一次检测都不许起（D3）')
    assert.equal(after.noEngine - before.noEngine, 0, '更不许去 locate 引擎')
  } finally {
    sandbox.restore()
  }
})

// ───────────── 渲染回归：别把 null 直接打给用户（t6 取证时发现的两处文本缺陷） ─────────────

test('version：引擎版本没探测到时不许谎称「与钉死一致」', async () => {
  const report = await buildVersionReport({
    pkgRoot: PKG_ROOT,
    skillDir: join(PKG_ROOT, 'skills', 'impeccable'),
    engineVersion: undefined
  })
  assert.equal(report.engine.state, 'unknown')
  assert.match(report.engine.text, /未探测到本机引擎/)
  assert.ok(!report.engine.text.includes('一致（'), 'unknown 不许落到 match 分支')
})

test('status：引擎 verified 不是 true 时不打印裸 null', async () => {
  const handle = createHandle()
  handle.log.record({ result: 'ok', file: 'hero.html', tool: 'Write', findings: 1, injected: 1, chars: 1200, ms: 31, level: 'user-skill' })
  const skillDir = join(PKG_ROOT, 'skills', 'impeccable')
  const { ctx } = createFakeCtx({ skills: createSkills(join(skillDir, 'SKILL.md')) })
  const result = await renderStatus({
    ctx,
    handle,
    pkgRoot: PKG_ROOT,
    skillDir,
    // 模拟本机引擎「引擎版本读不到、摘要未收录」的真实状态（包内快照尚未落地时就是这样）。
    engineResolver: async () => ({
      available: true,
      level: 'user-skill',
      label: '①用户级已装 skill 的引擎',
      path: 'C:\fake\impeccable.exe',
      engineVersion: null,
      verified: null,
      verifyReason: '清单 engine-checksums.txt 未收录 (无版本) impeccable-windows-x64.exe',
      warning: null,
      attempts: []
    })
  })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /版本 未知（钉死/)
  assert.ok(!/(；|：)null/.test(result.text), '不许把 null 直接拼进文案')
})
