// hook 注入/跳过的事件日志（D10）：每次注入或跳过都记一行，供 `/impeccable-hook log`
// 与 `/impeccable-hook status` 读。
//
// 关键约束：
//   D2  只放**进程内存**，不落盘 —— 少一个状态文件少一类 bug。
//   D10 每次注入/跳过都记一行，并计入 status 的计数；否则用户无法判断它在工作。
//   日志本身绝不允许抛错（写日志失败不能影响会话，A1）。
//
// 结果取值（与设计文档 6.2 的 status 文案一一对应）：
//   ok        引擎返回了 findings 并已注入
//   dedup     有 findings，但全部已在本会话注入过（AC5）
//   quota     有 findings，但会话配额（条数/字符）用尽（D9/AC9）
//   timeout   引擎超过 timeoutMs 没返回，本次跳过，不重试（D4）
//   no-engine 三级降级全部失败，静默关闭（AC3）
//   error     引擎进程异常退出或输出无法解析
//   aborted   工具调用被取消（exec.signal），本次跳过（C3）
//   warning   非致命告警（如一级引擎摘要与钉死版本不符），同会话同告警只记一次

/** 默认保留的历史条数。 */
const DEFAULT_LOG_SIZE = 200

/**
 * 归一化一条日志记录，补齐时间戳并只保留已知字段（避免把整份 exec 塞进内存）。
 * @param {object} entry 调用方给的记录。
 * @returns {object} 冻结后的记录。
 */
function freezeEntry(entry) {
  return Object.freeze({
    at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
    result: String(entry.result ?? 'error'),
    file: typeof entry.file === 'string' ? entry.file : undefined,
    tool: typeof entry.tool === 'string' ? entry.tool : undefined,
    /** 引擎报的原始 findings 条数（未去重、未截断）。 */
    findings: Number.isFinite(entry.findings) ? entry.findings : 0,
    /** 实际注入的条数。 */
    injected: Number.isFinite(entry.injected) ? entry.injected : 0,
    /** 实际注入的字符数。 */
    chars: Number.isFinite(entry.chars) ? entry.chars : 0,
    /** 单次耗时（毫秒）。 */
    ms: Number.isFinite(entry.ms) ? entry.ms : 0,
    /** 命中的引擎级别与版本，供 status 排错。 */
    level: typeof entry.level === 'string' ? entry.level : undefined,
    engineVersion: typeof entry.engineVersion === 'string' ? entry.engineVersion : undefined,
    reason: typeof entry.reason === 'string' ? entry.reason : undefined
  })
}

/**
 * 建一个进程内 hook 日志器。
 * @param {{size?: number}} [options] 保留的历史条数上限。
 * @returns {{
 *   record: (entry: object) => object,
 *   warningOnce: (key: string, message: string) => boolean,
 *   count: (key: string) => void,
 *   entries: (limit?: number) => object[],
 *   stats: () => object
 * }} 日志器；所有方法都不会抛错。
 */
export function createHookLog(options = {}) {
  const size = Number.isInteger(options.size) && options.size > 0 ? options.size : DEFAULT_LOG_SIZE
  /** @type {object[]} 只保留最近 size 条（环形用 splice，N 很小，够用）。 */
  const history = []
  /** 同会话同告警只记一次（captain 裁决 m00258 第 1 条：不许刷屏）。 */
  const warned = new Set()
  const counters = {
    /** 引擎被实际调用的次数。 */
    calls: 0,
    /** 成功注入的次数与条数/字符数。 */
    injections: 0,
    findings: 0,
    chars: 0,
    /** 因去重/配额跳过的条数。 */
    dedup: 0,
    quota: 0,
    /** 各类非注入结果的次数。 */
    timeouts: 0,
    noEngine: 0,
    errors: 0,
    aborted: 0,
    /** 因扩展名不在白名单而在调引擎之前就放行的次数（AC8）。 */
    extSkip: 0,
    /** 因写工具本身执行失败（result.isError === true）而在调引擎之前就放行的次数（N3）。 */
    errorSkip: 0
  }
  /** 最近一次结果，status 的「上次结果 ok|timeout|no-engine + 时间」用。 */
  let last

  /**
   * 记一条日志并累加计数。任何异常都被吞掉（写日志不能影响会话）。
   * @param {object} entry 记录。
   * @returns {object} 实际记录（已冻结）。
   */
  function record(entry) {
    let frozen
    try {
      frozen = freezeEntry(entry)
      history.push(frozen)
      if (history.length > size) history.splice(0, history.length - size)
      last = frozen
      switch (frozen.result) {
        case 'ok':
          counters.calls += 1
          // 引擎可能只是 ack（clean/pending），此时没有注入，不算一次注入（D10 计数要能对齐）。
          if (frozen.injected > 0) {
            counters.injections += 1
            counters.findings += frozen.injected
            counters.chars += frozen.chars
          }
          break
        case 'dedup':
          counters.calls += 1
          counters.dedup += frozen.findings
          break
        case 'quota':
          counters.calls += 1
          counters.quota += frozen.findings
          break
        case 'timeout':
          counters.calls += 1
          counters.timeouts += 1
          break
        case 'no-engine':
          counters.noEngine += 1
          break
        case 'aborted':
          counters.aborted += 1
          break
        case 'error':
          counters.calls += 1
          counters.errors += 1
          break
        default:
          break
      }
    } catch {
      frozen = freezeEntry({ result: 'error' })
    }
    return frozen
  }

  /**
   * 记一条「同会话只记一次」的告警。
   * @param {string} key 告警身份（同一条告警复用同一个 key）。
   * @param {string} message 人话原因。
   * @returns {boolean} 本次是否真的记了（false 表示本会话已记过，被抑制）。
   */
  function warningOnce(key, message) {
    try {
      const id = String(key)
      if (warned.has(id)) return false
      warned.add(id)
      record({ result: 'warning', reason: message })
      return true
    } catch {
      return false
    }
  }

  /**
   * 只加计数、不进历史（高频但无信息量的跳过，比如扩展名不在白名单，AC8）。
   * @param {string} key 计数键（必须是 counters 里已存在的键）。
   * @returns {void}
   */
  function count(key) {
    if (Object.hasOwn(counters, key)) counters[key] += 1
  }

  /**
   * 最近的记录（新的在前）。
   * @param {number} [limit] 最多返回多少条，默认全部（最多 size 条）。
   * @returns {object[]} 冻结记录数组。
   */
  function entries(limit) {
    const max = Number.isInteger(limit) && limit > 0 ? limit : history.length
    return history.slice(-max).reverse()
  }

  /**
   * 计数的浅拷贝 + 最近一次结果，供 status 渲染（S5 消费）。
   * @returns {object} 统计快照。
   */
  function stats() {
    return { ...counters, last }
  }

  return { record, warningOnce, count, entries, stats }
}

/** 进程内共享日志器：插件随时可读（S5 的 status/log 命令读它），单例避免多处计数打架。 */
let sharedLog

/**
 * 取（或懒建）进程内共享日志器。
 * @returns {ReturnType<typeof createHookLog>} 共享日志器。
 */
export function getSharedLog() {
  if (sharedLog === undefined) sharedLog = createHookLog()
  return sharedLog
}
