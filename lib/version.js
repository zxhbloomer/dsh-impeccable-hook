// 版本三件套：包版本、包内 skill 快照版本、出生证明（upstream.lock.json）。
//
// 设计依据（docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md）：
//   G4  版本可追溯：内置快照版本写在 lock 里，上游升级能被发现但不阻断。
//   C10 引擎版本只能读 `scripts/VERSION`，绝不用 `--version`（那返回的是另一套版本号）。
//   D7  引擎版本钉死 lock，保证可复现。
//   §5  本文件「只读文件，不联网」—— 网络比对在 scripts/check-upstream.mjs 里做。
//   R3  与本机已有 skill 冲突时，lock 快照版本与用户装的那份可能不同，status 要并排列出来。
//
// 这里所有函数都不抛错：读不到文件就返回 undefined + error，由调用方决定怎么显示。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readEngineVersion } from './engine.js'

/** 出生证明文件名（仓库根）。 */
export const LOCK_FILE = 'upstream.lock.json'

/** 包内 skill 快照里记录引擎/skill 版本的文件（相对 skill 目录）。 */
const SNAPSHOT_VERSION_FILE = join('scripts', 'VERSION')

/**
 * 比较两个版本号大小的「够用版」实现。
 * 只做 semver 的主/次/修订 + 预发布段比较，够用来判断「lock 是否落后」，
 * 不追求 semver 全语义（R3 只需要「落后/一致/领先」三种结论）。
 * @param {string} left 左值。
 * @param {string} right 右值。
 * @returns {-1 | 0 | 1} 左小于/等于/大于右。
 */
export function compareVersions(left, right) {
  const split = (value) => String(value).split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10))
  const a = split(left)
  const b = split(right)
  for (let index = 0; index < 3; index += 1) {
    const l = Number.isFinite(a[index]) ? a[index] : 0
    const r = Number.isFinite(b[index]) ? b[index] : 0
    if (l < r) return -1
    if (l > r) return 1
  }
  return 0
}

/**
 * 读一个版本文件（UTF-8、去空白），失败返回 undefined。
 * @param {string} filePath 文件绝对路径。
 * @returns {Promise<string | undefined>} 版本号，或 undefined。
 */
async function readVersionFile(filePath) {
  try {
    return await readEngineVersion(filePath)
  } catch {
    return undefined
  }
}

/**
 * 读包的 package.json 版本。
 * @param {string} pkgRoot 包根目录。
 * @returns {Promise<string | undefined>} 版本号，读不到则 undefined。
 */
export async function readPackageVersion(pkgRoot) {
  try {
    const text = await readFile(join(pkgRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(text)
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 读包内 skill 快照的版本（`<skillDir>/scripts/VERSION`，C10）。
 * 快照尚未落地（S6 之前）时返回 undefined，属于正常状态。
 * @param {string} skillDir 包内 skill 目录（`<包根>/skills/impeccable`）。
 * @returns {Promise<string | undefined>} 快照版本，或 undefined。
 */
export async function readSnapshotVersion(skillDir) {
  return readVersionFile(join(skillDir, SNAPSHOT_VERSION_FILE))
}

/**
 * 读出生证明（upstream.lock.json）。
 * 结构不完整（缺 skillVersion / engineVersion）也照样返回，由 drift 逻辑报 unknown，
 * 这样「lock 被手改成半截」不会让 status 崩掉。
 * @param {string} pkgRoot 包根目录。
 * @returns {Promise<{lock?: object, error?: string}>} lock 内容或错误原因。
 */
export async function readLock(pkgRoot) {
  const filePath = join(pkgRoot, LOCK_FILE)
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return { error: `未找到 ${LOCK_FILE}（包内缺失，属于打包错误）` }
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') {
      return { error: `${LOCK_FILE} 不是 JSON 对象` }
    }
    return { lock: parsed }
  } catch (error) {
    return { error: `${LOCK_FILE} 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 比较「快照 / 引擎」两个版本，产出人能读懂的一句话 + 机器可判的状态。
 * @param {string | undefined} actual 实际版本（本机/快照）。
 * @param {string | undefined} pinned 钉死版本（lock）。
 * @returns {{state: 'match' | 'behind' | 'ahead' | 'unknown', text: string}} 漂移结论。
 */
function driftOf(actual, pinned) {
  const hasActual = typeof actual === 'string' && actual.length > 0
  const hasPinned = typeof pinned === 'string' && pinned.length > 0
  if (!hasActual || !hasPinned) {
    return {
      state: 'unknown',
      text: `无法比对（实际 ${hasActual ? actual : '未落地'} / 钉死 ${hasPinned ? pinned : '未知'}）`,
    }
  }
  const compared = compareVersions(actual, pinned)
  if (compared === 0) return { state: 'match', text: `一致（${actual}）` }
  if (compared < 0) return { state: 'behind', text: `快照 ${actual} 落后于 lock ${pinned}（该跑 scripts/sync-upstream.mjs）` }
  return { state: 'ahead', text: `快照 ${actual} 领先于 lock ${pinned}（lock 忘了更新）` }
}

/**
 * 汇总三处版本事实，供 `/impeccable-hook status` 直接打印。
 * @param {{pkgRoot: string, skillDir: string, engineVersion?: string}} options 三处事实的来源。
 * @returns {Promise<{
 *   packageVersion?: string,
 *   snapshotVersion?: string,
 *   engineVersion?: string,
 *   lock?: object,
 *   lockError?: string,
 *   skill: {state: string, text: string},
 *   engine: {state: string, text: string},
 *   upstream: {state: string, text: string},
 *   lines: string[]
 * }>} 版本报告。
 */
export async function buildVersionReport(options) {
  const { pkgRoot, skillDir, engineVersion } = options
  const packageVersion = await readPackageVersion(pkgRoot)
  const snapshotVersion = await readSnapshotVersion(skillDir)
  const { lock, error: lockError } = await readLock(pkgRoot)

  const lockSkill = typeof lock?.skillVersion === 'string' ? lock.skillVersion : undefined
  const lockEngine = typeof lock?.engineVersion === 'string' ? lock.engineVersion : undefined

  const skill = driftOf(snapshotVersion, lockSkill)
  // 引擎版本拿不到时不能谎称「与钉死一致」——如实说没探测到。
  const engine =
    typeof engineVersion === 'string' && engineVersion.length > 0
      ? driftOf(engineVersion, lockEngine)
      : { state: 'unknown', text: `未探测到本机引擎${lockEngine === undefined ? '' : `（lock 钉死 ${lockEngine}）`}` }
  // 上游是否落后：lock 自己说不上来，只能由 scripts/check-upstream.mjs 联网确认（本文件不联网）。
  const upstream = {
    state: 'unknown',
    text: '需联网比对：node scripts/check-upstream.mjs（本命令不联网）'
  }

  const lines = [
    `插件版本     ${packageVersion ?? '未知'}`,
    `内置快照     ${snapshotVersion ?? '未落地（skills/impeccable 尚未同步）'}${lockSkill === undefined ? '' : ` ｜ lock 钉死 ${lockSkill}`}`,
    `快照漂移     ${skill.text}`,
    engine.state === 'unknown'
      ? `引擎版本     ${engine.text}`
      : `引擎版本     ${engineVersion}${lockEngine === undefined ? '' : ` ｜ lock 钉死 ${lockEngine}`} ｜ ${engine.text}`
  ]
  if (lockError !== undefined) lines.push(`出生证明     ${lockError}`)
  else if (typeof lock?.fetchedAt === 'string') {
    lines.push(`出生证明     ${lock?.repo ?? 'upstream'} @ ${lock?.ref ?? 'main'} ｜ 抓取于 ${lock.fetchedAt}`)
  }
  lines.push(`上游巡检     ${upstream.text}`)

  return {
    packageVersion,
    snapshotVersion,
    engineVersion,
    lock,
    ...(lockError === undefined ? {} : { lockError }),
    skill,
    engine,
    upstream,
    lines
  }
}
