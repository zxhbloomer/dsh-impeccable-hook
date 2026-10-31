// t4（S4 hook 链路）单测：路径提取 → 白名单 → 调引擎 → 解析 → 去重/配额 → 组装 additionalContexts。
//
// 对应设计文档验收点：
//   AC2 引擎 findings 变成 [impeccable@1] 文案回灌到 additionalContexts
//   AC3 引擎不可用时静默关闭（不抛错、不注入）
//   AC4 与下游并行，检测不额外拖慢会话（这里断言调用顺序与「只 next() 一次」）
//   AC5 同文件同规则第二次不重复注入
//   AC8 白名单外扩展名在调引擎之前就放行
//   AC9 多条 findings 只注入 top-N
// 以及 C2（additionalContexts 是 UserMessage[]）、C3（观察 exec.signal）、D12（热路径不下载）。
//
// 全部用依赖注入的假引擎，不依赖本机是否装了引擎；真机链路另有 run 命令取证。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  attachHook,
  buildEngineEvent,
  createHookState,
  createInjectionMessage,
  createPostExecuteHook,
  extractFilePath,
  parseEngineOutput,
  parseInjection,
  renderInjection
} from '../lib/hook.js'
import { createHookLog } from '../lib/log.js'
import { normalizeConfig } from '../lib/config.js'

/** 真机抓到的注入文本（html 引擎无行号）。 */
const SAMPLE_TEXT = [
  '[impeccable@1] Design hook findings requiring review in hero.html (2 issue(s)):',
  '- [gradient-text] Gradient text is decorative rather than meaningful — a common AI tell.',
  '- [dark-glow] Heavy glow shadow on a card reads as generated.',
  '',
  'Triage each finding, then state in your reply what you fixed.'
].join('\n')

/** 一条写类工具调用。 */
function makeExec(overrides = {}) {
  return {
    callId: 'call-1',
    name: 'Write',
    arguments: { file_path: 'C:\\proj\\hero.html' },
    signal: new AbortController().signal,
    agent: { id: 'sess-1' },
    ...overrides
  }
}

/** 假引擎：返回给定 stdout（或失败结果）。 */
function fakeEngine(outcome) {
  const calls = []
  const runEngine = async (binPath, event, options) => {
    calls.push({ binPath, event, options })
    if (typeof outcome === 'function') return outcome(binPath, event, options)
    return outcome
  }
  return { runEngine, calls }
}

/** 假定位：默认「引擎可用」。 */
function fakeLocate(engine = { available: true, path: 'C:\\eng\\impeccable.exe', level: 'user-skill', engineVersion: '0.1.18' }) {
  const calls = []
  const locate = async (options) => {
    calls.push(options)
    return engine
  }
  return { locate, calls }
}

/** 引擎 stdout 信封。 */
function envelope(text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
}

/** 建一个装好假依赖的监听器。 */
function makeHook({
  config,
  engineOutcome = { ok: true, result: 'ok', stdout: envelope(SAMPLE_TEXT) },
  locateResult,
  state,
  log,
  engineOptions
} = {}) {
  const logImpl = log ?? createHookLog()
  const stateImpl = state ?? createHookState()
  const locateImpl = fakeLocate(locateResult)
  const engineImpl = fakeEngine(engineOutcome)
  const listener = createPostExecuteHook({
    config,
    log: logImpl,
    state: stateImpl,
    locate: locateImpl.locate,
    runEngine: engineImpl.runEngine,
    engineOptions
  })
  return { listener, log: logImpl, state: stateImpl, locate: locateImpl, engine: engineImpl }
}

/** 统计注入文本里的 finding 行数。 */
function countItemLines(text) {
  return text.split('\n').filter((line) => /^-\s+(?:L\d+\s+)?\[/.test(line)).length
}

// ---------------------------------------------------------------- 路径提取

test('extractFilePath：写类工具取 file_path', () => {
  assert.equal(extractFilePath(makeExec()), 'C:\\proj\\hero.html')
})

test('extractFilePath：读类工具一律不看参数（A1）', () => {
  for (const name of ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch']) {
    assert.equal(extractFilePath(makeExec({ name })), undefined, name)
  }
})

test('extractFilePath：兼容 camelCase 与其他键名', () => {
  assert.equal(extractFilePath(makeExec({ name: 'Edit', arguments: { filePath: '/a/b.vue' } })), '/a/b.vue')
  assert.equal(extractFilePath(makeExec({ name: 'apply_patch', arguments: { path: '/a/b.css' } })), '/a/b.css')
  assert.equal(extractFilePath(makeExec({ name: 'replace_in_file', arguments: { target_file: '/a/b.tsx' } })), '/a/b.tsx')
})

test('extractFilePath：脏输入返回 undefined 而不是抛错', () => {
  assert.equal(extractFilePath(null), undefined)
  assert.equal(extractFilePath('nope'), undefined)
  assert.equal(extractFilePath(makeExec({ arguments: null })), undefined)
  assert.equal(extractFilePath(makeExec({ arguments: { file_path: '   ' } })), undefined)
  assert.equal(extractFilePath(makeExec({ arguments: { file_path: 42 } })), undefined)
})

// ---------------------------------------------------------------- 引擎事件

test('buildEngineEvent：Claude 形状 + cwd 取文件所在目录', () => {
  const event = buildEngineEvent({ filePath: 'C:\\proj\\src\\hero.html', sessionId: 'sess-1', toolName: 'Edit', callId: 'call-9' })
  assert.equal(event.session_id, 'sess-1')
  assert.equal(event.cwd, 'C:\\proj\\src')
  assert.equal(event.hook_event_name, 'PostToolUse')
  assert.equal(event.tool_name, 'Edit')
  assert.deepEqual(event.tool_input, { file_path: 'C:\\proj\\src\\hero.html' })
  assert.equal(event.tool_use_id, 'call-9')
})

test('buildEngineEvent：POSIX 路径与缺省值', () => {
  const posix = buildEngineEvent({ filePath: '/a/b/hero.css', sessionId: 's' })
  assert.equal(posix.cwd, '/a/b')
  assert.equal(posix.tool_name, 'Write')
  assert.equal(posix.tool_use_id, 's:/a/b/hero.css')
})

// ---------------------------------------------------------------- 输出解析

test('parseEngineOutput：三种信封都能取到文案', () => {
  assert.equal(parseEngineOutput(envelope('A')), 'A')
  assert.equal(parseEngineOutput(JSON.stringify({ additionalContext: 'B' })), 'B')
  assert.equal(parseEngineOutput(JSON.stringify({ additional_context: 'C' })), 'C')
})

test('parseEngineOutput：空/坏 JSON/无文案一律 undefined', () => {
  assert.equal(parseEngineOutput(''), undefined)
  assert.equal(parseEngineOutput('   \n'), undefined)
  assert.equal(parseEngineOutput('not json'), undefined)
  assert.equal(parseEngineOutput(JSON.stringify({ hookSpecificOutput: {} })), undefined)
  assert.equal(parseEngineOutput(undefined), undefined)
})

test('parseInjection：分组头 + findings + footer', () => {
  const blocks = parseInjection(SAMPLE_TEXT)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].header, /^\[impeccable@1\]/)
  assert.deepEqual(blocks[0].items.map((item) => item.antipattern), ['gradient-text', 'dark-glow'])
  assert.equal(blocks[0].items[0].line, undefined, 'html 引擎不给行号')
  assert.match(blocks[0].items[1].description, /glow shadow/)
  assert.ok(blocks[0].tail.some((line) => line.includes('Triage each finding')))
})

test('parseInjection：带行号的 finding 解析出 line', () => {
  const text = ['[impeccable@1] findings in a.tsx (1 issue(s)):', '- L42 [tiny-tap-target] Tap target too small.'].join('\n')
  const [block] = parseInjection(text)
  assert.equal(block.items[0].line, 42)
  assert.equal(block.items[0].antipattern, 'tiny-tap-target')
  assert.equal(block.items[0].description, 'Tap target too small.')
})

test('parseInjection：ack 文案没有分组头也没有 findings 行（不注入噪声，A2）', () => {
  const ack = 'impeccable: design hook found nothing to report in hero.html.'
  assert.deepEqual(parseInjection(ack), [])
  const headerOnly = parseInjection('[impeccable@1] Design hook is clean for hero.html')
  assert.equal(headerOnly.length, 1)
  assert.equal(headerOnly[0].items.length, 0)
})

test('renderInjection：重建文本保留原措辞并去掉尾部空白', () => {
  const [block] = parseInjection(SAMPLE_TEXT)
  const text = renderInjection(block, [block.items[0]])
  assert.match(text, /^\[impeccable@1\] Design hook findings requiring review in hero\.html/)
  assert.equal(countItemLines(text), 1, '只渲染传入的那一条')
  assert.match(text, /\[gradient-text\]/)
  assert.doesNotMatch(text, /dark-glow/)
  assert.match(text, /Triage each finding, then state in your reply what you fixed\.$/, 'footer 保留且无尾换行空白')
  assert.equal(renderInjection(block, block.items), SAMPLE_TEXT.trim())
})

// ---------------------------------------------------------------- 消息形状（C2）

test('createInjectionMessage：UserMessage[] 要求的形状', () => {
  const message = createInjectionMessage(SAMPLE_TEXT, { summary: 'impeccable findings × 2' })
  assert.equal(message.role, 'user')
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(Array.isArray(message.content), true)
  assert.deepEqual(Object.keys(message.content[0]), ['type', 'text'])
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, SAMPLE_TEXT)
  assert.equal(message.source.kind, 'dsh-impeccable-hook')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.summary, 'impeccable findings × 2')
})

test('createInjectionMessage：深冻结（与内置插件一致）', () => {
  const message = createInjectionMessage('x')
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content), true)
  assert.equal(Object.isFrozen(message.content[0]), true)
  assert.equal(Object.isFrozen(message.source), true)
})

// ---------------------------------------------------------------- 白名单与放行（AC8 / A1）

test('AC8：白名单外扩展名在调引擎之前就放行', async () => {
  const { listener, locate, engine, log } = makeHook()
  const decision = { kind: 'accept', value: 1 }
  let nextCalls = 0
  const out = await listener(makeExec({ arguments: { file_path: 'C:\\proj\\README.md' } }), {}, async () => {
    nextCalls += 1
    return decision
  })
  assert.equal(out, decision, '下游判定必须原样透传')
  assert.equal(nextCalls, 1, 'next() 恰好一次')
  assert.equal(locate.calls.length, 0, '不定位引擎')
  assert.equal(engine.calls.length, 0, '不跑引擎')
  assert.equal(log.stats().extSkip, 1, '计入 extSkip 计数（D10）')
})

test('N3：写工具自己失败（result.isError）时整条链路不启动，零开销', async () => {
  const { listener, locate, engine, log } = makeHook()
  // 注意这里是 .html（白名单内）—— 若没有 N3 闸门，它会被扫描并注入。
  const decision = { kind: 'accept', value: 'write-failed' }
  let nextCalls = 0
  const out = await listener(makeExec(), { isError: true, error: { message: 'EACCES' }, content: [] }, async () => {
    nextCalls += 1
    return decision
  })
  assert.ok(Object.is(out, decision), '下游判定必须原样透传（同一引用，不是重建对象）')
  assert.equal(nextCalls, 1, 'next() 恰好一次')
  assert.equal(locate.calls.length, 0, '写失败时不许定位引擎')
  assert.equal(engine.calls.length, 0, '写失败时不许起引擎进程')
  const stats = log.stats()
  assert.equal(stats.errorSkip, 1, '计入独立的 errorSkip 计数（N3，不混进 extSkip）')
  assert.equal(stats.extSkip, 0, '不许混进 extSkip')
  assert.equal(stats.calls, 0, '一次检测都不许计')
})

test('N3：isError:false（写成功）照常检测，不受闸门影响', async () => {
  const { listener, engine, log } = makeHook()
  const out = await listener(makeExec(), { isError: false, value: null, content: [] }, async () => ({ kind: 'accept', value: 1 }))
  assert.equal(out.additionalContexts?.length, 1, '写成功时照常注入')
  assert.equal(engine.calls.length, 1, '写成功时才调引擎')
  assert.equal(log.stats().errorSkip, 0, '成功路径不增加 errorSkip')
})

test('非写类工具直接放行，零开销', async () => {
  const { listener, locate, engine } = makeHook()
  const decision = { kind: 'accept', value: 2 }
  const out = await listener(makeExec({ name: 'Read' }), {}, async () => decision)
  assert.equal(out, decision)
  assert.equal(locate.calls.length, 0)
  assert.equal(engine.calls.length, 0)
})

test('config.enabled=false 时整条链路不启动（D3 开关，零引擎调用）', async () => {
  const { listener, locate, engine, log } = makeHook({ config: { hook: { enabled: false } } })
  const decision = { kind: 'accept', value: 3 }
  const out = await listener(makeExec(), {}, async () => decision)
  assert.equal(out, decision, '关闭时下游判定原样透传')
  assert.equal(locate.calls.length, 0, '开关关闭时不许去定位引擎（t6 反向用例）')
  assert.equal(engine.calls.length, 0, '更不许起一次引擎进程')
  assert.equal(log.stats().calls, 0, '一次检测都不许计（D3）')
})

test('运行期 off 立刻生效：switch.enabled 改为 false 后热路径立刻零调用', async () => {
  const handle = attachHook({ on: () => {} }, { hook: { enabled: true } }, { log: createHookLog() })
  assert.equal(handle.isEnabled(), true)
  const first = await handle.listener(makeExec(), {}, async () => ({ kind: 'accept', value: 'a' }))
  assert.equal(first.kind, 'accept')

  // 与 `/impeccable-hook off` 走的是同一个对象：改 switch.enabled 即可，不用重启。
  handle.switch.enabled = false
  assert.equal(handle.isEnabled(), false)
  const before = handle.log.stats().calls
  const second = await handle.listener(makeExec(), {}, async () => ({ kind: 'accept', value: 'b' }))
  assert.equal(second.value, 'b', '关闭后判定原样透传')
  assert.equal(handle.log.stats().calls, before, '关闭后不再产生检测计数')
})

test('AC3：引擎不可用时静默跳过并记原因，绝不抛错', async () => {
  const { listener, log } = makeHook({
    locateResult: { available: false, reason: '三级降级全部失败：skill 照常可用，hook 静默关闭' }
  })
  const decision = { kind: 'accept', value: 4 }
  const out = await listener(makeExec(), {}, async () => decision)
  assert.equal(out, decision)
  const stats = log.stats()
  assert.equal(stats.noEngine, 1)
  assert.equal(stats.last.result, 'no-engine')
  assert.match(stats.last.reason, /三级降级全部失败/)
  assert.equal(stats.injections, 0)
})

// ---------------------------------------------------------------- 注入主链路（AC2）

test('AC2：findings 变成 [impeccable@1] 文案并前置到 additionalContexts', async () => {
  const { listener, log, engine } = makeHook()
  const downstreamMessage = { id: 'downstream', role: 'user', content: [{ type: 'text', text: '下游自己的提示' }] }
  const decision = { kind: 'accept', value: 'tool-result', additionalContexts: [downstreamMessage] }
  let nextCalls = 0
  const out = await listener(makeExec(), {}, async () => {
    nextCalls += 1
    return decision
  })

  assert.equal(nextCalls, 1, 'next() 恰好一次')
  assert.equal(out.kind, 'accept')
  assert.equal(out.value, 'tool-result', '下游判定字段原样保留')
  assert.equal(out.additionalContexts.length, 2)
  const [ours, theirs] = out.additionalContexts
  assert.deepEqual(theirs, downstreamMessage, '下游消息一条不丢')
  assert.equal(ours.role, 'user')
  assert.match(ours.content[0].text, /^\[impeccable@1\]/)
  assert.match(ours.content[0].text, /gradient-text/)
  assert.equal(countItemLines(ours.content[0].text), 2)
  assert.equal(ours.source.kind, 'dsh-impeccable-hook')

  const stats = log.stats()
  assert.equal(stats.injections, 1)
  assert.equal(stats.findings, 2)
  assert.equal(stats.last.result, 'ok')
  assert.equal(stats.last.injected, 2)
  assert.equal(engine.calls.length, 1, '只跑一次引擎')
})

test('block 判定被重建时保留 feedback，并前置我们的消息', async () => {
  const { listener } = makeHook()
  const feedback = [{ type: 'text', text: '阻塞原因' }]
  const out = await listener(makeExec(), {}, async () => ({ kind: 'block', feedback, additionalContexts: [] }))
  assert.equal(out.kind, 'block')
  assert.equal(out.feedback, feedback)
  assert.equal(out.additionalContexts.length, 1)
  assert.equal(out.additionalContexts[0].source.kind, 'dsh-impeccable-hook')
})

test('下游没有 additionalContexts 时只追加我们的一条', async () => {
  const { listener } = makeHook()
  const out = await listener(makeExec(), {}, async () => ({ kind: 'accept', value: 7 }))
  assert.equal(out.additionalContexts.length, 1)
})

// ---------------------------------------------------------------- 去重与配额（AC5 / AC9 / D9）

test('AC5：同文件同规则第二次不再注入', async () => {
  const { listener, log, state } = makeHook({ state: createHookState() })
  const next = async () => ({ kind: 'accept', value: 1 })

  const first = await listener(makeExec(), {}, next)
  assert.equal(first.additionalContexts.length, 1)
  assert.equal(state.injectedFindings, 2)
  assert.equal(state.seen.size, 2)

  const second = await listener(makeExec(), {}, next)
  assert.equal(second.additionalContexts, undefined, '第二次不注入')
  const stats = log.stats()
  assert.equal(stats.last.result, 'dedup')
  assert.equal(stats.dedup, 2)
  assert.equal(stats.injections, 1)
})

test('AC5：换文件后同样的规则允许再注入一次', async () => {
  const { listener } = makeHook()
  const next = async () => ({ kind: 'accept', value: 1 })
  await listener(makeExec(), {}, next)
  const other = await listener(makeExec({ arguments: { file_path: 'C:\\proj\\other.html' } }), {}, next)
  assert.equal(other.additionalContexts.length, 1)
})

test('AC9：20 条 findings 按 top-N 只注入 8 条，计数一致', async () => {
  const items = Array.from({ length: 20 }, (_, i) => `- [rule-${i}] 第 ${i} 条问题`)
  const text = ['[impeccable@1] findings in hero.html (20 issue(s)):', ...items, '', 'Triage each finding.'].join('\n')
  const { listener, log, state } = makeHook({
    engineOutcome: { ok: true, result: 'ok', stdout: envelope(text) }
  })
  const out = await listener(makeExec(), {}, async () => ({ kind: 'accept', value: 1 }))
  const injected = out.additionalContexts[0].content[0].text
  assert.equal(countItemLines(injected), 8, 'top-N 默认 8')
  assert.match(injected, /rule-0/, '按引擎严重度顺序取前 N 条')
  assert.doesNotMatch(injected, /rule-9\]/)
  assert.equal(state.injectedFindings, 8)
  assert.equal(log.stats().findings, 8, '计数与实际注入条数一致')
  assert.match(log.stats().last.reason, /超出 top-N\/配额 12 条/)
})

test('topN 可配置', async () => {
  const items = Array.from({ length: 6 }, (_, i) => `- [rule-${i}] 问题 ${i}`)
  const text = ['[impeccable@1] findings:', ...items].join('\n')
  const { listener } = makeHook({
    config: { hook: { topN: 2 } },
    engineOutcome: { ok: true, result: 'ok', stdout: envelope(text) }
  })
  const out = await listener(makeExec(), {}, async () => ({ kind: 'accept', value: 1 }))
  assert.equal(countItemLines(out.additionalContexts[0].content[0].text), 2)
})

test('会话条数配额用尽后记 quota，不再注入（D9）', async () => {
  const text = ['[impeccable@1] findings:', '- [a] 甲', '- [b] 乙'].join('\n')
  const { listener, log, state } = makeHook({
    config: { hook: { maxFindingsPerSession: 2 } },
    engineOutcome: { ok: true, result: 'ok', stdout: envelope(text) }
  })
  const next = async () => ({ kind: 'accept', value: 1 })
  const first = await listener(makeExec(), {}, next)
  assert.equal(first.additionalContexts[0].content[0].text.includes('[b]'), true)
  assert.equal(state.injectedFindings, 2)

  const second = await listener(makeExec({ arguments: { file_path: 'C:\\proj\\two.html' } }), {}, next)
  assert.equal(second.additionalContexts, undefined)
  assert.equal(log.stats().last.result, 'quota')
  assert.equal(log.stats().quota, 2)
})

test('字符配额：注入文本不超过剩余字符预算（D9）', async () => {
  const items = Array.from({ length: 8 }, (_, i) => `- [rule-${i}] ${'x'.repeat(120)}`)
  const text = ['[impeccable@1] findings:', ...items, '', 'Triage each finding.'].join('\n')
  const { listener, log } = makeHook({
    config: { hook: { topN: 8, maxCharsPerSession: 500 } },
    engineOutcome: { ok: true, result: 'ok', stdout: envelope(text) }
  })
  const out = await listener(makeExec(), {}, async () => ({ kind: 'accept', value: 1 }))
  const injected = out.additionalContexts[0].content[0].text
  assert.ok(injected.length <= 500, `注入 ${injected.length} 字符 <= 500`)
  assert.ok(countItemLines(injected) >= 1, '至少还能注入一条')
  assert.equal(log.stats().last.chars, injected.length)
})

// ---------------------------------------------------------------- 超时与取消（C3 / D4）

test('超时算跳过不算失败：不抛错、不注入、记 timeout 且不重试', async () => {
  const { listener, log, engine } = makeHook({
    engineOutcome: { ok: false, result: 'timeout', reason: 'exceeded 3000ms' }
  })
  const decision = { kind: 'accept', value: 5 }
  const out = await listener(makeExec(), {}, async () => decision)
  assert.equal(out, decision)
  assert.equal(engine.calls.length, 1, '只跑一次，不重试')
  const stats = log.stats()
  assert.equal(stats.last.result, 'timeout')
  assert.equal(stats.timeouts, 1)
  assert.equal(stats.injections, 0)
})

test('取消（aborted）同样只是跳过', async () => {
  const { listener, log } = makeHook({ engineOutcome: { ok: false, result: 'aborted', reason: 'aborted' } })
  const out = await listener(makeExec(), {}, async () => ({ kind: 'accept', value: 6 }))
  assert.equal(out.value, 6)
  assert.equal(log.stats().aborted, 1)
})

test('C3：exec.signal 传给定位与引擎调用，超时预算来自 config', async () => {
  const { listener, locate, engine } = makeHook({ config: { hook: { timeoutMs: 1234 } } })
  const exec = makeExec()
  await listener(exec, {}, async () => ({ kind: 'accept', value: 1 }))
  assert.equal(locate.calls[0].signal, exec.signal, '定位要能被打断')
  assert.equal(engine.calls[0].options.signal, exec.signal, '引擎要能被打断')
  assert.equal(engine.calls[0].options.timeoutMs, 1234)
})

test('D12：engineOptions 原样传给 locate（热路径不下载由 locateEngine 保证）', async () => {
  const { listener, locate } = makeHook({ engineOptions: { platform: 'win32', arch: 'x64' } })
  await listener(makeExec(), {}, async () => ({ kind: 'accept', value: 1 }))
  assert.equal(locate.calls[0].platform, 'win32')
  assert.equal(locate.calls[0].arch, 'x64')
  assert.notEqual(locate.calls[0].allowDownload, true, '热路径绝不允许下载')
})

test('引擎告警同会话只记一次', async () => {
  const items = ['[impeccable@1] findings:', '- [a] 甲'].join('\n')
  const { listener, log } = makeHook({
    locateResult: { available: true, path: 'C:\\eng.exe', level: 'user-skill', warning: '引擎摘要与钉死版本不符' },
    engineOutcome: { ok: true, result: 'ok', stdout: envelope(items) }
  })
  const next = async () => ({ kind: 'accept', value: 1 })
  await listener(makeExec(), {}, next)
  await listener(makeExec({ arguments: { file_path: 'C:\\proj\\b.html' } }), {}, next)
  const warnings = log.entries(100).filter((entry) => entry.result === 'warning')
  assert.equal(warnings.length, 1, '同一条告警只落一行')
})

test('引擎输出无法解析时按 error 记日志且不注入', async () => {
  const { listener, log } = makeHook({ engineOutcome: { ok: true, result: 'ok', stdout: 'garbage' } })
  const decision = { kind: 'accept', value: 8 }
  const out = await listener(makeExec(), {}, async () => decision)
  assert.equal(out, decision)
  assert.equal(log.stats().last.result, 'ok')
  assert.equal(log.stats().last.findings, 0)
})

// ---------------------------------------------------------------- attachHook（宿主接线）

test('attachHook 注册 tools/post-execute 并返回 status 句柄', async () => {
  const events = []
  const ctx = { on: (name, listener) => { events.push({ name, listener }) } }
  const handle = attachHook(ctx, { hook: { topN: 3, maxFindingsPerSession: 9 } }, { log: createHookLog() })

  assert.equal(events.length, 1)
  assert.equal(events[0].name, 'tools/post-execute')
  assert.equal(handle.config.topN, 3)
  assert.equal(handle.config.maxFindingsPerSession, 9)
  assert.equal(typeof handle.state.instanceId, 'string')
  assert.equal(typeof handle.log.stats, 'function')

  // 从 ctx 拿到的监听器必须真的能用（不只是挂上了）。
  const out = await events[0].listener(makeExec({ name: 'Read' }), {}, async () => ({ kind: 'accept', value: 9 }))
  assert.equal(out.value, 9)
})

test('attachHook 对畸形 config 不抛错，退默认值', () => {
  const ctx = { on: () => {} }
  const handle = attachHook(ctx, 'not-an-object', { log: createHookLog() })
  assert.equal(handle.config.enabled, true)
  assert.equal(handle.config.topN, 8)
  assert.equal(handle.config.timeoutMs, 3000)
  assert.equal(handle.config.allowedExts.has('.vue'), true)
})

// ---------------------------------------------------------------- 真实链路（不联网）

test('真实 locateEngine 串进 hook：没有引擎时静默跳过且绝不下载（D12）', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'impeccable-hook-'))
  const skillDir = join(sandbox, 'pkg', 'skills', 'impeccable')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '# impeccable\n')
  const workDir = join(sandbox, 'work')
  mkdirSync(workDir, { recursive: true })
  const filePath = join(workDir, 'hero.html')
  writeFileSync(filePath, '<h1>hi</h1>')

  let fetches = 0
  const log = createHookLog()
  // 不注入 locate：走 lib/engine.js 的真实 locateEngine()。
  const listener = createPostExecuteHook({
    log,
    state: createHookState(),
    engineOptions: {
      platform: 'win32',
      arch: 'x64',
      pkgRoot: join(sandbox, 'pkg'),
      skillDir,
      dshHome: join(sandbox, 'dsh'),
      impeccableHome: join(sandbox, 'impeccable'),
      downloadBase: 'https://example.invalid/download',
      fetchImpl: async () => {
        fetches += 1
        throw new Error('热路径不允许联网下载')
      }
    }
  })

  const decision = { kind: 'accept', value: 'ok' }
  const out = await listener(makeExec({ arguments: { file_path: filePath } }), {}, async () => decision)

  assert.equal(out, decision, '没有引擎也必须原样透传')
  assert.equal(fetches, 0, '热路径一次网络请求都不许发（D12）')
  const stats = log.stats()
  assert.equal(stats.last.result, 'no-engine')
  assert.match(stats.last.reason, /skill 照常可用/)
  assert.equal(stats.injections, 0)
})

test('hook 的默认配置与 config.js 一致（回归保护）', () => {
  const normalized = normalizeConfig(undefined)
  const { config } = attachHook({ on: () => {} }, undefined, { log: createHookLog() })
  assert.deepEqual({ ...config, allowedExts: [...config.allowedExts].sort() }, { ...normalized, allowedExts: [...normalized.allowedExts].sort() })
})
