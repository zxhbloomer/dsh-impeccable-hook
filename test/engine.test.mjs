// test/engine.test.mjs —— lib/engine.js 单测（node --test）
//
// 覆盖设计文档 §4.2 三级降级链与四条硬约束：
//   C9  原生绝对路径把关 · C10 版本只认 VERSION · D12 热路径不下载 · AC3 全失败不抛错
// 全部用例只操作 os.tmpdir() 下的 fixture，不联网（fetch 一律注入假实现），
// 也不读本机真实引擎，保证在干净 clone 上可复现。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  enginePaths,
  expectedDigests,
  isNativeAbsolutePath,
  locateEngine,
  parseChecksums,
  platformTarget,
  probeEngineVersion,
  readEngineVersion,
  resolveEngine,
  toNativePath,
} from '../lib/engine.js';

const ENG = '0.1.18';
const PAYLOAD = 'impeccable-engine-fixture-0.1.18';

/** 造一套包内 skill 快照目录（VERSION + engine-checksums.txt）与两个候选位置的父目录。 */
function makeFixture({ platform = process.platform, arch = process.arch, manifest = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-engine-'));
  const scriptsDir = path.join(root, 'skills', 'impeccable', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const versionFile = path.join(scriptsDir, 'VERSION');
  fs.writeFileSync(versionFile, `${ENG}\n`);
  const target = platformTarget({ platform, arch });
  const checksumsFile = path.join(scriptsDir, 'engine-checksums.txt');
  const digest = createHash('sha256').update(PAYLOAD).digest('hex');
  if (manifest) {
    fs.writeFileSync(
      checksumsFile,
      [
        '# Engine binary digests for the pinned ENGINE_VERSION: <engine-version> <asset> <sha256>.',
        `# 注释行必须被忽略`,
        `${ENG} impeccable-linux-x64 ${'a'.repeat(64)}`,
        `${ENG} ${target.asset} ${digest}`,
      ].join('\n') + '\n',
    );
  }
  return {
    root,
    scriptsDir,
    versionFile,
    checksumsFile,
    digest,
    target,
    platform,
    arch,
    dshHome: path.join(root, 'dsh-home'),
    impeccableHome: path.join(root, 'impeccable-home'),
  };
}

/** 在「用户级已装 skill」位置放一份引擎。 */
function placeUserSkillEngine(f, content = PAYLOAD) {
  const dir = path.join(f.dshHome, 'skills', 'impeccable', 'scripts', 'bin', f.target.target);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, f.target.exe);
  fs.writeFileSync(file, content);
  return file;
}

/** 在「~/.impeccable 版本缓存」位置放一份引擎。 */
function placeUserCacheEngine(f, content = PAYLOAD) {
  const dir = path.join(f.impeccableHome, 'bin', ENG);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, f.target.exe);
  fs.writeFileSync(file, content);
  return file;
}

/** 注入用假 fetch：记录调用次数与 URL，返回给定字节。 */
function fakeFetch(bytes, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const buf = Buffer.from(bytes);
    return {
      ok,
      status,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
  impl.calls = calls;
  return impl;
}

function baseOptions(f, extra = {}) {
  return {
    platform: f.platform,
    arch: f.arch,
    versionFile: f.versionFile,
    checksumsFile: f.checksumsFile,
    dshHome: f.dshHome,
    impeccableHome: f.impeccableHome,
    ...extra,
  };
}

// ───────────────────────── 纯函数：版本 / 资产 / 清单 / 路径 ─────────────────────────

test('readEngineVersion 只认 VERSION 文件里的三段式版本（C10）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-ver-'));
  const ok = path.join(root, 'VERSION');
  fs.writeFileSync(ok, '  0.1.18\r\n');
  assert.equal(readEngineVersion(ok), ENG);

  const empty = path.join(root, 'EMPTY');
  fs.writeFileSync(empty, '');
  assert.equal(readEngineVersion(empty), null);

  const junk = path.join(root, 'JUNK');
  fs.writeFileSync(junk, 'not-a-version');
  assert.equal(readEngineVersion(junk), null);

  assert.equal(readEngineVersion(path.join(root, 'MISSING')), null);
});

test('expectedDigests 只认本平台资产：不拿 x64 摘要顶替 windows-arm64（不猜）', () => {
  const x64 = 'b'.repeat(64);
  const checksums = parseChecksums(`${ENG} impeccable-windows-x64.exe ${x64}
`);
  assert.deepEqual(expectedDigests(checksums, ENG, 'impeccable-windows-x64.exe'), [x64]);
  // 上游没有发布 windows-arm64 引擎：如实返回「无摘要」，由调用方 fail closed，而不是猜 x64。
  assert.deepEqual(expectedDigests(checksums, ENG, 'impeccable-windows-arm64.exe'), []);
  // 版本不在清单里同样空手而归。
  assert.deepEqual(expectedDigests(checksums, '9.9.9', 'impeccable-windows-x64.exe'), []);
});

test('platformTarget 给出上游一致的 os-arch 与资产名', () => {
  assert.deepEqual(platformTarget({ platform: 'win32', arch: 'x64' }), {
    os: 'windows',
    arch: 'x64',
    target: 'windows-x64',
    exe: 'impeccable.exe',
    asset: 'impeccable-windows-x64.exe',
  });
  assert.equal(platformTarget({ platform: 'linux', arch: 'x64' }).asset, 'impeccable-linux-x64');
  assert.equal(platformTarget({ platform: 'darwin', arch: 'arm64' }).asset, 'impeccable-darwin-arm64');
  assert.equal(platformTarget({ platform: 'darwin', arch: 'arm64' }).exe, 'impeccable');
});

test('parseChecksums 忽略注释、容忍 CRLF 与末行无换行', () => {
  const text =
    '# 头部注释\r\n' +
    `\r\n${ENG} impeccable-linux-x64 ${'b'.repeat(64)}\r\n` +
    `${ENG} impeccable-windows-x64.exe ${'C'.repeat(64)}` + // 大写摘要也要归一成小写
    '';
  const map = parseChecksums(text);
  assert.equal(map.get(`${ENG}\u0000impeccable-linux-x64`), 'b'.repeat(64));
  assert.equal(map.get(`${ENG}\u0000impeccable-windows-x64.exe`), 'c'.repeat(64));
  // 坏行（摘要长度不对）不进入清单
  assert.equal(parseChecksums(`${ENG} impeccable-linux-x64 deadbeef`).size, 0);
  assert.equal(parseChecksums('').size, 0);
});

test('toNativePath / isNativeAbsolutePath 按目标平台把关（C9）', () => {
  assert.equal(toNativePath('D:/a/b/impeccable.exe', 'win32'), 'D:\\a\\b\\impeccable.exe');
  assert.equal(toNativePath('/usr/local/bin/impeccable', 'linux'), '/usr/local/bin/impeccable');
  assert.equal(isNativeAbsolutePath('D:\\a\\impeccable.exe', 'win32'), true);
  assert.equal(isNativeAbsolutePath('\\\\server\\share\\impeccable.exe', 'win32'), true);
  // POSIX 风格路径在 Windows 上不算合法绝对路径 —— 正是 C9 里那个静默 exit 0 的坑
  assert.equal(isNativeAbsolutePath('/c/Users/x/impeccable.exe', 'win32'), false);
  assert.equal(isNativeAbsolutePath('/usr/bin/impeccable', 'linux'), true);
  assert.equal(isNativeAbsolutePath('relative/impeccable', 'linux'), false);
});

test('enginePaths 用包内 VERSION 与清单算出三级候选路径', () => {
  const f = makeFixture();
  const p = enginePaths(baseOptions(f));
  assert.equal(p.engineVersion, ENG);
  assert.equal(p.asset, f.target.asset);
  assert.equal(p.userSkillBin, path.join(f.dshHome, 'skills', 'impeccable', 'scripts', 'bin', f.target.target, f.target.exe));
  assert.equal(p.userCacheBin, path.join(f.impeccableHome, 'bin', ENG, f.target.exe));
  assert.ok(p.url.endsWith(`/engine-v${ENG}/${f.target.asset}`));
  assert.deepEqual(p.digests, [f.digest]);
});

// ────────────────────────────── 定位（热路径，只定位不下载） ──────────────────────────────

test('一级命中：用户级已装引擎直接可用，且 sha256 与清单一致', async () => {
  const f = makeFixture();
  const bin = placeUserSkillEngine(f);
  const r = await locateEngine(baseOptions(f));
  assert.equal(r.available, true);
  assert.equal(r.level, 'user-skill');
  assert.equal(r.engineVersion, ENG);
  assert.equal(r.verified, true);
  assert.equal(r.warning, null);
  assert.equal(r.path, toNativePath(bin, f.platform));
  assert.equal(isNativeAbsolutePath(r.path, f.platform), true);
  // 三级链的每一级都有可审计的结论
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].ok, true);
});

test('一级缺失、二级命中：回落到 ~/.impeccable 版本缓存', async () => {
  const f = makeFixture();
  const bin = placeUserCacheEngine(f);
  const r = await locateEngine(baseOptions(f));
  assert.equal(r.available, true);
  assert.equal(r.level, 'user-cache');
  assert.equal(r.path, toNativePath(bin, f.platform));
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].ok, false);
  assert.match(r.attempts[0].reason, /不存在/);
  assert.equal(r.attempts[1].ok, true);
});

test('一级摘要不符仍可用但必须留 warning（A3：不静默）', async () => {
  const f = makeFixture();
  placeUserSkillEngine(f, 'a-newer-user-installed-engine');
  const r = await locateEngine(baseOptions(f));
  assert.equal(r.available, true);
  assert.equal(r.level, 'user-skill');
  assert.equal(r.verified, false);
  assert.match(r.warning, /与钉死引擎版本不一致/);
});

test('二级缓存被改动（摘要不符）时跳过该级别', async () => {
  const f = makeFixture();
  placeUserCacheEngine(f, 'tampered-cache');
  const r = await locateEngine(baseOptions(f));
  assert.equal(r.available, false);
  assert.equal(r.attempts[1].level, 'user-cache');
  assert.equal(r.attempts[1].ok, false);
  assert.match(r.attempts[1].reason, /疑似被改动/);
});

test('全部缺失时热路径只定位、绝不下载（D12 / AC3）', async () => {
  const f = makeFixture();
  const fetchImpl = fakeFetch(PAYLOAD);
  const r = await locateEngine(baseOptions(f, { fetchImpl }));
  assert.equal(r.available, false);
  assert.equal(r.level, null);
  assert.equal(r.path, null);
  assert.equal(fetchImpl.calls.length, 0, '热路径不得发起任何下载请求');
  assert.match(r.reason, /热路径只定位、绝不下载/);
  assert.match(r.reason, /hook 静默关闭/);
  // 三级的结论都留痕，便于 status 解释原因（AC3）
  assert.deepEqual(
    r.attempts.map((a) => a.level),
    ['user-skill', 'user-cache', 'download'],
  );
});

test('VERSION 读不到时缓存位与下载位都没有可用路径', async () => {
  const f = makeFixture();
  fs.rmSync(f.versionFile, { force: true });
  const fetchImpl = fakeFetch(PAYLOAD);
  const r = await locateEngine(baseOptions(f, { fetchImpl }));
  assert.equal(r.available, false);
  assert.equal(r.engineVersion, null);
  assert.match(r.attempts[1].reason, /未读到引擎版本/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('会话已中止时立刻返回「已取消」，不做任何定位副作用', async () => {
  const f = makeFixture();
  placeUserSkillEngine(f);
  const controller = new AbortController();
  controller.abort(new Error('用户取消'));
  const r = await locateEngine(baseOptions(f, { signal: controller.signal }));
  assert.equal(r.available, false);
  assert.match(r.reason, /已取消/);
  assert.equal(r.attempts.length, 0);
});

// ────────────────────────────── 下载级（status / 显式动作） ──────────────────────────────

/** 下载级的唯一入口：唯一的生产调用方是 status 的 `status download`（D12）。 */
function ensureDownload(options) {
  return resolveEngine({ ...options, allowDownload: true });
}

test('三级下载成功：临时文件 → 校验 → 原子 rename，且留下 .verified 戳', async () => {
  const f = makeFixture();
  const fetchImpl = fakeFetch(PAYLOAD);
  const r = await ensureDownload(baseOptions(f, { fetchImpl }));
  assert.equal(r.available, true);
  assert.equal(r.level, 'download');
  assert.equal(r.verified, true);
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].url.endsWith(`/engine-v${ENG}/${f.target.asset}`));

  const dest = path.join(f.impeccableHome, 'bin', ENG, f.target.exe);
  assert.equal(fs.readFileSync(dest, 'utf8'), PAYLOAD, '落盘内容必须与下载内容一致');
  assert.equal(fs.readFileSync(`${dest}.verified`, 'utf8').trim(), `${f.digest} ${PAYLOAD.length}`);
  // 不留 .part 临时文件（原子 rename 的证据）
  const leftovers = fs.readdirSync(path.dirname(dest)).filter((n) => n.includes('.part.'));
  assert.deepEqual(leftovers, []);
});

test('下载内容 sha256 不符：拒绝写入，缓存目录不留脏文件', async () => {
  const f = makeFixture();
  const fetchImpl = fakeFetch('tampered-download');
  const r = await ensureDownload(baseOptions(f, { fetchImpl }));
  assert.equal(r.available, false);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(r.attempts.at(-1).reason, /sha256 .* 与清单不一致/);
  const cacheDir = path.join(f.impeccableHome, 'bin', ENG);
  assert.equal(fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length > 0, false);
});

test('清单未收录该引擎：联网前就拒绝（fail closed）', async () => {
  const f = makeFixture({ manifest: false });
  const fetchImpl = fakeFetch(PAYLOAD);
  const r = await ensureDownload(baseOptions(f, { fetchImpl }));
  assert.equal(r.available, false);
  assert.equal(fetchImpl.calls.length, 0, '没有摘要就不许发起下载');
  assert.match(r.attempts.at(-1).reason, /拒绝未校验的下载/);
});

test('下载返回非 2xx：报 HTTP 状态，不写缓存', async () => {
  const f = makeFixture();
  const fetchImpl = fakeFetch(PAYLOAD, { ok: false, status: 404 });
  const r = await ensureDownload(baseOptions(f, { fetchImpl }));
  assert.equal(r.available, false);
  assert.match(r.attempts.at(-1).reason, /HTTP 404/);
  assert.equal(fs.existsSync(path.join(f.impeccableHome, 'bin', ENG, f.target.exe)), false);
});

test('下载空内容：拒绝写入', async () => {
  const f = makeFixture();
  const fetchImpl = fakeFetch('');
  const r = await ensureDownload(baseOptions(f, { fetchImpl }));
  assert.equal(r.available, false);
  assert.match(r.attempts.at(-1).reason, /下载内容为空/);
});

test('允许下载的入口不会因为一级/二级已有引擎就联网', async () => {
  const f = makeFixture();
  placeUserSkillEngine(f);
  const fetchImpl = fakeFetch(PAYLOAD);
  const r = await ensureDownload(baseOptions(f, { fetchImpl }));
  assert.equal(r.available, true);
  assert.equal(r.level, 'user-skill');
  assert.equal(fetchImpl.calls.length, 0);
});

// ─────────────────────────── engine-probe 握手（跨平台夹具，不 skip） ───────────────────────────

// 用 node 自己当「假引擎」：任何平台都能直接 exec，不需要 POSIX shell 脚本（t6 要求干掉常驻 skip）。
const NODE_BIN = process.execPath;
const probeWith = (script, options = {}) =>
  probeEngineVersion(NODE_BIN, { probeArgs: ['-e', script], ...options });

test('probeEngineVersion 认上游 engine-probe 握手输出', async () => {
  assert.equal(await probeWith('console.log("impeccable-engine 0.1.18")'), ENG);
});

test('probeEngineVersion 输出不含握手标记时返回 null', async () => {
  assert.equal(await probeWith('console.log("unknown command: engine-probe")'), null);
});

test('probeEngineVersion 拿不到可执行文件时返回 null（不抛错）', async () => {
  assert.equal(await probeEngineVersion(path.join(os.tmpdir(), 'no-such-impeccable-engine-xyz')), null);
});

test('probeEngineVersion 超时返回 null，不永久挂住', async () => {
  const started = Date.now();
  const got = await probeWith('setTimeout(() => {}, 5000)', { timeoutMs: 300 });
  assert.equal(got, null);
  assert.ok(Date.now() - started < 4000, '超时必须靠自身计时器收尾');
});

test('probeEngineVersion 观察 abort 信号（C3）', async () => {
  const controller = new AbortController();
  const pending = probeWith('setTimeout(() => {}, 5000)', { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  assert.equal(await pending, null);
});
