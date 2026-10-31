#!/usr/bin/env node
// 从上游同步 impeccable skill 快照（S6 的落盘工具，手动跑，不进 CI）。
//
// 设计依据（docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md）：
//   G4/D7 版本可追溯：同步后把上游 commit、两个版本号、tarball sha256 写进 upstream.lock.json。
//           tarball 一律从 **commit URL** 下载（钉 commit 不钉分支）：refs/heads/main 会移动，
//           分支快照的哈希明天就复算不出来，commit 快照的哈希永远可复算（锁住出生证明）。
//   N4/D6 不改 skill 正文，只重写**脚本路径前缀**；每处改动逐条记进 MODIFICATIONS.md。
//   C8    只走 GitHub 安装：仓库里存的是已构建好的快照，所以本脚本是「开发者工具」，不是安装步骤。
//   R4    同步后 `git diff` 必须为空 —— 快照必须可复现，否则没人能评审上游变化。
//   A3    不静默改行为：本脚本只覆盖文件，是否接受改动由人评审 diff 决定。
//
// 用法：
//   node scripts/sync-upstream.mjs               从 main 同步并写文件
//   node scripts/sync-upstream.mjs --ref <ref>   指定 ref（分支/标签）
//   node scripts/sync-upstream.mjs --dry-run     只下载 + 校验 + 打印计划，不落盘
//   node scripts/sync-upstream.mjs --assert-clean  同步后要求 git diff 为空，否则 exit 1（R4）
//
// 只依赖 Node 内置能力（fetch + zlib + tar 头解析），不引第三方包（D8）。

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = join(PKG_ROOT, 'skills', 'impeccable')
const LOCK_FILE = join(PKG_ROOT, 'upstream.lock.json')

/** 上游仓库与快照在仓库里的路径。 */
const UPSTREAM_REPO = 'pbakaus/impeccable'
const UPSTREAM_SOURCE_PATH = '.dsh/skills/impeccable'

/** 网络超时（毫秒）：tarball 几 MB，给足 60s。 */
const FETCH_TIMEOUT_MS = 60000

/** 同步必须存在的关键文件（R4：上游大改导致错位时要立刻炸）。 */
const REQUIRED_FILES = Object.freeze(['SKILL.md', 'scripts/VERSION', 'scripts/engine-checksums.txt'])

/**
 * 脚本路径前缀重写表（D6）。
 * 上游把 skill 目录写成「用户级安装路径」的地方，本包要改成「skill 自身的相对基址」，
 * 否则装到别处就会去调一个不存在的 launcher（C13 那个「引擎静默 exit 0」的坑）。
 * @type {ReadonlyArray<{id: string, pattern: RegExp, replacement: string}>}
 */
const REWRITES = Object.freeze([
  {
    id: 'dsh-home-scripts',
    pattern: /\$DSH_HOME[\\/]+skills[\\/]+impeccable[\\/]+scripts/g,
    replacement: '<skill-base-dir>/scripts'
  },
  {
    id: 'relative-dsh-scripts',
    pattern: /\.dsh[\\/]+skills[\\/]+impeccable[\\/]+scripts/g,
    replacement: '<skill-base-dir>/scripts'
  }
])

/** 会被重写扫描的文本扩展名（二进制/字体/图片一律不碰）。 */
const TEXT_EXTENSIONS = new Set(['.md', '.json', '.js', '.cjs', '.mjs', '.txt', '.cmd', '.sh', '.yml', '.yaml'])

/**
 * 就读一个 tar 头里的字符串（NUL 截断）。
 * @param {Buffer} buffer 整个 tar。
 * @param {number} offset 字段起点。
 * @param {number} length 字段长度。
 * @returns {string} 去 NUL 的文本。
 */
function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

/**
 * 解析未压缩 tar，返回文件条目（忽略 pax 扩展头与目录项）。
 * @param {Buffer} buffer tar 字节。
 * @returns {Array<{name: string, data: Buffer}>} 文件条目。
 */
function parseTar(buffer) {
  const entries = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const sizeText = readString(header, 124, 12).trim()
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8)
    const type = String.fromCharCode(header[156])
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const dataStart = offset + 512
    // type '0'/NUL 是普通文件；'x'/'g' 是 pax 扩展头，'5' 是目录，其余（符号链接等）跳过。
    if (type === '0' || type === '\u0000') {
      entries.push({ name: fullName, data: buffer.subarray(dataStart, dataStart + size) })
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

/**
 * 下载并解包上游 tarball，只留下 skill 目录下的文件。
 * URL 用 **commit**（`tar.gz/<commit>`）而不是分支（`tar.gz/refs/heads/<ref>`）：
 * 分支会移动，分支快照的 sha256 事后无法复算；commit 快照的 sha256 永远可复算（G4）。
 * @param {string} commit 上游 commit sha（不可变的下载目标）。
 * @returns {Promise<{files: Map<string, Buffer>, tarballSha256: string, tarballSource: string}>} 相对路径 → 内容。
 */
async function downloadSkillTree(commit) {
  const url = `https://codeload.github.com/${UPSTREAM_REPO}/tar.gz/${commit}`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': 'dsh-impeccable-hook/sync-upstream' }
  })
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${url}`)
  const tarball = Buffer.from(await response.arrayBuffer())
  const tarballSha256 = createHash('sha256').update(tarball).digest('hex')
  const entries = parseTar(gunzipSync(tarball))

  const files = new Map()
  let root
  let rootPackage
  for (const entry of entries) {
    if (root === undefined) {
      const slash = entry.name.indexOf('/')
      if (slash > 0) root = entry.name.slice(0, slash)
    }
    if (root === undefined) continue
    if (entry.name === `${root}/package.json`) {
      try {
        rootPackage = JSON.parse(entry.data.toString('utf8'))
      } catch {
        rootPackage = undefined
      }
      continue
    }
    const marker = `${root}/${UPSTREAM_SOURCE_PATH}/`
    if (!entry.name.startsWith(marker)) continue
    files.set(entry.name.slice(marker.length), entry.data)
  }
  if (files.size === 0) throw new Error(`tarball 里找不到 ${UPSTREAM_SOURCE_PATH}/（上游目录结构变了？R4）`)
  for (const required of REQUIRED_FILES) {
    if (!files.has(required)) throw new Error(`上游缺少关键文件 ${required}（R4：先人工确认上游结构再改脚本）`)
  }
  return { files, tarballSha256, tarballSource: url, rootPackage }
}

/**
 * 解析 `git ls-remote` 输出里的 ref sha（第二道兜底，不受 REST API 配额限制）。
 * @param {string} out ls-remote 的 stdout。
 * @param {string} ref 分支。
 * @returns {string | undefined} commit sha 或 undefined。
 */
function parseRemoteRef(out, ref) {
  for (const line of out.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/)
    if (name === `refs/heads/${ref}` && /^[0-9a-f]{40}$/.test(sha ?? '')) return sha
  }
  return undefined
}

/**
 * 读上游 commit sha（只用于 lock 的可追溯性；拿不到不致命）。
 * 先问 REST API，被限流（GitHub 未认证 60 次/小时，实测会 403）时退回 `git ls-remote`。
 * @param {string} ref 分支。
 * @returns {Promise<string | undefined>} commit sha 或 undefined。
 */
async function fetchCommit(ref) {
  try {
    const response = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/commits/${ref}`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'dsh-impeccable-hook/sync-upstream', accept: 'application/vnd.github+json' }
    })
    if (response.ok) {
      const payload = await response.json()
      if (typeof payload?.sha === 'string') return payload.sha
    }
  } catch {
    // 网络问题，落到下面的兜底。
  }
  const remote = spawnSync('git', ['ls-remote', `https://github.com/${UPSTREAM_REPO}.git`, `refs/heads/${ref}`], {
    encoding: 'utf8',
    timeout: 30000
  })
  return remote.status === 0 ? parseRemoteRef(remote.stdout ?? '', ref) : undefined
}

/**
 * 按重写表处理一份文本，返回新内容与替换次数。
 * @param {string} text 原文。
 * @returns {{text: string, counts: Record<string, number>}} 新文本与每张表的命中数。
 */
function rewriteText(text) {
  let output = text
  const counts = {}
  for (const rule of REWRITES) {
    let hits = 0
    output = output.replace(rule.pattern, () => {
      hits += 1
      return rule.replacement
    })
    if (hits > 0) counts[rule.id] = hits
  }
  return { text: output, counts }
}

/**
 * 把 skill 树写到仓库（先清空目标目录，避免上游删掉的文件残留）。
 * @param {Map<string, Buffer>} files 相对路径 → 内容。
 * @param {boolean} dryRun 只统计不落盘。
 * @returns {Promise<Record<string, number>>} 每条重写规则的命中总数。
 */
async function writeTree(files, dryRun) {
  const totals = {}
  if (!dryRun) {
    await rm(SKILL_DIR, { recursive: true, force: true })
    await mkdir(SKILL_DIR, { recursive: true })
  }
  for (const [relative, data] of files) {
    const lower = relative.toLowerCase()
    const dot = lower.lastIndexOf('.')
    const extension = dot === -1 ? '' : lower.slice(dot)
    let payload = data
    if (TEXT_EXTENSIONS.has(extension)) {
      const { text, counts } = rewriteText(data.toString('utf8'))
      for (const [id, hits] of Object.entries(counts)) totals[id] = (totals[id] ?? 0) + hits
      payload = Buffer.from(text, 'utf8')
    }
    if (dryRun) continue
    const target = join(SKILL_DIR, ...relative.split(posix.sep))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, payload)
  }
  return totals
}

/**
 * 读快照里的版本文件（C10：引擎版本只认这个文件）。
 * @returns {Promise<string | undefined>} 版本号。
 */
async function readSnapshotVersion() {
  try {
    return (await readFile(join(SKILL_DIR, 'scripts', 'VERSION'), 'utf8')).trim()
  } catch {
    return undefined
  }
}

/**
 * 写 MODIFICATIONS.md：逐条记录本包对上游快照做过的改动（N4/评审意见 8 要求）。
 * 重写规则按 REWRITES 全量列出（命中 0 处也照实写 0 处），让清单与脚本永远一一对应。
 * @param {{rewrites: Record<string, number>, commit?: string, tarballSha256: string, tarballSource: string, ref: string}} facts 事实。
 * @returns {Promise<void>} 无返回值。
 */
async function writeModifications(facts) {
  const { rewrites, commit, tarballSha256, tarballSource, ref } = facts
  const lines = [
    '# MODIFICATIONS.md —— 本包对上游 impeccable skill 快照做过的改动',
    '',
    '上游：' + UPSTREAM_REPO + `（Apache-2.0，ref=${ref}，commit=${commit ?? '未取得'}）`,
    `tarball sha256：\`${tarballSha256}\``,
    `tarball 来源（钉 commit 不钉分支）：\`${tarballSource}\``,
    '同步工具：`node scripts/sync-upstream.mjs`（只改写脚本路径前缀，不改正文，D6）',
    '',
    '## 路径重写（逐条）',
    ''
  ]
  // 全量列 REWRITES（不是只列命中的）：清单与 sync 脚本必须一一对应，命中 0 处也照实写。
  for (const rule of REWRITES) {
    const hits = rewrites[rule.id] ?? 0
    lines.push(`- \`${rule.id}\`：${hits} 处 → 改为 \`${rule.replacement}\``)
  }
  const total = Object.values(rewrites).reduce((sum, hits) => sum + hits, 0)
  if (total === 0) {
    lines.push('', '本次同步 0 处命中：上游正文里已经是 `<skill-base-dir>/scripts` 形式，无需改写。')
  }
  lines.push('', '## 未改动', '', '- reference/ 正文、command-metadata.json、engine-checksums.txt 一律原样保留。')
  lines.push('- 引擎二进制不入库（G5/C8）：安装时按 engine-checksums.txt 校验后下载。')
  await writeFile(join(SKILL_DIR, 'MODIFICATIONS.md'), `${lines.join('\n')}\n`, 'utf8')
}

/**
 * 跑一次 git 检查（仓库可能还没 init，失败不算错）。
 * @param {string[]} args git 参数。
 * @returns {{ok: boolean, out: string}} 结果。
 */
function git(args) {
  const result = spawnSync('git', ['-C', PKG_ROOT, ...args], { encoding: 'utf8' })
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

/**
 * 主流程。
 * @returns {Promise<number>} 退出码。
 */
async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const assertClean = args.includes('--assert-clean')
  const refIndex = args.indexOf('--ref')
  const ref = refIndex !== -1 && typeof args[refIndex + 1] === 'string' ? args[refIndex + 1] : 'main'

  console.log(`[sync-upstream] 从 ${UPSTREAM_REPO}@${ref} 同步 ${UPSTREAM_SOURCE_PATH} → ${SKILL_DIR}`)

  // 先解出 commit 再下载：tarball 必须钉在不可变对象上，否则 lock 里的 sha256 事后复算不出来（G4/R2-2）。
  const commit = await fetchCommit(ref)
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(
      `拿不到 ${ref} 的 commit sha，无法把 tarball 钉到不可变对象上（G4）。` +
        '拒绝用分支快照入库——那样 lock 里的 tarballSha256 会随上游推进而失效。请检查网络（或 git ls-remote）后重试。'
    )
  }
  const { files, tarballSha256, tarballSource, rootPackage } = await downloadSkillTree(commit)
  console.log(`[sync-upstream] commit=${commit}`)
  console.log(`[sync-upstream] 拿到 ${files.size} 个文件，tarball ${tarballSource} sha256=${tarballSha256}`)

  const rewrites = await writeTree(files, dryRun)
  const rewriteTotal = Object.values(rewrites).reduce((sum, hits) => sum + hits, 0)
  console.log(`[sync-upstream] 脚本路径重写：${rewriteTotal} 处${rewriteTotal === 0 ? '（上游已是 <skill-base-dir> 形式）' : ''}`)

  const skillVersion = dryRun ? undefined : await readSnapshotVersion()
  const cliVersion = typeof rootPackage?.version === 'string' ? rootPackage.version : undefined

  if (dryRun) {
    console.log('[sync-upstream] --dry-run：没有写任何文件。')
    return 0
  }

  await writeModifications({ rewrites, commit, tarballSha256, tarballSource, ref })

  const lock = {
    $comment:
      '出生证明（G4/D7）：记录包内 skill 快照来自上游哪个 commit、两个版本号。由 scripts/sync-upstream.mjs 写入，不要手改。' +
      'tarballSha256 对应 tarballSource 里的 commit 快照（钉 commit 不钉分支），因此可随时复算校验。',
    schemaVersion: 1,
    repo: UPSTREAM_REPO,
    repoUrl: `https://github.com/${UPSTREAM_REPO}`,
    ref,
    commit: commit ?? null,
    fetchedAt: new Date().toISOString(),
    skillVersion: skillVersion ?? null,
    engineVersion: skillVersion ?? null,
    cliVersion: cliVersion ?? null,
    sourcePath: UPSTREAM_SOURCE_PATH,
    snapshotPath: 'skills/impeccable',
    checksumsFile: 'scripts/engine-checksums.txt',
    tarballSha256,
    // 钉 commit 不钉分支：URL 是 .../tar.gz/<commit>，所以 tarballSha256 永远可复算（G4）。
    tarballSource
  }
  await writeFile(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
  console.log(`[sync-upstream] 已写 upstream.lock.json（skill=${lock.skillVersion} engine=${lock.engineVersion} commit=${String(lock.commit).slice(0, 12)}）`)

  // R4：同步必须可复现 —— 快照与 lock 都进了版本控制，diff 为空才说明「这次同步没夹带意外」。
  const status = git(['status', '--porcelain', '--', 'skills', 'upstream.lock.json'])
  if (!status.ok) {
    console.log('[sync-upstream] ⚠ 本仓库还不是 git 仓库（或 git 不可用），跳过 git diff 检查。')
    return 0
  }
  if (status.out === '') {
    console.log('[sync-upstream] ✓ 快照与 lock 完全复现：git diff 为空。')
    return 0
  }
  console.log('[sync-upstream] ⚠ 有未提交差异（首次落地或版本变化属正常）：')
  console.log(status.out)
  console.log('[sync-upstream]   请人工评审 diff 后提交；加 --assert-clean 可把这种情况变成失败。')
  return assertClean ? 1 : 0
}

const code = await main().catch((error) => {
  console.error(`[sync-upstream] ✗ 失败：${error instanceof Error ? error.message : String(error)}`)
  return 1
})
process.exit(code)
