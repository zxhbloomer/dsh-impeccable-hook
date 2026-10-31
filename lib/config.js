// 插件自身的配置：归一化 + 校验。
//
// 设计依据（docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md）：
//   D3  hook 开关写在**插件 config**（cordis.patch.yml 的 config 段），
//       不写用户仓库的 .impeccable/config.json —— 那个文件只读（引擎自己会写，C11）。
//   D4  hook 超时默认 3 秒，超时算「跳过」不算「失败」。
//   D9  注入治理：按 severity 取 top-N（默认 8）+ 全会话配额（默认 40 条 / 12k 字符）。
//   AC8 扩展名白名单：不在名单里的文件，连引擎都不调用。
//
// 本文件不读文件系统、不联网，只做纯函数归一化，方便单测。

/** 插件名：同时是 skill provider 名与宿主命令名的一半（命令名是 `impeccable-hook`）。 */
export const PLUGIN_NAME = 'dsh-impeccable-hook'

/**
 * 上游 CLI-CONTRACT 的 ALLOWED_EXTS：引擎能检测的 UI 源文件扩展名。
 * 名单外（.md / .java / .json …）一律不调用引擎（AC8），保证零开销。
 * @type {readonly string[]}
 */
export const DEFAULT_ALLOWED_EXTS = Object.freeze([
  '.tsx',
  '.jsx',
  '.html',
  '.htm',
  '.vue',
  '.svelte',
  '.astro',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.ts',
  '.js'
])

/**
 * 会把「文件路径」写进工具参数的写类工具名。
 * 只有这些工具才值得看一眼参数：读类工具（read/grep/…）即使带路径也不会触发检测，
 * 避免用一次读取就白跑一遍引擎（A1 不拖慢会话）。
 * @type {RegExp}
 */
export const WRITE_TOOL_PATTERN = /^(edit|write|multi_?edit|apply_patch|patch|create_file|write_file|edit_file|str_replace|replace_in_file|notebook_edit)$/i

/** 配置默认值（一次冻结，任何地方都不许改）。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** design hook 总开关；`/impeccable-hook on|off` 改的就是它（D3）。 */
  enabled: true,
  /** 单次注入最多保留多少条 findings（D9）。 */
  topN: 8,
  /** 全会话最多注入多少条 findings（D9 配额）。 */
  maxFindingsPerSession: 40,
  /** 全会话最多注入多少字符（D9 配额）。 */
  maxCharsPerSession: 12000,
  /** 单次引擎调用超时，毫秒（D4）。 */
  timeoutMs: 3000,
  /** 扩展名白名单（AC8）。 */
  allowedExts: DEFAULT_ALLOWED_EXTS
})

/** 各数值字段允许的取值范围（超出即夹紧，绝不因为一个错配置把 hook 打死）。 */
const NUMERIC_RANGES = Object.freeze({
  topN: [1, 100],
  maxFindingsPerSession: [1, 10000],
  maxCharsPerSession: [500, 200000],
  timeoutMs: [100, 60000]
})

/**
 * 把任意输入夹紧成区间内的整数。
 * @param {unknown} value 原始值。
 * @param {number} fallback 非数字时用的默认值。
 * @param {[number, number]} range 允许区间（闭区间）。
 * @returns {number} 归一化后的整数。
 */
function clampInt(value, fallback, range) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const int = Math.trunc(value)
  if (int < range[0]) return range[0]
  if (int > range[1]) return range[1]
  return int
}

/**
 * 归一化扩展名：补前导点、转小写、去空白。
 * @param {unknown} ext 原始扩展名。
 * @returns {string | undefined} 合法扩展名，否则 undefined。
 */
function normalizeExt(ext) {
  if (typeof ext !== 'string') return undefined
  const trimmed = ext.trim().toLowerCase()
  if (trimmed === '') return undefined
  const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
  return /^\.[a-z0-9]+$/.test(withDot) ? withDot : undefined
}

/**
 * 归一化插件配置。
 * 输入既可以是 cordis.patch.yml 里的 `config:` 段（`{ hook: {...} }`），
 * 也可以直接是扁平的 `{ enabled, topN, ... }`，两者都接受。
 * 未知键忽略；任何非法值退回默认值而不是抛错（hook 必须永远活着，A1）。
 * @param {unknown} raw 原始配置（可空）。
 * @returns {{enabled: boolean, topN: number, maxFindingsPerSession: number, maxCharsPerSession: number, timeoutMs: number, allowedExts: ReadonlySet<string>}} 冻结的归一化配置。
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const section = source.hook !== null && typeof source.hook === 'object' ? source.hook : source

  const exts = Array.isArray(section.allowedExts)
    ? section.allowedExts.map(normalizeExt).filter((ext) => ext !== undefined)
    : []
  const allowedExts = exts.length > 0 ? new Set(exts) : new Set(DEFAULT_ALLOWED_EXTS)

  return Object.freeze({
    // 只有显式 false / 'false' / 0 才算关；其余一律当作开。
    enabled: !(section.enabled === false || section.enabled === 'false' || section.enabled === 0),
    topN: clampInt(section.topN, DEFAULT_CONFIG.topN, NUMERIC_RANGES.topN),
    maxFindingsPerSession: clampInt(
      section.maxFindingsPerSession,
      DEFAULT_CONFIG.maxFindingsPerSession,
      NUMERIC_RANGES.maxFindingsPerSession
    ),
    maxCharsPerSession: clampInt(
      section.maxCharsPerSession,
      DEFAULT_CONFIG.maxCharsPerSession,
      NUMERIC_RANGES.maxCharsPerSession
    ),
    timeoutMs: clampInt(section.timeoutMs, DEFAULT_CONFIG.timeoutMs, NUMERIC_RANGES.timeoutMs),
    allowedExts
  })
}
