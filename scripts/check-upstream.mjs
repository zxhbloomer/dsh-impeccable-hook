#!/usr/bin/env node
// 上游巡检（AC6 / N6）：手动跑，比较「包内快照 / lock / 上游最新」三者版本。
//
// 设计依据（docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md）：
//   N6  v1 **不做**每日 CI 巡检（那个 workflow 在「不创建」清单里，推迟 v1.1）；
//       本脚本是手动入口，配 upstream.lock.json 一起提供可追溯性（G4）。
//   A3  上游升级不静默改行为：这里只**报告**落后，绝不自动改包内快照。
//   AC6  在当前快照下 `node scripts/check-upstream.mjs` 必须 exit 0 并输出「已是最新」。
//
// 退出码恒为 0（巡检只告警不失败）—— 唯一的例外是脚本自身读不出版本这种「配置错误」，
// 那时也只是把 ⚠ 打出来，仍然 exit 0，避免把别人的 CI 拖红。
//
// 用法：
//   node scripts/check-upstream.mjs            仅本地：包内快照 vs lock
//   node scripts/check-upstream.mjs --online    额外问一次 GitHub（只读 raw 文件，8s 超时）

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LOCK_FILE = join(PKG_ROOT, 'upstream.lock.json')
const SNAPSHOT_VERSION = join(PKG_ROOT, 'skills', 'impeccable', 'scripts', 'VERSION')

/** 上游 main 分支上的 skill 版本文件（只读 raw，不碰 API 限额）。 */
const UPSTREAM_VERSION_URL =
  'https://raw.githubusercontent.com/pbakaus/impeccable/main/.dsh/skills/impeccable/scripts/VERSION'

/** 巡检的网络超时（毫秒）。 */
const ONLINE_TIMEOUT_MS = 8000

/**
 * 读一个文本文件，去空白；读不到返回 undefined。
 * @param {string} filePath 文件绝对路径。
 * @returns {Promise<string | undefined>} 内容或 undefined。
 */
async function readText(filePath) {
  try {
    return (await readFile(filePath, 'utf8')).trim()
  } catch {
    return undefined
  }
}

/**
 * 读 lock（解析失败也不抛错）。
 * @returns {Promise<{lock?: object, error?: string}>} lock 内容或错误。
 */
async function readLock() {
  const text = await readText(LOCK_FILE)
  if (text === undefined) return { error: `未找到 ${LOCK_FILE}` }
  try {
    return { lock: JSON.parse(text) }
  } catch (error) {
    return { error: `${LOCK_FILE} 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 比较版本号（只比较主/次/修订，够用来判「落后」）。
 * @param {string} left 左值。
 * @param {string} right 右值。
 * @returns {-1 | 0 | 1} 比较结果。
 */
function compareVersions(left, right) {
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
 * 联网读上游当前 skill 版本；任何网络问题都返回 undefined（巡检不失败）。
 * @returns {Promise<string | undefined>} 上游版本号或 undefined。
 */
async function fetchUpstreamVersion() {
  try {
    const response = await fetch(UPSTREAM_VERSION_URL, {
      signal: AbortSignal.timeout(ONLINE_TIMEOUT_MS),
      headers: { 'user-agent': 'dsh-impeccable-hook/check-upstream' }
    })
    if (!response.ok) return undefined
    const text = (await response.text()).trim()
    return /^\d+\.\d+\.\d+/.test(text) ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * 主流程。
 * @returns {Promise<void>} 无返回值；只打印结论。
 */
async function main() {
  const online = process.argv.includes('--online')
  const { lock, error } = await readLock()
  const snapshot = await readText(SNAPSHOT_VERSION)

  if (error !== undefined) {
    console.log(`[check-upstream] ⚠ ${error} —— 无法判断是否落后（这是打包错误，不是上游问题）。`)
    return
  }

  const lockSkill = typeof lock.skillVersion === 'string' ? lock.skillVersion : undefined
  const lockEngine = typeof lock.engineVersion === 'string' ? lock.engineVersion : undefined
  console.log(`[check-upstream] lock：skill ${lockSkill ?? '未记录'} ｜ engine ${lockEngine ?? '未记录'} ｜ ref ${lock.ref ?? 'main'}`)

  // 1) 本地：包内快照 vs lock
  if (snapshot === undefined) {
    console.log('[check-upstream] ⚠ 包内 skill 快照未落地（skills/impeccable/scripts/VERSION 不存在）。')
    console.log('[check-upstream]   这是 S6 之前的正常状态：先跑 node scripts/sync-upstream.mjs 落地快照，再回来巡检。')
  } else if (lockSkill === undefined) {
    console.log(`[check-upstream] 包内快照：skill ${snapshot}`)
    console.log('[check-upstream] ⚠ lock 缺 skillVersion，无法比对。')
  } else {
    console.log(`[check-upstream] 包内快照：skill ${snapshot}`)
    const local = compareVersions(snapshot, lockSkill)
    if (local === 0) {
      console.log(`[check-upstream] ✓ 已是最新：包内快照 ${snapshot} 与 lock 一致。`)
    } else if (local < 0) {
      console.log(`[check-upstream] ⚠ 包内快照 ${snapshot} 落后于 lock ${lockSkill} —— lock 记的版本没落地，请重跑 sync-upstream.mjs。`)
    } else {
      console.log(`[check-upstream] ⚠ 包内快照 ${snapshot} 领先于 lock ${lockSkill} —— lock 忘了更新。`)
    }
  }

  if (!online) {
    console.log('[check-upstream] （只比了本地。要看上游有没有新版本：node scripts/check-upstream.mjs --online）')
    return
  }

  // 2) 可选：问一次上游（无论本地快照是否落地都问，这样 S6 之前也能发现上游已升级）
  if (lockSkill === undefined) {
    console.log('[check-upstream] ⚠ lock 缺 skillVersion，无法与上游比对。')
    return
  }
  const upstream = await fetchUpstreamVersion()
  if (upstream === undefined) {
    console.log('[check-upstream] ⚠ 联网比对失败（网络不可用或 raw.githubusercontent.com 不可达）—— 已跳过，不影响退出码。')
    return
  }
  const against = compareVersions(upstream, lockSkill)
  if (against === 0) {
    console.log(`[check-upstream] ✓ 上游 main 的 skill 版本 ${upstream} 与 lock 一致，上游没有新版本。`)
  } else if (against > 0) {
    console.log(`[check-upstream] ⚠ 上游 main 已经到 ${upstream}，本包锁的是 ${lockSkill} —— 落后了。`)
    console.log('[check-upstream]   升级方式（不静默改行为，A3）：node scripts/sync-upstream.mjs → 跑测试 → 人工评审 diff → 提交。')
  } else {
    console.log(`[check-upstream] ⚠ 上游 main 是 ${upstream}，本包锁的 ${lockSkill} 反而更新（lock 提前写错了？）。`)
  }
}

await main()
