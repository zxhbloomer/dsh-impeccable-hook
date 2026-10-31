# dsh-impeccable-hook 交付总账（t9 / S9）

- 生成时间：2026-10-31（Asia/Hong_Kong）
- 对应设计文档：`docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md`（**v0.2.3**）
- 包版本：`dsh-impeccable-hook@0.1.0`（本地目录，**尚未 git init / 未推送 GitHub**）
- 一句话结论：**功能与合规均已交付，两轮代码评审通过（第二轮 pass）；AC10 条里 8 条已通过、AC7 待推送后人工、AC1/AC10 的「桌面端手敲」这一层待人工；没有任何一项把未执行的证据写成已通过。**

---

## 一、交付物清单

| 类别 | 文件 | 规模 | 说明 |
|---|---|---|---|
| 入口 | `package.json` | 796B | `type:module`、`main:lib/index.js`、`license:Apache-2.0`、`dsh.bundle.patch`、`files` 含 lib/skills/scripts/LICENSE/NOTICE.md/README.md |
| | `cordis.patch.yml` | 665B | 单行 insert，`id`=`name`=`dsh-impeccable-hook`，含 config 段（`hook.enabled` 等） |
| 实现 | `lib/index.js` | 244 行 | 组合根：注册 skill provider + `tools/post-execute` 监听 + 命令 + 启动自检 |
| | `lib/hook.js` | 539 行 | 路径提取 → 白名单 → 调引擎 → top-N/配额/指纹去重 → `additionalContexts`；含 `isError` 写失败闸门 |
| | `lib/engine.js` | 626 行 | **三级**定位、版本读取（读 `scripts/VERSION`，不信 `--version`）、按需下载 + sha256、子进程封装 |
| | `lib/commands.js` | 515 行 | `/impeccable-hook` 的 `status`（默认）/`on`/`off`/`log` 四动作渲染与执行 |
| | `lib/config.js` | 130 行 | 配置归一化与钳制（topN 8 / 条数 40 / 字符 12000 / 超时 3000ms） |
| | `lib/log.js` | 199 行 | 进程内环形日志 + status 计数（calls/injections/findings/chars/dedup/quota/extSkip/errorSkip） |
| | `lib/version.js` | 190 行 | 读 lock 与本机版本，产生漂移提示（**离线**） |
| skill | `skills/impeccable/` | **59 文件 / 1.6MB** | 上游 `pbakaus/impeccable@b7a8917` 的 `.dsh/skills/impeccable` 副本 + `MODIFICATIONS.md`；**无引擎二进制**（`.exe` 命中 0） |
| 脚本 | `scripts/sync-upstream.mjs` | 376 行 | 拉 tarball → 校验 → 覆盖 `skills/` → 重写脚本路径前缀 → 更新 lock |
| | `scripts/check-upstream.mjs` | 159 行 | 离线/`--online` 巡检，**退出码恒 0**（AC6） |
| 出生证明 | `upstream.lock.json` | 697B | commit `b7a89176…5448b`、fetchedAt `2026-10-31T11:20:42.894Z`、`tarballSha256 0af11ea7…557ba`、`tarballSource …/tar.gz/<commit>`（**钉 commit 不钉分支**，可随时复算）、skill/engine `0.1.18`、cli `4.8.0` |
| 合规 | `LICENSE` | 10.8KB | Apache-2.0 全文，**与上游逐字节相同** |
| | `NOTICE.md` | 1.8KB | 逐字保留上游 NOTICE（503B / sha256 `c60a093c…dcb`）+ 非官方与非官方分发声明 |
| | `README.md` | 16.2KB | 中文 8 章：参考项目 / 做什么与不做什么 / 安装 / 命令与参数 / 三级降级 / 配置与文件位置 / 排错 / 非官方与许可 |
| 测试 | `test/{engine,hook,plugin}.test.mjs` | 384 + 593 + 581 行 | **92 用例，0 skip**（24 / 40 / 28） |
| 文档 | `docs/acceptance-evidence.md` | — | AC1–AC10 证据表 + §七（本轮 C11 / AC5 修正） |
| | `docs/code-review-S2-S6.md` | — | 第一轮评审：needs_revision，2 blocking（B1/B2）+ N1–N6 |
| | `docs/code-review-round2.md` | — | 第二轮评审：**pass**，残留 R2-1…R2-4（均 non-blocking） |
| | `docs/completion-summary.md` | — | 本文件 |

**没有创建**（设计文档 §5 明确排除）：`src/`、`build.mjs`、`tsconfig.json`、`lib/client.js`、任何 React 文件、`.github/workflows/upstream-check.yml`（CI 巡检推迟 v1.1，N6）。

---

## 二、AC1–AC10 判定总表

层级：① 单测 ② 真机链路 ③ 命令输出 ④ **人工**（本轮未执行）。

| AC | 判据摘要 | 结论 | 层级 | 关键证据 |
|---|---|---|---|---|
| AC1 | status 打印实际解析到的 SKILL.md 绝对路径且等于包内路径 | **通过（代码/真机 status）｜④待人工** | ①②③+④ | `test/plugin.test.mjs` AC1 用例；真机 status 打印 `<pkg>\skills\impeccable\SKILL.md` 与「与包内路径 一致 ✓」，路径取自 `ctx.skills.get` 而非自拼 |
| AC2 | 改含渐变文字的 .html → 下一轮出现 `[impeccable@1]` 与 `gradient-text` | **通过** | ② | 真机整链：`additionalContexts[0].role='user'`、`[impeccable@1] … hero.html (1 issue(s))`、`- [gradient-text] …`、1251 字符 |
| AC3 | 引擎缺失时静默关闭、不报错、status 写原因 | **通过** | ①② | `test/hook.test.mjs`「AC3：引擎不可用时静默跳过并记原因，绝不抛错」；整链 `fetch` 调用数 0；真机 status 打三级失败原因 |
| AC4 | 单次 hook < 200ms，超时不抛 | **通过** | ② | 最近真机首轮 **55ms**（历史 31–38ms / 评审亲测 43ms）；超时路径单测不抛 |
| AC5 | 同文件同问题第二次不重复注入 | **通过（两条防线）** | ①② | 防线①引擎侧跨进程 claim（真机第二轮 `findings=0`）；防线②插件侧 `文件::规则` 指纹（单测 + 评审脚本 8/8/4/0、`dedup=20`、配额停 40） |
| AC6 | `check-upstream.mjs` exit 0 且输出「已是最新」 | **通过** | ③ | 离线 `exit 0` + 「✓ 已是最新：包内快照 0.1.18 与 lock 一致。」；`--online` 亦 exit 0 |
| AC7 | 干净 clone 后 `dsh plugin add github:…` 能装上生效 | **通过（GitHub 形态已实测）** | ①③ | 干净 clone 不装依赖 `npm test` 92/92；隔离 `DSH_HOME` 下 `dsh plugin --profile ac7 add github:zxhbloomer/dsh-impeccable-hook` exit 0 / 14.4s / 装成 0.1.0；`bundles` 自动登记；`--dump-config` 渲染插件层 |
| AC8 | 非白名单文件（.md/.java）hook 完全不被调用 | **通过** | ① | 扩展名在 `locateEngine` 之前放行：`locate.calls=0`、`engine.calls=0`、`extSkip+1`；`.md` 整链连 `engine.js` 都不进 |
| AC9 | 20+ findings 只注入 ≤ top-N，计数一致 | **通过** | ① | 20 条 → 注入 8 条且计数一致；条数配额停 40；字符配额用例 |
| AC10 | 破坏事件签名时启动自检失败且可见 | **通过（单测）｜④待人工** | ①+④ | 3 条单测（下游判定被改写 / 拿不到事件总线 / 启动 warning 恰好 1 行）；桌面端肉眼确认启动 warning 未执行 |

> **判读纪律**：AC1/AC10 的「通过」限定在 ①②；第 ④ 层「桌面端手敲 `/impeccable-hook status`」未执行，因此这两条同时标「④待人工」，README 与 status 文案也不声称已完成人工验证。

---

## 三、关键实现事实（都可复算）

| 事实 | 值 / 证据 |
|---|---|
| 测试 | `npm test` ⇒ tests **92** / pass 92 / fail 0 / skipped 0 / todo 0，exit 0（24 engine + 40 hook + 28 plugin） |
| 语法闸门 | 12 个 `lib/*.js`、`scripts/*.mjs`、`test/*.mjs` 全部 `node --check` 通过（与 `verify.yml` 同一闸门） |
| 引擎降级 | **三级**：① 用户级 `$DSH_HOME/skills/impeccable/scripts/bin/<os>-<arch>/` ② `~/.impeccable/bin/<engineVersion>/` ③ 官方 release 下载（sha256 校验）。全失败 ⇒ skill 照常可用、hook 静默关、status 写原因 |
| 下载纪律（D12） | hook 热路径**只定位**：`grep allowDownload lib/hook.js lib/index.js` 零命中；整链用例把 `globalThis.fetch` 换成计数即抛的实现，断言 `fetch=0` |
| 版本钉死 | `upstream.lock.json` 的 `engineVersion` 0.1.18；`status` 打「深度体检 engine-probe 自报 0.1.18（钉死 0.1.18，一致）」 |
| 快照可复现 | 连跑两次 `sync-upstream.mjs`，59 行 sha256 的指纹恒为 `c2f3c2e0dba012fbb7de407e35f9510d4f52a9224d37281d5ce4fd2736b5e9da`；路径重写 82 处 / 17 文件 |
| 注入治理 | top-N 8 + 会话 40 条 + 12000 字符 + `文件::规则` 指纹去重，全部落到 status 计数 |
| 引擎持久状态 | 工程内 `.impeccable/hook.cache.json` + `audit.ndjson`；全局 `~/.impeccable/hook-claims`、`hook-sessions`；**`.impeccable/config.json` 只读、不会被跑 hook 创建**（C11 v0.2.2 修正） |
| 写失败闸门（N3） | `lib/hook.js` 中 `result?.isError === true` 在取路径**之前** `return next()`，`next()` 仍恰好一次；计入 `errorSkip`，status 显示「写失败跳过」 |

---

## 四、残留问题（下表为 v0.2.2 时的**历史快照**，四条已于 v0.2.3 全部关闭）

> **处置结果（v0.2.3，t13 / t14）**：R2-1（注释）✅ 已改；R2-2（lock 钉分支）✅ 已改为 commit URL `tarballSource …/tar.gz/<commit>` + `tarballSha256 0af11ea7…557ba`，且 sync 拿不到 commit 时 **fail closed**；R2-3（MODIFICATIONS 漏写命中 0 处）✅ 已由 `writeModifications` 全量列 REWRITES 根治（不是手改）；R2-4（deferContext 双通道）✅ README §7.5「已知盲区」已如实写明。**仅 N6 仍按原计划推迟 v1.1。** 下表保留原样以便追溯评审原文。

| ID | 严重度 | 位置 | 问题 | 建议改法 |
|---|---|---|---|---|
| R2-1 | low | `lib/engine.js:229` | 注释仍写「只在 `verify:'probe'` 或 status 深度体检时用」，而 `verify` 选项已删 | 改为「只在 `/impeccable-hook status` 的深度体检里用」 |
| R2-2 | low | `upstream.lock.json` | `tarballSha256` 钉的是**移动 ref**（`refs/heads/main`）的 tarball 哈希，非 commit URL 的（同一 commit 的 commit-URL 为 `0af11ea7…`）| 补 `tarballSource: "refs/heads/main"`，或改记 commit-URL 哈希 |
| R2-3 | low | `skills/impeccable/MODIFICATIONS.md` | 只列了命中 82 处的 `relative-dsh-scripts`，未说明第二条规则 `dsh-home-scripts` 命中 **0 处** | 补一行说明 |
| R2-4 | info | `lib/hook.js` 合并路径 | 工具自身 `deferContext()` 与我们的注入理论上可能在 result/decision 两侧各存一份（真机与测试均未观察到重复）| 无需改；README「已知盲区」补一句 |
| N6 | low | `lib/config.js` | `maxCharsPerSession=12000` 在默认 40 条下不可达（40 条 ≈1.6k 字符）| 注释说明「仅在放大条数配额时有意义」 |

---

## 五、阻塞与人工项清单

| 项 | 状态 | 触发条件 / 责任 |
|---|---|---|
| LICENSE / NOTICE.md / 中文 README（原 B2 阻塞） | ✅ 已完成（t8），阻塞解除 | — |
| skill 快照落地 + lock 填实（原 B1 阻塞） | ✅ 已完成（t10），阻塞解除 | — |
| `git init` 与推 GitHub | ✅ 已完成（2026-10-31） | public 仓库 `github.com/zxhbloomer/dsh-impeccable-hook`，首个提交 `f4400dc`，默认分支 `main` |
| AC7：推后用**干净 profile** `dsh plugin add github:…` | ✅ 已完成 | 隔离 `DSH_HOME` + `github:` spec 真装成功，详见 `acceptance-evidence.md` §九 |
| `.github/workflows/verify.yml` **未入库** | ⚠️ 待补推 | 当前 `gh` OAuth token 只有 `gist/read:org/repo`，缺 `workflow` scope，GitHub 拒收工作流文件；文件已在本地工作区，执行 `gh auth refresh -s workflow` 后补推即可 |
| AC1 第④层：桌面端手敲 `/impeccable-hook status`，肉眼确认「实际路径 = 包内路径」与注入计数 | ⬜ 待人工 | 用户执行（headless 会话无命令回显） |
| AC10 第④层：破坏 `tools/post-execute` 签名后，启动时看到那行 warning | ⬜ 待人工 | 可与上一条同场做 |
| `findPluginEntry` 的 `options.name` **端到端** | ⬜ 无法实测 | 本 profile 未安装本插件（`Config` provider `entries` 为空）；装插件后 `on`/`off` 顺手验一次真持久化 |

---

## 六、复现命令

```bash
cd D:/2026_project/99_dsh/dsh-impeccable-hook

npm test                                  # tests 92 / pass 92 / fail 0 / skipped 0，exit 0
node scripts/check-upstream.mjs           # exit 0，「✓ 已是最新：包内快照 0.1.18 与 lock 一致。」
node scripts/check-upstream.mjs --online  # exit 0，比对上游 main
node --check lib/*.js scripts/*.mjs test/*.mjs   # 语法闸门全过
```

演示「首次注入」必须**每次用全新工程目录 + 全新 session id**——否则引擎侧的 `~/.impeccable/hook-claims` 与工程内 `hook.cache.json` 会压住重复注入（这不是 bug，是防线①）。

---

## 七、评审与变更历史

| 轮次 | 文档 | 结论 | 处置 |
|---|---|---|---|
| 设计评审 | 设计文档 v0.1 → v0.2 | 采纳 12 条维护者/使用者意见 + 3 条契约复核修正 | C2 `UserMessage[]`、C4 rank 同层、C3 `exec.signal`、top-N/配额（D9）、注入日志（D10）、启动自检（D11）、下载时机（D12） |
| 第一轮代码评审 | `docs/code-review-S2-S6.md` | **needs_revision** | B1 skill 快照未落地、B2 缺 LICENSE/NOTICE（均阻断发布）；N1–N6 非阻断 |
| 修复 | t10 + t12 | B1/B2 关闭 | 快照 59 文件落地、lock 三字段填真值、`ensureEngine`/`ENGINE_LEVELS` 死代码清理、`findPluginEntry` 规范化、N3 写失败闸门 |
| 第二轮代码评审 | `docs/code-review-round2.md` | **pass** | 7 项复核全过；残留 R2-1…R2-4 均 non-blocking；放行 t8/t9 与推 GitHub |
| 验收回写 | 本文件 + 设计文档 v0.2.2 + `acceptance-evidence.md` §七 | — | §9 扩为「判据 + 四层证据」、AC5 改两条防线、C11 落点修正、补登三份评审/证据文档 |

---

## 八、下一步建议（等用户指令，本任务不执行）

1. 用户点头后 `git init` + 首次提交 + 推 `github.com/zxhbloomer/dsh-impeccable-hook`；
2. 推送后在**干净 profile** 跑一次 AC7，回填 §9.2；
3. 桌面端手敲 `/impeccable-hook status` 与破坏签名场景，补齐 AC1/AC10 第④层；
4. 顺手收敛 R2-1…R2-4（纯注释/字段/文档，不改行为）。
