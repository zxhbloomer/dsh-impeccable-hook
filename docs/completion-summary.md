# dsh-impeccable-hook 交付总账（t9 / S9）

- 生成时间：2026-10-31（Asia/Hong_Kong）
- 对应设计文档：`docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md`（**v0.3**）
- 包版本：`dsh-impeccable-hook@0.1.0`（已推 `github.com/zxhbloomer/dsh-impeccable-hook`，见 §五）
- 一句话结论：**功能与合规均已交付，两轮代码评审通过（第二轮 pass）；v0.3 把引擎收敛为两级 + 装完即用，AC1–AC10 里 8 条已通过、AC7 已实测、AC1/AC10 的「桌面端手敲」这一层待人工；AC11–AC13 目前只有单测/静态证据，真机待人工确认（清单见 §八）；没有任何一项把未执行的证据写成已通过。**

---

## 一、交付物清单

| 类别 | 文件 | 规模 | 说明 |
|---|---|---|---|
| 入口 | `package.json` | 796B | `type:module`、`main:lib/index.js`、`license:Apache-2.0`、`dsh.bundle.patch`、`files` 含 lib/skills/scripts/LICENSE/NOTICE.md/README.md |
| | `cordis.patch.yml` | 665B | 单行 insert，`id`=`name`=`dsh-impeccable-hook`，含 config 段（`hook.enabled` 等） |
| 实现 | `lib/index.js` | 244 行 | 组合根：注册 skill provider + `tools/post-execute` 监听 + 命令 + 启动自检 |
| | `lib/hook.js` | 539 行 | 路径提取 → 白名单 → 调引擎 → top-N/配额/指纹去重 → `additionalContexts`；含 `isError` 写失败闸门 |
| | `lib/engine.js` | — | **两级**定位（①`~/.impeccable/bin/<engineVersion>/` 共用缓存 ②官方 Release 下载）、版本读取（读 `scripts/VERSION`，不信 `--version`）、`ensureEngine`（启动期单次、并发复用同一 Promise、任一失败清 `.part`）、按需下载 + sha256 + 原子 rename、子进程封装 |
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
| | `README.md` | 16.2KB | 中文 8 章：参考项目 / 做什么与不做什么 / 安装（含「装完即用：skill 与引擎都由本插件备齐」） / 命令与参数 / **引擎两级降级** / 配置与文件位置 / 排错 / 非官方与许可 |
| 测试 | `test/{engine,hook,plugin}.test.mjs` | — | **v0.3 最终态 105 用例，0 skip**（28 / 40 / 37） |
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
| AC3 | 引擎缺失时静默关闭、不报错、status 写原因 | **通过** | ①② | `test/hook.test.mjs`「AC3：引擎不可用时静默跳过并记原因，绝不抛错」；整链 `fetch` 调用数 0；真机 status 打**两级**失败原因（v0.3 口径，见 `acceptance-evidence.md` §二B） |
| AC4 | 单次 hook < 200ms，超时不抛 | **通过（v0.3 重录）** | ② | v0.2.1 的 55ms 随 level① 删除作废；**两级重录：真机 `locateEngine` 首调 36ms、整链首次注入 74ms、第二轮 31ms**；超时路径单测不抛。时间窗：首次启动的后台下载未完成时首轮报 `no-engine`（不注入、不计入） |
| AC5 | 同文件同问题第二次不重复注入 | **通过（两条防线）** | ①② | 防线①引擎侧跨进程 claim（真机第二轮 `findings=0`）；防线②插件侧 `文件::规则` 指纹（单测 + 评审脚本 8/8/4/0、`dedup=20`、配额停 40） |
| AC6 | `check-upstream.mjs` exit 0 且输出「已是最新」 | **通过** | ③ | 离线 `exit 0` + 「✓ 已是最新：包内快照 0.1.18 与 lock 一致。」；`--online` 亦 exit 0 |
| AC7 | 干净 clone 后 `dsh plugin add github:…` 能装上生效 | **通过（GitHub 形态已实测）** | ①③ | 干净 clone 不装依赖 `npm test` **当时 92/92**（v0.3 已 105/105）；隔离 `DSH_HOME` 下 `dsh plugin --profile ac7 add github:zxhbloomer/dsh-impeccable-hook` exit 0 / 14.4s / 装成 0.1.0；`bundles` 自动登记；`--dump-config` 渲染插件层 |
| AC8 | 非白名单文件（.md/.java）hook 完全不被调用 | **通过** | ① | 扩展名在 `locateEngine` 之前放行：`locate.calls=0`、`engine.calls=0`、`extSkip+1`；`.md` 整链连 `engine.js` 都不进 |
| AC9 | 20+ findings 只注入 ≤ top-N，计数一致 | **通过** | ① | 20 条 → 注入 8 条且计数一致；条数配额停 40；字符配额用例 |
| AC10 | 破坏事件签名时启动自检失败且可见 | **通过（单测）｜④待人工** | ①+④ | 3 条单测（下游判定被改写 / 拿不到事件总线 / 启动 warning 恰好 1 行）；桌面端肉眼确认启动 warning 未执行 |

> **判读纪律**：AC1/AC10 的「通过」限定在 ①②；第 ④ 层「桌面端手敲 `/impeccable-hook status`」未执行，因此这两条同时标「④待人工」，README 与 status 文案也不声称已完成人工验证。

---

## 三、关键实现事实（都可复算）

| 事实 | 值 / 证据 |
|---|---|
| 测试 | `npm test` ⇒ **v0.3 最终态 tests 105** / pass 105 / fail 0 / skipped 0 / todo 0，exit 0（28 engine + 40 hook + 37 plugin） |
| 语法闸门 | 12 个 `lib/*.js`、`scripts/*.mjs`、`test/*.mjs` 全部 `node --check` 通过（与 `verify.yml` 同一闸门） |
| 引擎降级 | **两级**（v0.3）：① `~/.impeccable/bin/<engineVersion>/impeccable[.exe]` 共用缓存（摘要不符跳过该级）② 官方 Release 下载（仅 `allowDownload:true` 触发，sha256 校验 + 原子 rename）。全失败 ⇒ skill 照常可用、hook 静默关、status 逐级写原因 |
| 下载纪律（D12，**限定热路径**） | **hook 热路径**只定位：`grep -n allowDownload lib/hook.js` 零命中、`grep -n ensureEngine lib/hook.js` 零命中；整链用例把 `globalThis.fetch` 换成计数即抛的实现，断言 `fetch=0`。**会联网的只有两处**：启动期 `ensureEngine`（`hook.autoDownload`，默认开、单次、失败只 warning 不重试不抛错、清 `.part`）与显式 `/impeccable-hook status download` |
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
| `.github/workflows/verify.yml` | ✅ 已入库（a20de38） | 用户补 `workflow` scope 后推送成功；首跑即暴露一个真实缺陷（见下） |
| CI 首跑失败：`Cannot find module …/test` | ✅ 已修 | 根因 `scripts.test = "node --test test/"` 的**目录参数**在本机 node 26 可行、在 CI 的 node 22 不认；改为 `node --test`（自动发现），当时本地 92/92 不变（v0.3 已 105/105） |
| CI 复跑结果 | ✅ **通过**（`aa6adff`，19s，ubuntu + windows 双平台，run 41200064959） |
| AC1 第④层：桌面端手敲 `/impeccable-hook status`，肉眼确认「实际路径 = 包内路径」与注入计数 | ⬜ 待人工 | 用户执行（headless 会话无命令回显） |
| AC10 第④层：破坏 `tools/post-execute` 签名后，启动时看到那行 warning | ⬜ 待人工 | 可与上一条同场做 |
| `findPluginEntry` 的 `options.name` **端到端** | ⬜ 无法实测 | 本 profile 未安装本插件（`Config` provider `entries` 为空）；装插件后 `on`/`off` 顺手验一次真持久化 |
| **AC11**（v0.3）清空 `~/.impeccable/bin/0.1.18/` 后首启自动重新就位 | ⬜ 待人工 | 单测覆盖「默认开→启动触发一次 / 并发只一次 / 失败不抛错清 `.part`」；真机动作未做（实现者无桌面凭据）。复验：`ls ~/.impeccable/bin/0.1.18/` 应见 `impeccable.exe` + `.verified` |
| **AC12**（v0.3）断网首启不炸、只 warning | ⬜ 待人工 | 单测覆盖失败不抛错；真机断网未做。复验：断网后 `/impeccable-hook status`、`/impeccable-hook log 20` |
| **AC13**（v0.3）桌面手敲 `on`/`off` 并落盘 | ⬜ 待人工 | 4 条单测已覆盖（含缺 `configEditor` 的 `kind=error` 降级）；真机命令未敲过 |

---

## 六、复现命令

```bash
cd D:/2026_project/99_dsh/dsh-impeccable-hook

npm test                                  # v0.3：tests 105 / pass 105 / fail 0 / skipped 0，exit 0
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
| 第三轮：v0.3 计划评审 | `docs/code-review-v0.3-plan.md` | **needs_revision** | B1 取消「缓存改名」（必须保持 `~/.impeccable`，否则 launcher 与本插件各下一份）；B2 `autoDownload` 语义（模块级单次、显式传 log、失败清 `.part`、测试改「仅热路径 fetch=0」）；B3 `getService` 走 `ctx.get`、`configEditor` 不进 inject；N1–N5 文档口径 |
| v0.3 实现 | t15 / t16 / t17 | 完成 | 删 level① → **两级**；`ensureEngine` 启动期单次异步 + 失败只 warning；`verified` 三态；`on/off` 改走 `ctx.get` 修掉真机「service 不可用」；测试 92 → **105**（t17 后 104，t20 清理后 105） |
| v0.3 文档口径收口 | t18（本轮） | — | README 引擎表改两级 + 新增「装完即用」；`acceptance-evidence.md` 补 AC11–AC15、AC4 旧证据作废重录；「allowDownload 零命中」限定为**仅热路径**；`MODIFICATIONS.md` 补引擎缓存位置说明 |

---

## 八、v0.3 增量：引擎自给自足（t15 / t16 / t17，评审 t19，清理 t20）

> 触发原因：用户删掉了自己手装的上游 skill 目录（`$DSH_HOME/skills/impeccable`，59 文件），旧的第一优先级引擎来源随之消失，插件被要求「装完即用、不依赖用户另外装任何东西」。

| 改动 | 结论 | 证据 |
|---|---|---|
| 引擎收敛为**两级** | level① 删除；LEVEL_LABEL 只剩 `user-cache`（①共用缓存 `~/.impeccable`）与 `download`（②官方 Release） | `lib/engine.js`；`test/engine.test.mjs` 断言 LEVEL_LABEL 形状；`status` 文案「未找到（两级降级全部失败）」 |
| **装完即用**：首次启动自动备齐引擎 | `lib/index.js` 在 `apply()` 后 `void ensureEngine({...})`：**不 await、不阻塞启动**；模块级单次（并发/重复加载复用同一 Promise，绝不下一份） | `test/plugin.test.mjs`「autoDownload 默认开 → 启动触发一次」「并发只下一次」「失败不抛错且清 `.part`」 |
| 自动下载的失败语义 | 只打**一行 warning**，**不重试、不抛错**（A1：hook 必须永远活着）；`log` 里可见「两级引擎链全部失败…hook 静默关闭」，`status` 给逐级原因 + `status download` 兜底 | 同上单测；README §3「装完即用」如实写明 |
| 开关 `hook.autoDownload` | 默认 `true`；显式 `false`/`'false'`/`0` 才算关；关掉只影响自动补引擎 | `lib/config.js` DEFAULT_CONFIG 与 normalizeConfig |
| `verified` **三态**（不是两态） | `true` 摘要与清单一致；**`null` 是真实第三态**（清单未收录该版本/平台、二进制读不动、上游没发对应资产）→ status 显示「摘要校验 …未收录」并给逐级原因；`false` **不可达**（摘要不符直接跳过该级） | `test/plugin.test.mjs`「D：verified=null 由真实 resolveEngine 产出」 |
| `/impeccable-hook on` `off` 修复 | 正常：`kind=success`、开关热切换并写回 profile；**拿不到 `configEditor` 时 `kind=error`，但开关仍在本会话生效**，文案明说「没能持久化，请手动改 profile 里本插件的 config 段（通常是 cordis.patch.yml 的 config 段）」 | t17 修的真实缺陷：旧实现未把 `configEditor` 放进 inject，真机 `on` 直接报 service 不可用；现 4 条单测（含 Proxy 契约与两种降级文案） |
| 测试 | **105 / 105 全绿、0 skip**（28 engine + 40 hook + 37 plugin） | `npm test` exit 0 |

**第三轮代码评审通过（pass，放行 t8/t9）**：`docs/code-review-v0.3.md` —— B1（两级引擎 + 单一缓存）/ B2（启动自动补引擎）/ B3（`configEditor` 不进 inject）三条 blocking 均可复现落地；随后 **t20 清掉 3 条 non-blocking**：

| 编号 | 处置 | 结果 |
|---|---|---|
| N-1（low，真 bug） | `lib/commands.js` 新增 `normalizeForCompare`（`\`→`/`、折叠连续分隔符、win32 小写化），`samePath` 两侧归一化后比较 | 修掉「同一文件两种分隔符写法被判**不一致 ✗**」的假报与误导解释；新增用例先红（`AssertionError: 分隔符写法不同不代表不是同一份文件`）后绿 |
| N-2（low-medium，口径） | `lib/engine.js:12-14` 与 `README.md:162` 改成**两种情形分开写** | ①摘要与 `engine-checksums.txt` 不符 → 跳过该级 + 逐级原因；②自述版本 ≠ lock 钉死 → 仍可用 + status 并排两版本 + 一次 warning |
| N-3（low，死分支） | 删掉 `lib/engine.js` 两处 `verified === false` 兜底（`hit.warning ?? null`；`attemptEntry` 里整行删除） | 「命中但 `verified:false`」在 v0.3 已无生产者；`grep verified === false lib` = **0**；测试只增不减（104 → 105） |

> N-4 / N-5 为 info 级，按裁决**推迟 v1.1**，本轮不动。

**本节待人工项（未执行，不得写成已通过）**：AC11 真机「删缓存 → 自动重新就位」、AC12 真机断网首启、AC13 桌面手敲 `on|off` 并确认落盘。逐条复验命令见 `acceptance-evidence.md` §十。

---

## 九、下一步建议（等用户指令，本任务不执行）

1. 桌面端手敲 `/impeccable-hook status` 与破坏签名场景，补齐 AC1/AC10 第④层；
2. 桌面端手敲 `/impeccable-hook on|off`，补齐 AC13 并确认 profile 落盘；
3. 清缓存 + 断网各跑一次首启，补齐 AC11 / AC12；
4. 装插件后顺手验一次 `findPluginEntry` 的 `options.name` 端到端持久化。

### 技术债（v0.3 遗留，已知未还）

| # | 债务 | 影响 | 还法 |
|---|---|---|---|
| D-1 | `skills/impeccable/MODIFICATIONS.md` 里手工补的「**引擎缓存位置**」节，会在 `node scripts/sync-upstream.mjs` **整文件重写**时丢失（`writeModifications()` 只写固定模板，不读旧文件） | 下次同步上游后该节静默消失——「`~/.impeccable` 是共用缓存、不要改名」这段说明只剩 README 一处 | 二选一：①把该节并进 `scripts/sync-upstream.mjs` 的 `writeModifications()` 模板（推荐，一次做对）；②同步流程加自检：同步后 `grep "引擎缓存位置" skills/impeccable/MODIFICATIONS.md`，命中 0 就报错提醒补写 |
