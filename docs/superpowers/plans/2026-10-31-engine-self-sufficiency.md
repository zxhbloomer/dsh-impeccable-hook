# dsh-impeccable-hook v0.3 自给自足（引擎 + 命令）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件安装后自己把 skill 与引擎备齐（不再依赖上游手动安装的那套），并修好 `/impeccable-hook on|off`。

**Architecture:** 引擎解析由三级收为两级——①共用缓存 `~/.impeccable/bin/<engineVersion>/` ②官方 Release 下载（sha256 校验 + 原子落地）。缓存目录**沿用 `~/.impeccable`**：这是不可修改的 skill launcher 的默认查找位置，插件与 `/impeccable` 的 CLI 动词因此共用同一份引擎，物理上只有一份。插件 `apply()` 后异步触发一次 ensure，失败只 warning；`on/off` 依赖的 `configEditor` 改走 `ctx.get`。

**Tech Stack:** 纯 ESM JavaScript（Node 22+），`node --test`，Cordis 插件运行时（DSH）。

**Spec:** `docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md` 的「v0.2.7 → v0.3」一节；修订依据 `docs/code-review-v0.3-plan.md`。

## Global Constraints

- 运行期永不抛错（AC3）：引擎缺失/下载失败只 warning，hook 退化为「无引擎」计数。
- hook 热路径必须 `allowDownload:false`（D12）：热路径只定位，绝不联网。
- 不使用 `postinstall`：pnpm 拦截构建脚本，实测会让整批安装失败（`ERR_PNPM_IGNORED_BUILDS`）。
- 缓存目录**保持 `~/.impeccable`**（评审 B1）：与不可改的 launcher 共用，禁止改名。
- 不改 `skills/impeccable/**` 内容（`MODIFICATIONS.md` 的说明性补记除外）。
- 测试必须离线可跑：网络/子进程都要可注入。
- 不新增未登记文件：改动文件全部列在各任务 Files 里。

## Review Focus

- 断网首启：不阻塞启动、不刷屏、`status` 给出可执行下一步、无 unhandledRejection。
- 缓存为空 + 有网：自动就位且 `.verified` 戳存在（不只看文件存在）。
- 同进程重复触发 ensure：复用同一 Promise，只下一份。
- `on` 后立即 `status` 显示「开」且配置已写；`off` 同理（成对断言）。
- 引擎版本与 `upstream.lock.json` 不一致：仍可用但 `verified:false` + 一次 warning。

---

### Task 1: 引擎解析两级化（删掉 level①），保持 `~/.impeccable` 缓存

**Files:**
- Modify: `lib/engine.js`（`LEVEL_LABEL` 32-38；`normalizeOptions` 144-173 中 `dshHome` 158、`impeccableHome` 159-160；`enginePaths` 174-236 中 `userSkillBin` 186；`resolveEngine` 574-620 中 `tryLevel('user-skill', …)` 583）
- Test: `test/engine.test.mjs`（`:180,193,222,255,343` 相关用例）

**Interfaces:**
- Produces: `LEVEL_LABEL` 仅含 `'user-cache'`（文案「①共用缓存 ~/.impeccable」）与 `'download'`（「②官方 Release 下载」）。
- Produces: `enginePaths()` 返回对象**不再含** `userSkillBin`；`userCacheBin` 语义不变。
- Produces: `normalizeOptions()` 不再接受/返回 `dshHome`；`impeccableHome` 默认 `path.join(os.homedir(), '.impeccable')`，环境变量 `IMPECCABLE_HOME` 仍生效。

- [ ] **Step 1: 写失败测试**：`LEVEL_LABEL` keys 深等于 `['download','user-cache']`；`'userSkillBin' in enginePaths({...}) === false`；`normalizeOptions({}).impeccableHome === path.join(os.homedir(), '.impeccable')`。
- [ ] **Step 2: 跑 `node --test`**，确认这三条 FAIL。
- [ ] **Step 3: 实现**：删除 `userSkillBin` 与对应 `tryLevel` 调用（`attempts` 少一项）；改 `LEVEL_LABEL`；删 `dshHome` 参数；同步改 `test/engine.test.mjs:255` 的层级列表断言。
- [ ] **Step 4: 跑 `node --test`** 全绿。
- [ ] **Step 5: 等用户指令再提交**

### Task 2: 首次启动自动就绪（带开关、单次、可关）

**Files:**
- Modify: `lib/engine.js`（导出幂等 `ensureEngine`；失败路径清理 `.part`）
- Modify: `lib/index.js`（`apply()` 内、225-231 之后触发）
- Modify: `lib/config.js`（`DEFAULT_CONFIG.hook.autoDownload = true`）与 `normalizeConfig`
- Test: `test/plugin.test.mjs`（新增用例；`:479` 断言改为仅热路径）

**Interfaces:**
- Produces: `ensureEngine(options)` —— 语义为 `resolveEngine({ ...options, allowDownload: true })`，**模块级单次**（同进程重复调用复用同一 Promise）。
- Produces: `DEFAULT_CONFIG.hook.autoDownload: boolean`（默认 `true`）；为 `false` 时 `apply()` 不触发 ensure。
- Consumes: Task 1 的两级解析。

- [ ] **Step 1: 写失败测试**
  - `test('apply 后自动 ensure 一次')`：假 ctx + `IMPECCABLE_DOWNLOAD_BASE` 指向本地 fixture，`fetchCalls === 1`。
  - `test('autoDownload=false 时不触发')`：`fetchCalls === 0`。
  - `test('并发调用只下一次')`：`Promise.all([ensureEngine(o), ensureEngine(o)])` → `fetchCalls === 1`。
  - `test('下载失败不抛错且清理 .part')`：fixture 抛错 → 返回 `{available:false}`、无 `.part` 残留、无 unhandledRejection。
  - 改 `test/plugin.test.mjs:479`：断言改为「热路径 fetch=0」。
- [ ] **Step 2: 跑 `node --test`** 确认新增用例 FAIL。
- [ ] **Step 3: 实现**：`lib/index.js` 末尾 `if (cfg.autoDownload) void ensureEngine({ ...engineOptions, log }).catch(...)`（显式传 `log`，因为 `engine.js:166` 默认是空函数）；`ensureEngine` 用模块级 `let ensured = null`；下载失败时删除 `<bin>.part.*`。
- [ ] **Step 4: 跑 `node --test`** 全绿，且热路径用例仍 `fetch=0`。
- [ ] **Step 5: 等用户指令再提交**

### Task 3: 修 `/impeccable-hook on|off`（configEditor 走 ctx.get）

**Files:**
- Modify: `lib/commands.js`（`getService` 41-53；使用点 364）
- Test: `test/plugin.test.mjs`（新增 Proxy 契约用例）

**Interfaces:**
- 缺陷证据：真机 `/impeccable-hook on` 报 `cannot get property "configEditor" without inject`；`lib/commands.js:42` 的 `ctx?.[key]` 直取在未 inject 时**抛错**（不是 undefined）。
- Produces: `getService(ctx, name)` 先 `ctx.get(name)`（try/catch），属性直取放最后并 try/catch；`'configEditor'` **不加入** `inject`（保持可选服务）。

- [ ] **Step 1: 写失败测试**：用 Proxy 构造「未 inject 的属性访问即抛」的 ctx，`getService(ctx,'configEditor')` 必须返回通过 `ctx.get` 拿到的对象（当前实现抛错 → FAIL）。
- [ ] **Step 2: 跑 `node --test`** 确认 FAIL。
- [ ] **Step 3: 实现** `getService` 顺序调整。
- [ ] **Step 4: 跑 `node --test`** 全绿；并补 `on → 状态开 → off → 状态关` 的四步成对断言。
- [ ] **Step 5: 等用户指令再提交**

### Task 4: 文档口径收口

**Files:**
- Modify: `README.md`（引擎表 86/131/178 行、安装段、新增「装完即用」）
- Modify: `docs/acceptance-evidence.md`（AC11–AC15 + AC4 重录 + 14/51 行改口）
- Modify: `docs/completion-summary.md`（67/68/119 行）
- Modify: `docs/code-review-S2-S6.md:62`（「allowDownload 零命中」限定为仅热路径）
- Modify: `skills/impeccable/MODIFICATIONS.md`（补缓存位置说明）

- [ ] **Step 1** 删 README 里 `level=user-skill` 行与「用户自己装过 skill 的那一份」「删掉/改名那份用户级 skill」表述；引擎表改两级，并写明「`~/.impeccable` 是引擎共用缓存（launcher 默认位置），不是上游残留」。
- [ ] **Step 2** 新增「装完即用」段：首次启动后台下载约 20MB、失败只警告、手动兜底 `/impeccable-hook status download`、`hook.autoDownload:false` 可关。
- [ ] **Step 3** 回写 AC11–AC15 结论与证据层级；AC4 按新两级重录，并单列「下载未完成时首轮 hook 报 no-engine」。
- [ ] **Step 4** 核对：`grep -rn "user-skill\|用户级已装" README.md docs/*.md` 命中 0（历史修订记录节除外）。
- [ ] **Step 5: 等用户指令再提交**

### Task 5: 代码评审（独立评审人，不得是实现者）

- [ ] 范围：Task 1–4 的 diff、`npm test` 基线、真机 `status` 输出。
- [ ] 硬要求：AC11 给「缓存为空→自动就位」可复算证据；AC12 给断网证据且无 unhandledRejection；`on/off` 四步成对；`~/.impeccable` 只有一份引擎（不得出现第二份缓存）。
- [ ] 输出 `docs/code-review-v0.3.md`，结论 `pass` / `needs_revision`（blocking / non-blocking 分级）。
