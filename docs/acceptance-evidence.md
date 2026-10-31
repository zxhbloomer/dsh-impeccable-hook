# dsh-impeccable-hook 验收证据表（t6 / S7）

> 生成时间：2026-10-31（Asia/Hong_Kong）
> 对应设计文档：`docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md`（v0.2.1）第 9 节 AC1–AC10。
> 证据分层：① 单测断言（`node --test test/`）② 真实链路脚本（本机真引擎、临时工程目录、全新 session）③ 命令输出（退出码 + 原文）④ 人工确认（桌面端手敲命令，**尚未执行**）。

## 一、总表

| 验收点 | 结论 | 证据 | 层级 |
|---|---|---|---|
| AC1 status 打印实际解析到的 SKILL.md 绝对路径，并与包内路径比对 | 通过（渲染与比对逻辑）｜**待人工确认**（运行期真实解析） | `test/plugin.test.mjs`：`AC1：status 打印实际路径并判定与包内路径一致`、`整链…`；真机 `renderStatus` 输出（见 §二 A/B/C） | ①②④ |
| AC2 改含渐变文字的 .html 后下一轮出现 `[impeccable@1]` 与 `gradient-text` | 通过 | 真机整链脚本：35ms、`additionalContexts[0].role='user'`、header `[impeccable@1] Design hook findings requiring review in hero.html (1 issue(s)):`、finding `- [gradient-text] Gradient text…` | ② |
| AC3 引擎缺失时静默关闭且 status 写原因 | 通过 | `test/hook.test.mjs`：`AC3：引擎不可用时静默跳过并记原因，绝不抛错`；`test/plugin.test.mjs`：`整链：… fetch 调用数为 0（D12 / AC3）`、`AC3：引擎缺失时 status 写明未找到及原因`；真机 status（见 §二 B） | ①② |
| AC4 单次 hook < 200ms | 通过（35ms） | 真机整链脚本首轮 35ms、次轮 38ms（多次实跑 31–38ms）；命中 level=user-skill，摘要缓存生效 | ② |
| AC5 同文件同问题第二次不重复注入（**两条独立防线**） | 通过 | 防线①（引擎侧、跨进程）：真机第二轮 `additionalContexts` 长度 0、`findings=0`，状态落在 `~/.impeccable/hook-claims`（**不是插件的去重**）；防线②（插件侧、进程内）：`lib/hook.js` 的 `文件::规则` 指纹去重，由 `test/hook.test.mjs`（`AC5：同文件同规则第二次不再注入`、`AC5：换文件后同样的规则允许再注入一次`）+ 评审独立脚本（20 条 findings 四轮 8/8/4/0、`dedup=20`、条数配额停 40）证明 | ①② |
| AC6 `check-upstream.mjs` exit 0 | 通过 | `node scripts/check-upstream.mjs` → exit 0；`--online` → exit 0 且「上游 main 的 skill 版本 0.1.18 与 lock 一致」 | ③ |
| AC7 干净 clone 后 `dsh plugin add github:…` 装上生效 | **通过（已实测 GitHub 形态）** | ① 干净 clone `https://github.com/zxhbloomer/dsh-impeccable-hook`（83 文件）后**不装任何依赖**直接 `npm test` → 92/92 pass；② 隔离 `DSH_HOME`（`%TEMP%c7-home2`）下 `dsh plugin --profile ac7 add github:zxhbloomer/dsh-impeccable-hook` → pnpm 解析到 `https://codeload.github.com/zxhbloomer/dsh-impeccable-hook/tar.gz/f4400dc…`、14.4s 装上 `dsh-impeccable-hook 0.1.0`（无 build、无 prepare）；③ 该 profile `dsh.profile.bundles` 自动登记为 `["@deepseek-ai/dsh-base","dsh-impeccable-hook"]`；④ `dsh --profile ac7 --dump-config` 渲染出 `# == dsh-impeccable-hook` 层（第 363–365 行）；⑤ 包内 `skills/impeccable` 59 文件随 tarball 落地（见 §九） | ①③ |
| AC8 非白名单文件完全不被调用 | 通过（零引擎调用） | `test/hook.test.mjs`：`AC8：白名单外扩展名在调引擎之前就放行`（`locate.calls=0`、`engine.calls=0`、`extSkip+1`）；`test/plugin.test.mjs`：`整链：白名单外扩展名（.md）连 engine.js 都不进（AC8）`（共享日志 `calls` 与 `noEngine` 增量均为 0） | ① |
| AC9 20+ findings 的 .vue 注入 ≤ top-N 且计数一致 | 通过（单测） | `test/hook.test.mjs`：`AC9：20 条 findings 按 top-N 只注入 8 条，计数一致`、`topN 可配置`、`会话条数配额用尽后记 quota`、`字符配额：注入文本不超过剩余字符预算` | ① |
| AC10 破坏事件签名时启动自检失败可见 | 通过（单测）｜**待人工确认**（真机启动 warning） | `test/plugin.test.mjs`：`AC10：自检发现下游判定被改写时失败并给出原因`、`AC10：拿不到事件总线时自检也失败（而不是静默）`；`runStartupSelfCheck` 失败时 `handle.selfCheck.ok=false` + `ctx.logger.warn` 一行 + status 返回 `kind='error'` | ①④ |

## 二、真机取证原文（可复现）

复现要点：**每次用全新工程目录 + 全新 session id**。两处持久状态都会压住重复注入：① 工程内 `.impeccable/hook.cache.json`（session→文件→findings 记忆）；② 全局 `~/.impeccable/hook-claims`、`~/.impeccable/hook-sessions`（跨进程 claim 抑制，见 §七）。

### A. 本机真实 skills 视图（当下必然「不一致 ✗」）

包内 `skills/impeccable` 快照要到 S6 才落地，所以现在解析到的是用户级那份：

```
skill 解析   C:\Users\Administrator\.dsh\skills\impeccable\SKILL.md
             provider=dsh-impeccable-hook ｜ source=custom ｜ 视图=global
             与包内路径 不一致 ✗（包内应为 D:\2026_project\99_dsh\dsh-impeccable-hook\skills\impeccable\SKILL.md，…）
             含义：同层有更高优先级/同名的 impeccable（例如 $DSH_HOME/skills/impeccable），包内副本未生效。
             rank 不在 SkillSummary 上（只有 provider 层候选才有），故此处不打印；排序结论以本路径为准。
```

判定逻辑本身的双向用例由 `test/plugin.test.mjs` 覆盖（一致 ✓ / 不一致 ✗ 各一条）。

### B. 引擎缺失（AC3）

```
引擎         未找到（三级降级全部失败）
             原因：未找到可用引擎（…）：①…文件不存在 ②…未读到引擎版本 ③…hook 热路径只定位、绝不下载（D12）
             如需插件下载官方引擎（约 20MB、sha256 校验）：/impeccable-hook status download
```

### C. 引擎在但摘要无从比对（本机现状，不刷屏）

```
引擎         level=user-skill（①用户级已装 skill 的引擎）
             path=C:\Users\Administrator\.dsh\skills\impeccable\scripts\bin\windows-x64\impeccable.exe
             版本 未知（钉死 0.1.18） ｜ verified=null
             摘要校验 清单 engine-checksums.txt 未收录 (无版本) impeccable-windows-x64.exe
```

## 三、测试与命令

- `npm test` → **最终态 tests 92 / pass 92 / fail 0 / skipped 0**（24 engine + 40 hook + 28 plugin）。演进：t6 消灭 t3 遗留的 POSIX-only skip（85）→ t10 补 4 条（89）→ t12 补 N3 闸门 2 条（91）→ t13 补 lock 形状 1 条（92）。
- `node --check lib/*.js scripts/*.mjs test/*.mjs` → 全通过（与 `.github/workflows/verify.yml` 同一闸门）。
- 静态自检：`lib/{hook,index,commands,config,log}.js` 中 `ensureEngine` 命中 0（热路径只定位，D12）；`lib/` 中 `console.` 命中 0。

## 四、待人工确认项（不许假装已验证）

1. 桌面端会话手敲 `/impeccable-hook status`，肉眼确认「实际解析路径 = 包内路径」与注入计数。
2. 破坏 `tools/post-execute` 签名场景下，启动时能看到那行 warning。
3. ~~AC7：仓库推上 GitHub 后验证~~ —— **已于 2026-10-31 完成**（隔离 `DSH_HOME` + `github:` spec 真装，见 §九），不再是待人工项。

## 五、本轮顺带修掉的真实缺陷（取证时发现）

1. `status` 把 `null` 直接拼进文案（`版本 null ≠ 钉死 0.1.18`、`摘要校验 … ；null`）——用户看不懂，已修并由回归用例锁住。
2. 引擎版本读不到时，版本报告原本会落进「与钉死一致」分支（等于谎报一致）——已改为如实输出「未探测到本机引擎」。

## 六、t10 复验：评审 B1（skill 快照落地）修复后

评审 `docs/code-review-S2-S6.md` 的 blocking B1 已消除，AC1 / AC6 离线分支 / AC7 的前置条件现在都成立。

- **快照落地**：`node scripts/sync-upstream.mjs` 从 `pbakaus/impeccable@main` 拉取，落盘 `skills/impeccable` 共 **59 个文件**（58 个上游文件 + `MODIFICATIONS.md`），目录 1.6MB，**无引擎二进制**（`.exe` 命中 0，G5/C8）。
- **路径重写**：**82 处 / 17 个文件**（`$DSH_HOME/skills/impeccable/scripts` 与 `.dsh/skills/impeccable/scripts` → `<skill-base-dir>/scripts`），逐条记在 `skills/impeccable/MODIFICATIONS.md`；落地后 `$DSH_HOME` 残留命中 **0**。
- **可复现（代替 git diff，因仓库尚未 init）**：逐文件 sha256 对照「上游本机副本 + 仅两处前缀重写」→ **0 差异**；连跑两次 sync，快照清单指纹（59 行 sha256 的 sha256）恒为 `c2f3c2e0dba012fbb7de407e35f9510d4f52a9224d37281d5ce4fd2736b5e9da`。
- **lock 填实**：`commit=b7a89176e4e87422b40f98adabceb051dbb5448b`（`git ls-remote` 实测的 main HEAD，与任务书给的一致）、`fetchedAt=2026-10-31T10:50:20.828Z`、`tarballSha256=176f5ea798fd77ab26187630d3066d90acbff34d75073166ac8c7bc4145bf91e`；`skillVersion=engineVersion=0.1.18`、`cliVersion=4.8.0`。
- **AC6 离线分支**：`node scripts/check-upstream.mjs` → `✓ 已是最新：包内快照 0.1.18 与 lock 一致。`（不再打印「快照未落地」）
- **provider 生效**：`list()` 返回 **1 条**（`impeccable` / `provider=dsh-impeccable-hook` / `path=…\skills\impeccable\SKILL.md`），`get()` 返回正文 **11068 字节**，`resourceBase={kind:'directory',path:…\skills\impeccable}`。
- **AC1**：`/impeccable-hook status` 打印 `…\dsh-impeccable-hook\skills\impeccable\SKILL.md` + `与包内路径 一致 ✓`。
- **整链真机复跑**（全新工程目录 + 全新 session）：首次注入 **55ms**（<200ms，AC4）、`additionalContexts[0]` 是 UserMessage、`[impeccable@1] … hero.html (1 issue(s))` + `- [gradient-text] …`、1251 字符；第二次 `contexts=0`、`result=dedup`、27ms（AC5）。
- **深度体检接上了**：`status` 现在多打一行 `深度体检 engine-probe 自报 0.1.18（钉死 0.1.18，一致）`——`probeEngineVersion` 从「生产不可达」变成 status 的真实调用方（评审 N2）。

**N3（t12）**：写工具自身失败（`result.isError === true`，权限/路径不存在/编辑冲突）时在 `tools/post-execute` 入口直接放行——不提取路径、不 locate、不调引擎，与白名单外扩展名同等零开销（对「没写成功的东西」报 findings 是误导）；该跳过计入独立计数 `errorSkip`，`status` 与 `log` 里显示为「写失败跳过」，不混进 `extSkip`。

## 七、t9 修正：C11 落点与 AC5 取证归因（设计文档 v0.2.2）

本轮不采信任何转述，下面每条都是 t9 在本机重新 `ls` / `head` 出来的。

### 1. C11 更正：引擎持久状态**两处**，`config.json` 不会被跑 hook 创建

| 位置 | 实测 | 内容 |
|---|---|---|
| `~/.impeccable/hook-claims/<bucket>/<hash>` | 存在，7 个 claim 文件（`2989073/` 4 个、`2989074/` 3 个，mtime 19:01） | 引擎侧 **跨进程** claim 抑制 |
| `~/.impeccable/hook-sessions/<sessionHash>/<fileHash>` | 存在，7 个 session 目录（mtime 19:05） | 每个文件内容就是工程绝对路径，如 `D:\2026_project\00_scm\.tmp-t4\proj-ac` |
| 工程内 `.impeccable/hook.cache.json` | 存在：`.tmp-t4/proj/…` 230B（17:44，`test-sess-1`）、`.tmp-t4/proj-ac-1793440439568/…` 310B（17:53） | `{"version":1,"sessions":{…"files":{…"editCount":2,"findings":[…]}}}` |
| 工程内 `.impeccable/audit.ndjson` | 存在，一行一次 `PostToolUse`（含 `cwd`/`session`/`findings`/`freshFindings`/`emitted`/`durationMs`） | 引擎审计流 |
| 工程内 `.impeccable/config.json` | **不存在**（上述两目录只有 `hook.cache.json` 与 `audit.ndjson`） | **跑 hook 不创建 config.json** |

结论：v0.2 的 C11 把「项目内 `config.json` + `hook.cache.json`」并列为引擎写入物——**`config.json` 那半是错的**，且漏掉了 `~/.impeccable/` 这层全局 claim 状态。v0.2.2 已按上表改写。

> 与评审 N5 的差异如实说明：N5 说「项目内 tmp 目录没有创建 `.impeccable`」，而 t9 在两个真实演示工程里都看到了 `hook.cache.json`。两者不矛盾——工程内缓存只在**该工程目录下的真实 hook 调用**后出现，`bin/` 与 claim 状态则始终在 `~/.impeccable/`。以本表实测为准。

### 2. AC5 更正：两条独立防线，别再混归因

- **防线①（引擎侧、跨进程）**：真机第二轮 `findings=0`、`contexts=0` —— 是 `~/.impeccable/hook-claims` + `hook-sessions` 把重复压住了，**与插件去重无关**。
- **防线②（插件侧、进程内）**：`lib/hook.js:385` 的 `` `${filePath}::${item.antipattern}` `` 指纹，命中即 `dedup+1` 并 `result='dedup'`；由 `test/hook.test.mjs` 两条用例 + 评审独立脚本（20 条 findings 四轮注入 **8/8/4/0**、`dedup=20`、条数配额第 40 条停）证明。

因此 AC5 的「通过」是**两条防线各自有证据**，不是「某一层真机观察」冒充全部。

### 3. 本轮基线复跑（t9 自跑；下块数字为 v0.2.2 当时快照，最终态以 §三 的 92 为准）

```
$ npm test                     # tests 91 / pass 91 / fail 0 / skipped 0 / todo 0，662ms，exit 0
$ node scripts/check-upstream.mjs
[check-upstream] 包内快照：skill 0.1.18
[check-upstream] ✓ 已是最新：包内快照 0.1.18 与 lock 一致。        # exit 0
$ node --check lib/{hook,engine,commands,index,config,log,version}.js   # 全过
```

AC1–AC10 的最终判定与证据层级见设计文档 §9.2 与 `docs/completion-summary.md`。

## 八、t13 之后的 lock 事实（覆盖 §六 里的旧值）

第二轮评审 R2-2 指出：§六 记录的 `tarballSha256` 取自**移动 ref**（`refs/heads/main`）的 tarball，上游分支一前进就不可复算。t13 已改为先解 commit、再按 commit URL 取包：

| 字段 | 现值 |
|---|---|
| `commit` | `b7a89176e4e87422b40f98adabceb051dbb5448b`（`git ls-remote` 解出的 main HEAD） |
| `tarballSource` | `https://codeload.github.com/pbakaus/impeccable/tar.gz/b7a89176…5448b`（**钉 commit 不钉分支**） |
| `tarballSha256` | `0af11ea7f3d0accd91ea7c52bbe53e4e01c6a9505693617e9ac2c676767557ba`（commit 版；旧的 `176f5ea7…` 分支版作废） |
| `fetchedAt` | `2026-10-31T11:20:42.894Z` |

同步副作用：`sync-upstream.mjs` 在拿不到 commit 时 **fail closed**（宁可失败也不写分支快照）；`skills/impeccable/MODIFICATIONS.md` 的规则清单改为全量遍历（命中 0 处也照实写）；`.github/workflows/verify.yml` 增加守卫——`tarballSource` 必须含 commit、不许含 `refs/heads`。快照内容零变化（逐文件 sha256 对照 0 差异，指纹仍 `c2f3c2e0…`）。

## 九、推送后 AC7 实测（2026-10-31，GitHub 形态）

| # | 动作 | 实测结果 |
|---|---|---|
| 1 | `git push` 到 `github.com/zxhbloomer/dsh-impeccable-hook`（public，默认分支 `main`） | 提交 `f4400dc`；远端 83 个 blob |
| 2 | 干净 clone 后**不装依赖**直接 `npm test` | `tests 92 / pass 92 / fail 0 / skipped 0`，662ms（插件零运行时依赖，`prepare` 不存在 ⇒ GitHub 安装不触发任何构建） |
| 3 | 隔离 `DSH_HOME` 下 `dsh plugin --profile ac7 add github:zxhbloomer/dsh-impeccable-hook` | exit 0，14.4s；pnpm 拉 `codeload.github.com/…/tar.gz/f4400dc…`，装成 `dsh-impeccable-hook 0.1.0` |
| 4 | 检查 profile 登记 | `dependencies` = `github:zxhbloomer/dsh-impeccable-hook`；`dsh.profile.bundles` = `["@deepseek-ai/dsh-base","dsh-impeccable-hook"]` |
| 5 | `dsh --profile ac7 --dump-config` | 第 363–365 行渲染出 `# == dsh-impeccable-hook` / `- id: dsh-impeccable-hook` |
| 6 | 检查包内容 | `skills/impeccable` 59 文件随包落地；`deps: {}`、`scripts` 只有 `test` |

安装时 pnpm 打印一行 `Agent skills awaiting approval: dsh-impeccable-hook@https://codeload.github.com/…`（pnpm 12 对“随包分发 agent skill 的第三方包”的信任提示）。实测**不阻断**安装与 bundle 登记；若用户希望消掉该提示，可在该 profile 目录执行 `pnpm approve`。此现象已写入 README §安装注意事项。

**仍未做的（不变）**：AC1 第④层（桌面端手敲 `/impeccable-hook status`）、AC10 第④层（破坏签名看启动 warning）、`findPluginEntry` 的 `options.name` 端到端 —— 三项都需要真实凭据的桌面会话。
