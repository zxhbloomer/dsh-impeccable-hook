// lib/engine.js —— impeccable 引擎定位与降级（设计文档 §4.2「三级链」）
//
// 契约要点（逐条对应设计文档）：
//   · C10：引擎版本只能读脚本目录下的 VERSION 文件；`--version` 返回的是 skill 版本，
//     绝不能用它判断引擎版本。
//   · C9：Windows 必须交出真实 win32 绝对路径（盘符 + 反斜杠），POSIX 风格路径会让
//     引擎 hook 静默 exit 0，所以本模块统一用 toNativePath()/isNativeAbsolutePath() 把关。
//   · D12：hook 热路径只定位、绝不下载 —— locateEngine() 永不联网；下载只在显式动作里发生
//     （resolveEngine({ allowDownload: true })），流程必须是「写临时文件 → 校验 sha256 → 原子 rename」。
//   · AC3：三级全失败不抛错、不做任何副作用，返回 { available: false, reason } 让 status 说明原因。
//   · AC4：默认 digest 校验带进程内摘要缓存（同 size+mtime 不重复哈希），单次定位仍在毫秒级。
//   · A3：引擎与钉死版本不一致时不静默 —— 记为 warning 并写日志，status 可见。
//
// 三级顺序（与上游 launcher / npm shim 的语义保持同构，便于共享 ~/.impeccable 缓存）：
//   ① 用户级已装 $DSH_HOME/skills/impeccable/scripts/bin/<os>-<arch>/impeccable[.exe]
//   ② ~/.impeccable/bin/<engineVersion>/impeccable[.exe]（上游版本化缓存位）
//   ③ 官方 Release 下载并按 engine-checksums.txt 校验 sha256（仅 allowDownload 时）
// 注：v0.1 设想的「插件内自带 bin」已按评审意见 5 删除 —— 仓库提交 20MB 二进制既违背 G5/C8
// （GitHub 安装、纯 JS 入库），也没法跨平台，故不作为一级。

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本包根目录（lib/ 的上一级）：包内 skill 快照的 VERSION 与 checksums 都在其下。 */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 给 status 输出用的中文级别名（键顺序即三级优先级，与 resolveEngine 的调用顺序一致）。 */
export const LEVEL_LABEL = Object.freeze({
  'user-skill': '①用户级已装 skill 的引擎',
  'user-cache': '②~/.impeccable 版本缓存',
  download: '③官方 Release 下载',
});

/** 官方 Release 通道（上游同样支持 IMPECCABLE_DOWNLOAD_BASE 覆盖，测试可注入本地 fixture）。 */
export const DEFAULT_DOWNLOAD_BASE = 'https://github.com/pbakaus/impeccable/releases/download';

const OS_NAMES = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const ARCH_NAMES = { arm64: 'arm64', x64: 'x64' };
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

// ─────────────────────────── 平台 / 路径工具 ───────────────────────────

/**
 * 进程内摘要缓存：key = 绝对路径 + size + mtimeMs。
 * AC4 要求单次 hook <200ms，而引擎约 20MB，重复哈希会吃掉预算，
 * 所以同一进程里同一份二进制只哈希一次；文件被替换（size/mtime 变化）时自动失效。
 */
const digestMemo = new Map();

/** 计算平台资产三元组：`windows-x64` / `impeccable-windows-x64.exe` / `impeccable.exe`。 */
export function platformTarget({ platform = process.platform, arch = process.arch } = {}) {
  const osName = OS_NAMES[platform] || platform;
  const archName = ARCH_NAMES[arch] || arch;
  const exe = osName === 'windows' ? 'impeccable.exe' : 'impeccable';
  const target = `${osName}-${archName}`;
  const asset = `impeccable-${target}${osName === 'windows' ? '.exe' : ''}`;
  return { os: osName, arch: archName, target, exe, asset };
}

/**
 * 转成目标平台的原生路径写法（C9）。Windows 下把 `/` 全部换成 `\`，
 * 因为引擎 hook 收到 `D:/a/b` 这类路径时会静默 exit 0，排查成本极高。
 */
export function toNativePath(p, platform = process.platform) {
  if (typeof p !== 'string' || p === '') return p;
  return platform === 'win32' ? p.replace(/\//g, '\\') : p;
}

/** 判断是否目标平台的绝对路径（C9 的第二道闸）。 */
export function isNativeAbsolutePath(p, platform = process.platform) {
  if (typeof p !== 'string' || p === '') return false;
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p);
  return p.startsWith('/');
}

// ───────────────────────────── 版本与清单 ─────────────────────────────

/**
 * 读引擎版本（C10）。只认 VERSION 文件内容，且必须是 0.1.18 这种三段式版本，
 * 防止把空文件、注释或 skill 版本误当引擎版本。读不到返回 null。
 */
export function readEngineVersion(versionFile) {
  try {
    const raw = fs.readFileSync(versionFile, 'utf8').trim();
    return VERSION_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 解析 engine-checksums.txt。格式为「<version> <asset> <sha256>」，
 * `#` 开头为注释；上游写入时是 LF，但 CRLF 检出也要能用（上游 launcher 同样容忍）。
 * 返回 Map：`${version}\u0000${asset}` → sha256（小写）。
 */
export function parseChecksums(text) {
  const out = new Map();
  if (typeof text !== 'string' || text === '') return out;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [version, asset, sum] = trimmed.split(/\s+/);
    const digest = (sum || '').toLowerCase();
    if (!version || !asset || !SHA256_RE.test(digest)) continue;
    out.set(`${version}\u0000${asset}`, digest);
  }
  return out;
}

/**
 * 取某个 (version, asset) 在清单里的摘要；没有就返回空数组（fail closed）。
 * 只认本平台自己的资产：上游没有发布 Windows-on-ARM 版引擎，
 * 所以这里不再「拿 x64 摘要顶替」——那种推测会让 arm64 机器上跑着 x64 二进制却报「校验通过」。
 */
export function expectedDigests(checksums, version, asset) {
  const own = checksums.get(`${version}\u0000${asset}`);
  return own ? [own] : [];
}

// ───────────────────────────── 选项与路径 ─────────────────────────────

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function isFile(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 合并默认值；所有外部输入都可注入（测试与 status 复用同一套语义）。 */
export function normalizeOptions(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pkgRoot = options.pkgRoot ?? PKG_ROOT;
  const skillDir = options.skillDir ?? path.join(pkgRoot, 'skills', 'impeccable');
  const scriptsDir = options.scriptsDir ?? path.join(skillDir, 'scripts');
  return {
    platform,
    arch,
    pkgRoot,
    skillDir,
    scriptsDir,
    versionFile: options.versionFile ?? path.join(scriptsDir, 'VERSION'),
    checksumsFile: options.checksumsFile ?? path.join(scriptsDir, 'engine-checksums.txt'),
    dshHome: options.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    impeccableHome:
      options.impeccableHome ?? process.env.IMPECCABLE_HOME ?? path.join(os.homedir(), '.impeccable'),
    downloadBase: options.downloadBase ?? process.env.IMPECCABLE_DOWNLOAD_BASE ?? DEFAULT_DOWNLOAD_BASE,
    allowDownload: options.allowDownload === true,
    downloadTimeoutMs: options.downloadTimeoutMs ?? 180000,
    signal: options.signal,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    log: typeof options.log === 'function' ? options.log : () => {},
  };
}

/**
 * 算出本机所有候选位置与清单信息，不做任何 IO 决策（status 直接展示这一组路径）。
 * 注意 userCacheBin/url 依赖引擎版本，读不到 VERSION 时为 null。
 */
export function enginePaths(options = {}) {
  const cfg = normalizeOptions(options);
  const target = platformTarget({ platform: cfg.platform, arch: cfg.arch });
  const engineVersion = readEngineVersion(cfg.versionFile);
  const checksums = parseChecksums(readTextFile(cfg.checksumsFile));
  const base = String(cfg.downloadBase || '').replace(/\/+$/, '');
  return {
    ...cfg,
    ...target,
    engineVersion,
    checksums,
    digests: engineVersion ? expectedDigests(checksums, engineVersion, target.asset) : [],
    userSkillBin: path.join(cfg.dshHome, 'skills', 'impeccable', 'scripts', 'bin', target.target, target.exe),
    userCacheBin: engineVersion ? path.join(cfg.impeccableHome, 'bin', engineVersion, target.exe) : null,
    url: engineVersion ? `${base}/engine-v${engineVersion}/${target.asset}` : null,
  };
}

// ────────────────────────────── 校验工具 ──────────────────────────────

/** 流式 sha256，避免把 20MB 一次性读进内存。 */
function hashFile(file) {
  return new Promise((resolve) => {
    let hash;
    try {
      hash = createHash('sha256');
    } catch {
      return resolve(null);
    }
    const stream = fs.createReadStream(file);
    stream.on('error', () => resolve(null));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 带进程内缓存的摘要计算（AC4）。 */
async function digestOf(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${file}\u0000${stat.size}\u0000${stat.mtimeMs}`;
  const cached = digestMemo.get(key);
  if (cached) return cached;
  const digest = await hashFile(file);
  if (digest) digestMemo.set(key, digest);
  return digest;
}

/**
 * engine-probe 握手：上游 launcher 用它确认某个候选确实是引擎（打印
 * "impeccable-engine <version>"），而不是 3.x 时代那个同名的旧 CLI。
 * 这不是 `--version`（C10）：`--version` 返回的是 skill 版本，探针输出的是引擎版本。
 * 只用在一处 —— `status` 的深度体检（commands.js 的 describeProbe → probeEngineVersion）；
 * hook 热路径不调它，免得为一次体检把 200ms 预算（AC4）吃掉。
 *
 * probeArgs / spawnImpl 只为跨平台单测预留：Windows 上可以用
 * `probeEngineVersion(process.execPath, { probeArgs: ['-e', '...'] })` 造一个真实可执行的假引擎，
 * 不必依赖 POSIX shell 夹具（t6 要求不留长期 skip）。
 */
export function probeEngineVersion(
  binPath,
  { signal, timeoutMs = 3000, probeArgs = ['engine-probe'], spawnImpl = spawn } = {},
) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl(binPath, probeArgs, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish(null);
    }, timeoutMs);
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish(null);
    };
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let out = '';
    child.stdout?.on('data', (chunk) => {
      if (out.length < 4096) out += String(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      const match = /impeccable-engine\s+(\S+)/.exec(out.trim());
      finish(match ? match[1] : null);
    });
  });
}

/**
 * 校验一个候选二进制。
 * 返回 { verified: true|false|null, reason, fatal }：
 *   · verified=null  = 没有可对照的摘要（清单未收录 / 读不动），按存在性使用；
 *   · verified=false + fatal=true  = 摘要与清单不一致，且该级别属于「我们自己维护的缓存」，
 *     视为被改动，跳过该级别（上游 launcher 对版本化缓存也是这个态度）；
 *   · verified=false + fatal=false = 用户自己装的引擎与钉死版本不一致，仍可用但要留 warning（A3）。
 */
async function verifyCandidate(binPath, cfg, paths, { fatalOnMismatch }) {
  const digests = paths.digests || [];
  if (digests.length === 0) {
    return {
      verified: null,
      reason:
        `清单 ${path.basename(paths.checksumsFile)} 未收录 ${paths.engineVersion ?? '(无版本)'} ${paths.asset}` +
        (paths.target === 'windows-arm64' ? '（上游未发布 windows-arm64 资产）' : ''),
      fatal: false,
    };
  }
  const actual = await digestOf(binPath);
  if (!actual) {
    return { verified: null, reason: '二进制不可读，未做摘要校验', fatal: false };
  }
  if (digests.includes(actual)) {
    return {
      verified: true,
      reason: `sha256 与清单一致（${actual.slice(0, 12)}…）`,
      fatal: false,
    };
  }
  const short = `${actual.slice(0, 12)}… ≠ ${digests[0].slice(0, 12)}…`;
  if (fatalOnMismatch) {
    return {
      verified: false,
      reason: `缓存二进制 sha256 ${short}，疑似被改动，忽略该缓存`,
      fatal: true,
    };
  }
  return {
    verified: false,
    reason: `sha256 ${short}，与钉死引擎版本不一致（可能用户装了更新的 skill），仍按存在性使用`,
    fatal: false,
  };
}

// ────────────────────────────── 主流程 ──────────────────────────────

function attemptEntry(level, binPath, platform, extra) {
  return {
    level,
    label: LEVEL_LABEL[level],
    path: binPath ? toNativePath(binPath, platform) : null,
    ok: false,
    verified: null,
    reason: '',
    ...extra,
  };
}

/**
 * 命中结果（三级共用一套字段，命令层直接渲染，不再各写一遍）。
 * @param {object} cfg normalizeOptions 的结果。
 * @param {object} paths enginePaths 的结果。
 * @param {{level: string, binPath: string, verified: boolean|null, verifyReason: string, warning?: string|null, reason: string, attempts: object[]}} hit 命中细节。
 * @returns {object} 统一的 resolution。
 */
function availableResult(cfg, paths, hit) {
  const nativePath = toNativePath(hit.binPath, cfg.platform)
  return {
    available: true,
    level: hit.level,
    label: LEVEL_LABEL[hit.level],
    path: nativePath,
    engineVersion: paths.engineVersion,
    verified: hit.verified,
    verifyReason: hit.verifyReason,
    warning: hit.warning === undefined ? (hit.verified === false ? hit.verifyReason : null) : hit.warning,
    target: paths.target,
    asset: paths.asset,
    url: paths.url,
    reason: hit.reason ?? `${LEVEL_LABEL[hit.level]}命中：${nativePath}`,
    attempts: hit.attempts,
  }
}

/**
 * 未命中结果（取消 / 热路径不下载 / 三级全失败 三种出口共用）。
 * @param {object} paths enginePaths 的结果。
 * @param {string} reason 给人看的中文原因。
 * @param {object[]} attempts 逐级尝试记录。
 * @returns {object} 统一的 resolution。
 */
function unavailableResult(paths, reason, attempts) {
  return {
    available: false,
    level: null,
    label: null,
    path: null,
    engineVersion: paths.engineVersion,
    verified: null,
    verifyReason: '',
    warning: null,
    target: paths.target,
    asset: paths.asset,
    url: paths.url,
    reason,
    attempts,
  }
}

/** 把逐级 attempts 拼成一行，供失败原因复用。 */
function describeAttempts(attempts) {
  return attempts.map((a) => `${a.label} — ${a.reason}`).join(' ')
}

/**
 * 依次尝试某个级别；命中返回 resolution，未命中返回 null（并写入 attempts）。
 * levelPath 为 null 表示该级别在当前环境下不可用（例如读不到版本号的缓存位）。
 */
async function tryLevel(level, levelPath, cfg, paths, attempts, { fatalOnMismatch }) {
  // 引擎候选必须是原生绝对路径（C9），否则在 Windows 上 hook 会静默失败。
  const platform = cfg.platform;
  if (!levelPath) {
    attempts.push(
      attemptEntry(level, null, platform, {
        reason: `无法定位：未读到引擎版本（${paths.versionFile}），该级别路径依赖版本号`,
      }),
    );
    return null;
  }
  if (!isFile(levelPath)) {
    attempts.push(attemptEntry(level, levelPath, platform, { reason: '文件不存在' }));
    return null;
  }
  if (!isNativeAbsolutePath(levelPath, platform)) {
    attempts.push(
      attemptEntry(level, levelPath, platform, { reason: '不是目标平台的原生绝对路径（C9），拒绝使用' }),
    );
    return null;
  }
  const check = await verifyCandidate(levelPath, cfg, paths, { fatalOnMismatch });
  if (check.fatal) {
    attempts.push(attemptEntry(level, levelPath, platform, { verified: false, reason: check.reason }));
    return null;
  }
  attempts.push(
    attemptEntry(level, levelPath, platform, {
      ok: true,
      verified: check.verified,
      reason: check.reason,
    }),
  );
  return availableResult(cfg, paths, {
    level,
    binPath: levelPath,
    verified: check.verified,
    verifyReason: check.reason,
    warning: check.verified === false ? check.reason : null,
    attempts,
  });
}

/** 把 AbortSignal 与超时合成一个信号，保证下载既听 exec.signal（C3）也不会永久挂住。 */
function linkSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`超时 ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  const dispose = () => {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', abort);
    }
  };
  return { signal: controller.signal, dispose };
}

/**
 * 第三级：官方下载。只有显式允许下载时才会走到这里 —— hook 热路径固定
 * allowDownload:false（locateEngine），status 的 `status download` 才带 true（D12）。
 * 顺序不可调换：写临时文件 → 校验 sha256 → 原子 rename；任一步失败都不留脏文件。
 */
async function downloadLevel(cfg, paths, attempts) {
  const platform = cfg.platform;
  const target = paths.userCacheBin;
  const fail = (reason) => {
    attempts.push(attemptEntry('download', target, platform, { reason }));
    return null;
  };

  if (!paths.engineVersion) return fail(`无法下载：未读到引擎版本（${paths.versionFile}）`);
  if (!paths.url) return fail('无法下载：下载地址未生成（缺少引擎版本）');
  const digests = paths.digests || [];
  // 先失败再联网（上游也是 fail closed）：清单没收录摘要时绝不发起请求、绝不写盘。
  if (digests.length === 0) {
    // 上游只发布 windows-x64 / darwin-* / linux-* 资产，没有 windows-arm64。
    // 我们不猜「用 x64 顶替」（那会让 arm64 机器上的 x64 二进制被误报为已校验），
    // 而是如实说明该平台没有可校验的资产。
    const armNote =
      paths.target === 'windows-arm64'
        ? '（上游未发布 impeccable-windows-arm64 资产：Windows-on-ARM 不在支持范围）'
        : '';
    return fail(
      `清单 ${path.basename(paths.checksumsFile)} 未收录 ${paths.engineVersion} ${paths.asset}${armNote}，拒绝未校验的下载`,
    );
  }
  if (typeof cfg.fetchImpl !== 'function') return fail('当前运行环境没有可用的 fetch，无法下载');

  const { signal, dispose } = linkSignal(cfg.signal, cfg.downloadTimeoutMs);
  let body;
  try {
    const res = await cfg.fetchImpl(paths.url, { redirect: 'follow', signal });
    if (!res || res.ok !== true) {
      return fail(`下载失败：${paths.url} 返回 HTTP ${res?.status ?? 'unknown'}`);
    }
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const aborted = signal.aborted === true;
    return fail(aborted ? '下载已取消（会话中止或超时）' : `下载失败：${err?.message ?? err}`);
  } finally {
    dispose();
  }

  if (body.length === 0) return fail(`下载内容为空：${paths.url}，拒绝未校验的下载`);

  const actual = createHash('sha256').update(body).digest('hex');
  if (!digests.includes(actual)) {
    return fail(`下载内容 sha256 ${actual.slice(0, 12)}… 与清单不一致，已丢弃（未写入缓存）`);
  }

  const dest = toNativePath(target, platform);
  const tmp = `${target}.part.${process.pid}.${Date.now().toString(36)}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    // 原子替换：同目录 rename，中途断电只会留下 .part 文件，不会出现半个引擎。
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 尽力清理 */
    }
    return fail(`写入缓存失败：${err?.message ?? err}`);
  }
  // 与上游 launcher / npm shim 共用同一枚 .verified 戳，两边都不必重复哈希。
  try {
    fs.writeFileSync(`${target}.verified`, `${actual} ${body.length}\n`);
  } catch {
    /* 只读缓存目录：本次仍已验证，下次重新哈希 */
  }

  attempts.push(
    attemptEntry('download', target, platform, {
      ok: true,
      verified: true,
      reason: `已下载并校验 sha256（${actual.slice(0, 12)}…），落盘 ${(body.length / 1048576).toFixed(1)}MB`,
    }),
  );
  return availableResult(cfg, paths, {
    level: 'download',
    binPath: target,
    verified: true,
    verifyReason: 'sha256 与清单一致',
    warning: null,
    reason: `${LEVEL_LABEL.download}成功：${dest}`,
    attempts,
  });
}

/**
 * 三级定位总入口。
 * options.allowDownload 决定是否允许走到第三级：hook 热路径必须传 false（D12）。
 */
export async function resolveEngine(options = {}) {
  const cfg = normalizeOptions(options);
  const paths = enginePaths(cfg);
  const attempts = [];

  if (cfg.signal?.aborted) {
    return unavailableResult(paths, '已取消：会话信号在定位前就中止了', attempts);
  }

  const hitSkill = await tryLevel('user-skill', paths.userSkillBin, cfg, paths, attempts, {
    fatalOnMismatch: false,
  });
  if (hitSkill) return hitSkill;

  const hitCache = await tryLevel('user-cache', paths.userCacheBin, cfg, paths, attempts, {
    fatalOnMismatch: true,
  });
  if (hitCache) return hitCache;

  if (!cfg.allowDownload) {
    attempts.push(
      attemptEntry('download', paths.userCacheBin, cfg.platform, {
        reason: 'hook 热路径只定位、绝不下载（D12）：下载只发生在 status 或显式动作',
      }),
    );
    const reason = [
      `未找到可用引擎（引擎版本 ${paths.engineVersion ?? '未知'}，资产 ${paths.asset}）：`,
      describeAttempts(attempts),
      '按 AC3 处理：skill 照常可用，hook 静默关闭。可在 status 中执行下载。',
    ].join(' ');
    cfg.log({ level: 'warn', message: reason });
    return unavailableResult(paths, reason, attempts);
  }

  const downloaded = await downloadLevel(cfg, paths, attempts);
  if (downloaded) return downloaded;

  const reason = [
    `三级引擎链全部失败（引擎版本 ${paths.engineVersion ?? '未知'}，资产 ${paths.asset}）：`,
    describeAttempts(attempts),
    '按 AC3 处理：skill 照常可用，hook 静默关闭。',
  ].join(' ');
  cfg.log({ level: 'warn', message: reason });
  return unavailableResult(paths, reason, attempts);
}

/**
 * hook 热路径入口：只定位、绝不下载（D12），默认 digest 校验但带摘要缓存（AC4）。
 * 任何失败都以 available:false 返回，绝不抛错 —— hook 不能因为缺引擎而拖垮会话（A1/AC3）。
 */
export async function locateEngine(options = {}) {
  return resolveEngine({ ...options, allowDownload: false });
}
