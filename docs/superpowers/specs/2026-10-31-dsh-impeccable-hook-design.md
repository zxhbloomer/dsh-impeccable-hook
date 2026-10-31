# dsh-impeccable-hook 设计文档

- 版本：**v0.2.2（实施完成 + 验收回写）**
- 日期：2026-10-31
- 状态：**已实施，两轮代码评审通过；待推送 GitHub（需用户当次明确指令）**
- 变更：v0.1 → v0.2 → v0.2.1 → v0.2.2 见文末「修订记录」

---

## 1. 意图：为什么做这个

上游 `pbakaus/impeccable` 是「设计 skill + 确定性检测引擎」的组合：24 个设计命令走 `/impeccable <cmd>`，61 条 anti-pattern 规则由 `impeccable.exe` 执行。它的 **design hook** 功能是：你改完 UI 文件，钩子自动跑检测并把问题回灌给模型，模型下一轮主动修，不用你记得手动跑。

但上游 `reference/hooks.md` 只给 6 个 harness 装 hook 清单（Claude Code / Codex / Cursor / Grok Build / GitHub Copilot / Hermes），**没有 DSH**。上游 `docs/HARNESSES.md:71` 给出的原因是：

> DeepSeek Harness … Hooks are in-process plugins configured via cordis.yml, not on-disk manifests, so there is no hook surface to install.

DSH 不需要「装清单」，但有**进程内插件**能力，可以做到同一件事。本插件补这块空白。

## 2. 目标 / 非目标 / 反目标

### 目标
| 编号 | 目标 |
|---|---|
| G1 | skill 随包分发，装完 `/impeccable` 立即可用 |
| G2 | 编辑 UI 文件后自动检测，findings 回灌模型（复刻 upstream design hook） |
| G3 | 0-Token 宿主命令查看状态（引擎在不在、hook 开没开、注入过几次） |
| G4 | 版本可追溯：内置快照版本写死，上游升级能被**发现并通知**（不阻断） |
| G5 | 只走 GitHub 安装，仓库内为已构建纯 JS，零构建 |

### 非目标
| 编号 | 非目标 | 原因 |
|---|---|---|
| N1 | 不做 Web「设计」面板 | findings 已直接进模型上下文；面板是给人做设计探索用的 |
| N2 | 不编译 Rust 引擎 | 用户机器无 Rust 工具链；上游已发预编译资产 |
| N3 | 不发布 npm | 用户只要 GitHub 安装；`dsh-impeccable` 名字已被占 |
| N4 | 不改上游 skill 正文 | 只做脚本路径前缀重写 |
| N5 | 不做设计判断 | 审美是模型的活；引擎只做机械判定 |
| N6 | v1 不做每日 CI 巡检 | 无人升级时只产噪音；`upstream.lock.json` + 本地脚本已够（评审意见 1） |

### 反目标
| 编号 | 反目标 |
|---|---|
| A1 | 拖慢或打断会话 |
| A2 | 同一问题反复报、或一次灌几十条把模型淹了 |
| A3 | 上游升级后行为静默改变 |
| A4 | 与本机已有 skill 打架导致 `/impeccable` 失效 |

## 3. 约束（全部来自实测或 inspect 契约，非推断）

| 编号 | 约束 | 证据 |
|---|---|---|
| C1 | `tools/post-execute` 是 waterfall；签名 `(exec: ToolExecution, result, next) => Promise<PostToolDecision>` | `cordis_inspect_query` host/Event `tools/post-execute` 原文 |
| C2 | 回灌上下文必须放在 `PostToolDecision.additionalContexts`，类型是 **`UserMessage[]`**（不是字符串数组） | 同上，`PostToolDecision` 类型声明 |
| C3 | `exec` 携带 `name` / `arguments` / `agent?` / `signal`；异步监听器必须观察 `exec.signal` | 同上，`ToolExecutionInput` / `ToolExecution` 声明 |
| C4 | `ctx.skills.registerProvider(create)` 注册到**调用上下文的层**；同名冲突只在**同一层内**按 rank 决胜；同层重名与保留名会抛错 | `cordis_inspect_query` host/Service `skills` 原文 |
| C5 | skill summary 暴露 `path` / `provider` / `source` / `resourceBase`，可用来断言「实际加载的是哪一份」 | 同上，`SkillSummary` 声明 |
| C6 | 宿主命令（`ctx.commands.register`）不产生 model message；语法 = 行首 `/` + 小写名 + 空白后全部内容作 `rawInput` | commands 服务契约（前序取证） |
| C7 | client 端优先把 `/name` 解析为 host 命令，会抢走 `user-invocable` skill 的入口 | `dsh-client-ui-skill` README |
| C8 | 只 GitHub 安装 ⇒ 仓库必须放已构建 JS；`prepare` 会在安装时联网构建 | install-spec 实测 + 竞品实测 |
| C9 | Windows 必须传真实 win32 绝对路径；POSIX 风格路径会让引擎 hook 静默 exit 0 | 本机实测 |
| C10 | 引擎 `--version` 返回的是 **skill 版本**（4.8.0），不是引擎版本；引擎版本只能读 `scripts/VERSION` | 本机实测两次 |
| C11 | 引擎跑 hook 时会**自己写**持久状态，落在**两处**：① **工程内** `.impeccable/hook.cache.json`（`sessions → files → findings` 记忆）与 `.impeccable/audit.ndjson`（一行一次 PostToolUse 审计）；② **全局** `~/.impeccable/hook-claims/<bucket>/<hash>` 与 `~/.impeccable/hook-sessions/<sessionHash>/<fileHash>`（跨进程、跨 checkout 的 claim 抑制）。**`.impeccable/config.json` 只被读，跑 hook 不会创建它** | 本机实测（v0.2.2 修正，证据见 `docs/acceptance-evidence.md` §七；v0.2 原文误写成「项目内 `config.json` + `hook.cache.json`」） |
| C12 | 上游合规文件是 `LICENSE`（Apache-2.0 全文）+ **`NOTICE.md`**（确实存在） | `ls` 实测 |
| C13 | skill 副本里的脚本路径是渲染时写死的 `$DSH_HOME/skills/impeccable/scripts`，装到别处必须重写 | 上游 `.dsh/skills/impeccable` 是渲染产物 |

## 4. 方案（已与用户确认）

### 4.1 单包双职能（方案未变）
1. `ctx.skills.registerProvider()` —— 注册打包进来的 skill
2. `ctx.on('tools/post-execute')` —— 观测工具执行、调引擎检测、把 findings 放进 `additionalContexts`

### 4.2 引擎获取链（**三级**，评审意见 5 已删去「bin 入库」那一行）
| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | 用户级已装 `$DSH_HOME/skills/impeccable/scripts/bin/<os>-<arch>/impeccable[.exe]` | 本机现有，sha256 与上游 checksums 一致 |
| 2 | `~/.impeccable/bin/<engineVersion>/impeccable` | 上游 launcher 标准缓存位 |
| 3 | 官方下载 `https://github.com/pbakaus/impeccable/releases/download/engine-v<ver>/impeccable-<os>-<arch>[.exe]`，按 `engine-checksums.txt` 校验 sha256 | 约 20MB |
| — | 全部失败 | skill 照常可用，hook 静默关闭，`status` 说明原因 |

**下载时机（评审意见 10，已采纳）**：hook 路径**只做定位、绝不下载**；下载只发生在 `status` 命令或显式动作时，写临时文件 → 校验 sha256 → 原子 rename。

### 4.3 版本策略（**已收窄**，评审意见 1）
- `upstream.lock.json` 记录出生证明：`skillVersion` / `engineVersion` / `commit` / `fetchedAt` / `tarballSha256`。
- 引擎版本**钉死** lock 里的版本（可复现），不追随用户机器上碰巧更新的引擎。
- 检查只剩两层：

| 层 | 时机 | 行为 |
|---|---|---|
| 开发期 | 每次动代码前 | 比对上游 main，不一致就停下问用户 |
| 运行期 | 插件启动 | 不联网。仅当「本机已装 skill 版本 > 内置版本」打印一行 warning |
| ~~CI cron~~ | ~~每日~~ | **推迟 v1.1**；v1 只提供可手动跑的 `node scripts/check-upstream.mjs` |

## 5. 文件清单

```
dsh-impeccable-hook/
├─ package.json              # name=dsh-impeccable-hook；type:module；main:lib/index.js；license=Apache-2.0；
│                            # dsh.bundle.patch:./cordis.patch.yml；files 列 lib/skills/scripts/LICENSE/NOTICE.md/README
├─ cordis.patch.yml          # 一行 insert，id 与 name 均为 dsh-impeccable-hook；含 config 段（hook 开关）
├─ README.md                 # 中文：参考项目、做了什么、安装、命令与参数、排错、非官方声明
├─ LICENSE                   # Apache-2.0 全文（与上游同许可）
├─ NOTICE.md                 # 复刻上游 NOTICE.md 原文 + 声明本插件改动
├─ upstream.lock.json        # 出生证明
├─ lib/
│  ├─ index.js               # 入口：apply(ctx) → 注册 skill provider + post-execute 监听 + 命令 + 启动自检
│  ├─ engine.js              # 引擎定位（三级）、版本读取、按需下载与 sha256 校验、子进程调用封装
│  ├─ hook.js                # 提取路径 → 白名单过滤 → 调引擎 → severity top-N + 会话配额 + 去重 → 组装 additionalContexts
│  ├─ version.js             # 读 lock 与本机版本，产生漂移提示（只读文件，不联网）
│  └─ log.js                 # 注入/跳过/超时的事件记日志，供 status 汇总
├─ skills/impeccable/        # 上游 .dsh/skills/impeccable 的副本（含 MODIFICATIONS.md）
├─ scripts/
│  ├─ sync-upstream.mjs      # 拉上游 main tarball → 校验 → 覆盖 skills/ → 重写脚本路径 → 更新 lock → 断言 git diff 为空
│  └─ check-upstream.mjs     # 手动比对上游版本与 lock，落后则打印警告（exit 0）
└─ test/
   ├─ engine.test.mjs
   ├─ hook.test.mjs
   └─ plugin.test.mjs
```

**不创建**：`src/`、`build.mjs`、`tsconfig.json`、`lib/client.js`、任何 React 文件、`.github/workflows/upstream-check.yml`（v1.1 再说）。
**v1 只做 `verify.yml` 一个 workflow**（语法 + 单测）。

### 5.1 实施期的文件清单变更（captain 已批准，S2–S5 落地）

上表是最初版本；实施中按职责拆分/补齐了以下文件，**均经 captain 批准**，此处回填以保持文档=仓库：

| 文件 | 何时加 | 为什么 |
|---|---|---|
| `lib/config.js` | S4 | 配置归一化、`PLUGIN_NAME`、写类工具名匹配独立成文件，避免 hook.js 兼配置 |
| `lib/commands.js` | S5 | 命令四个动作的渲染与执行体量较大（约 450 行），与 `index.js` 拆开，`index.js` 保持纯组合根 |
| `lib/log.js` | S4 | 进程内环形日志 + status 计数 |
| `.github/workflows/verify.yml` | S5 | ubuntu+windows × node22：`node --check` + `npm test` + lock 字段校验 |
| `scripts/sync-upstream.mjs` | S5 | 零依赖 tar 同步 + 脚本路径重写 + 更新 lock |
| `scripts/check-upstream.mjs` | S5 | 离线/`--online` 巡检，退出码恒 0（AC6） |
| `upstream.lock.json` | S5 | 出生证明（skill 0.1.18 / engine 0.1.18 / cli 4.8.0 / ref main） |
| `test/plugin.test.mjs` | S5 | 引入时 18 用例，现共 **27** 用例；覆盖 C7/D3/D10/D11/AC1/AC3/AC10 + t10 的 `findPluginEntry` 三条 |
| `docs/acceptance-evidence.md` | S6（t9 追加 §七） | AC1–AC10 逐条结论/证据/证据层级/真机原文 + 待人工确认项（不假装验证）；§七 登记 t9 对 C11 落点与 AC5 取证归因的修正 |
| `docs/code-review-S2-S6.md` | S7（第一轮评审，t11 复核） | 第一轮代码评审报告：10 项核对 + 2 项 blocking（B1 skill 快照未落地、B2 缺 LICENSE/NOTICE）+ N1–N6 非阻断；结论 needs_revision |
| `test/plugin.test.mjs`、`test/hook.test.mjs`、`test/engine.test.mjs` | S3–S6（S8 补至 91） | 共 **91** 用例（0 skip）：24 / 40 / 27 三文件；t10 补 4 条、t12（N3 写失败闸门）补 2 条 |
| `docs/code-review-round2.md` | S8（第二轮评审，t11；t14 登记残留处置） | 第二轮：复核 t10 修复与第一轮遗留项，7 项全过，结论 **pass**；残留 R2-1…R2-4（均 non-blocking）：R2-1/R2-2/R2-3 由 **T13** 清理（engine.js 注释、lock 增 `tarballSource` 并改钉 commit-URL tarball 哈希、MODIFICATIONS.md 补第二条规则命中 0 处），R2-4 由 **T14** 补齐（README §7.5 已知盲区） |
| `docs/completion-summary.md` | S9（t9） | 交付总账：AC 判定、证据层级、变更清单、残留与人工项 |
| `README.md`（中文）、`LICENSE`、`NOTICE.md` | S9（T8） | §5 文件清单里本就规划、S9 落地的三件合规/说明文件：`LICENSE` 逐字复制上游 Apache-2.0 全文（sha256 与上游一致，未改写）；`NOTICE.md` 逐字保留上游原文（前 503 字节与上游一致）后追加本插件声明；`README.md` 写死参考项目、能力边界、安装、命令与参数、三级降级、配置与文件位置、排错、非官方声明。**关闭评审 blocking B2** |

仍然**不创建**：`.github/workflows/upstream-check.yml`（N6 推迟 v1.1）。

## 6. 命令与参数

### 6.1 `/impeccable <子命令> [目标]` —— 由 skill 提供，插件**不注册**同名命令（C7）
| 分组 | 子命令 |
|---|---|
| 构建 | `craft [feature]`（废弃别名）、`shape [feature]`、`init`、`document`、`extract [target]` |
| 评估 | `critique [target]`、`audit [target]` |
| 精修 | `polish`、`bolder`、`quieter`、`distill`、`harden`、`onboard` |
| 增强 | `animate`、`colorize`、`typeset`、`layout`、`delight`、`overdrive` |
| 修复 | `clarify`、`adapt`、`optimize` |
| 迭代 | `live`、`generate [n] [action] [element]` |

参数归属：`/impeccable audit src/views` 中 `audit` 是 skill 分派关键字，`src/views` 是给模型的目标；只有 reference 里写的 `impeccable detect --json src/views` 才真正传给引擎。

### 6.2 `/impeccable-hook <action>` —— 收敛为 4 个（评审意见 2、3）
| 参数 | 行为 |
|---|---|
| `status`（默认） | 引擎路径+版本、hook 开关、内置/本机 skill 版本、**实际解析到的 SKILL.md 绝对路径**、注入统计（已注入 N / 去重跳过 M / 配额用尽 K / 上次结果 ok\|timeout\|no-engine + 时间）、启动自检结论、上游是否落后 |
| `on` / `off` | 写**插件 config**（cordis.patch.yml 的 config 段），**不写**用户仓库的 `.impeccable/config.json`（评审意见 4） |
| `log` | 最近 N 条注入/跳过记录（文件 + 条数 + 结果） |

`.impeccable/config.json` 只读不写——并且**引擎跑 hook 也不会创建它**（v0.2.2 修正 C11：引擎写的是工程内 `hook.cache.json` + 全局 `~/.impeccable/hook-claims`、`hook-sessions`）。

## 7. 数据流

```
模型调用 write/edit 改文件
      ↓
DSH 执行工具 → tools/post-execute(exec, result, next)
      ↓
hook.js 从 exec.name / exec.arguments 提取 file_path
      ↓ 扩展名不在白名单 → 直接 next()，零开销
engine.js 定位引擎（不下载）→ 调 `impeccable hook`（stdin JSON、3s 超时、观察 exec.signal）
      ↓
解析 stdout 的 hookSpecificOutput.additionalContext
      ↓ 按 severity 取 top-N（默认 8）+ 全会话配额（默认 40 条/12k 字符）+ 同文件指纹去重
log.js 记一行
      ↓
返回 { ...downstream, additionalContexts: [UserMessage, ...downstream.additionalContexts ?? []] }
      ↓
模型下一轮看到 [impeccable@1] findings，主动修
```

## 8. 关键实现决策

| # | 决策 | 理由/出处 |
|---|---|---|
| D1 | 第一版只做 post-execute 即时检测，不做回合结束深扫 | 即时层已覆盖坏图/溢出/对比度/渐变文字/发光阴影/设计系统漂移；深扫留 v2 |
| D2 | 去重放进程内存（session + 文件 + findings 指纹），不落盘 | 少一个状态文件少一类 bug |
| D3 | hook 开关写插件 config，`.impeccable/config.json` 只读 | 评审意见 4：不往用户仓库塞 dotfile |
| D4 | hook 超时 3 秒，超时跳过并记日志，绝不向会话抛错 | A1 |
| D5 | skill provider rank 高于 `dsh-skill-filesystem`（同层内按 rank 决胜，C4） | 让包内副本优先；数值以实测不冲突为准 |
| D6 | 只替换脚本路径前缀，不改 reference 正文；改动逐条记在 `MODIFICATIONS.md` | N4 + 评审意见 8 |
| D7 | 引擎版本钉死 lock | 可复现 |
| D8 | 纯 JS 入库、无构建 | C8 |
| **D9** | **注入按 severity 取 top-N + 全会话配额** | 评审意见 6：A1/A2 的真凶不是去重，是一次灌 20–30 条 |
| **D10** | **每次注入/跳过都记一行日志，并计入 `status`** | 评审意见 7：否则用户无法判断它在工作 |
| **D11** | **`apply()` 时做一次事件与签名存活自检；失败则 status 标红 + 启动一行 warning** | 评审意见 9：启动失败要响，运行失败可静默 |
| **D12** | **下载只在 status/显式动作发生，hook 路径只定位** | 评审意见 10 |

## 9. 验收判据与证据层级

### 9.1 判据

| 编号 | 判据 |
|---|---|
| AC1 | `status` 打印实际解析到的 SKILL.md **绝对路径**，且等于包内路径（不是 `$DSH_HOME` 那份） |
| AC2 | 造含渐变文字的 `.html`，用 `write` 改它 → 下一轮上下文出现 `[impeccable@1]` 与 `gradient-text` |
| AC3 | 引擎缺失时：hook 静默关闭、会话不报错、`status` 写明「引擎未找到及原因」 |
| AC4 | 单次 hook < 200ms（本机引擎直调实测 33–37ms）；超时路径不抛异常 |
| AC5 | 同一文件同一问题第二次编辑不重复注入——由**两条互相独立的防线**共同保证：<br>**防线①（引擎侧，跨进程）** 引擎自身把 claim 落盘到 `~/.impeccable/hook-claims`、`hook-sessions`，第二次连 findings 都不产出；<br>**防线②（插件侧，进程内）** `lib/hook.js` 用 `文件::规则` 指纹在会话内去重（`${filePath}::${item.antipattern}`）|
| AC6 | `node scripts/check-upstream.mjs` 在当前快照下 exit 0 并输出「已是最新」 |
| AC7 | 干净 clone（无 node_modules）后 `dsh plugin add github:zxhbloomer/dsh-impeccable-hook` 能装上生效 |
| AC8 | 改 `.md`/`.java` 等非白名单文件时 hook 完全不被调用 |
| **AC9** | 一个含 20+ 条 findings 的大 `.vue`，注入条数 ≤ top-N，且 `status` 的计数与实际一致 |
| **AC10** | 故意破坏事件签名（模拟 DSH 升级）时，启动自检失败并在 `status` 与启动日志中可见 |

### 9.2 每条的**实际**证据层级（t9 回写，2026-10-31）

证据层级定义（四层，**不得混写**）：

| 层 | 含义 |
|---|---|
| ① 单测 | `node --test test/` 断言（假 Service / 假引擎，可复跑） |
| ② 真机链路 | 本机真实引擎 + 真实 `apply()`，临时工程目录 + 全新 session |
| ③ 命令输出 | 退出码 + 原文；隔离 `DSH_HOME` 下的 `dsh plugin add/remove` + `--dump-config` |
| ④ **人工** | **桌面端会话里手敲命令、肉眼看输出**（headless 会话拿不到命令回显，此层**本轮未执行**） |

| AC | 结论 | 实际证据层级 | 依据（可查） |
|---|---|---|---|
| AC1 | **通过（①②③）｜④待人工** | ①②③ + ④待人工 | `test/plugin.test.mjs` 的 AC1 用例；真机 `status` 打印 `<pkg>\skills\impeccable\SKILL.md` 与「与包内路径 一致 ✓」（走 `ctx.skills.get`，非自拼）；`docs/acceptance-evidence.md` §六、`docs/code-review-round2.md` §二.1 |
| AC2 | **通过** | ② | 真机整链：`additionalContexts[0].role='user'`、header `[impeccable@1] … hero.html (1 issue(s))`、`- [gradient-text] …`、1251 字符 |
| AC3 | **通过** | ①② | `test/hook.test.mjs`「引擎不可用时静默跳过并记原因，绝不抛错」；`test/plugin.test.mjs` 整链 `fetch` 调用数为 0；真机 status 打印「未找到（三级降级全部失败）」+ 三行原因 |
| AC4 | **通过** | ② | 最近真机首轮 **55ms**（t10 复验），历史 31–38ms（t4）、43ms（评审亲测）；超时路径单测不抛 |
| AC5 | **通过** | ①② | 防线①：真机第二轮 `findings=0`、`contexts=0`（`~/.impeccable/hook-claims` 生效）；防线②：单测 + 评审独立脚本 **8/8/4/0**、`dedup=20`、条数配额停 40 |
| AC6 | **通过** | ③ | `node scripts/check-upstream.mjs` 离线 `exit 0` + 「✓ 已是最新：包内快照 0.1.18 与 lock 一致。」；`--online` 亦 exit 0 |
| AC7 | **待推送后人工**（③ 仅本地等价） | ③（局部） | t5：隔离 `DSH_HOME` 下 `dsh plugin add <绝对路径>` 装上、`--dump-config` 渲染出插件层、`remove` 全回退。**GitHub 形态未测**（仓库尚未 git init / 推送） |
| AC8 | **通过** | ① | 白名单外扩展名在 `locateEngine` **之前**放行：`locate.calls=0`、`engine.calls=0`、`extSkip+1`；`.md` 整链连 `engine.js` 都不进 |
| AC9 | **通过** | ① | 20 条 findings → 注入 8 条且计数一致；条数配额用尽停 40、字符配额用例 |
| AC10 | **通过（①）｜④待人工** | ① + ④待人工 | 3 条单测（下游判定被改写即失败 / 拿不到事件总线也失败 / 启动 warning 恰好 1 行）；桌面端肉眼确认启动 warning 未执行 |

**判读规则**：结论写「通过」时，必须在末列列出层级；任一层未执行即写「④待人工」，**不得**把四层合并写成「已通过」。

### 9.3 剩余阻塞与人工项（截至 v0.2.2）

| 项 | 状态 | 责任 / 触发条件 |
|---|---|---|
| LICENSE / NOTICE.md / 中文 README（原 B2） | ✅ 已完成（t8） | — |
| git init 与推 GitHub | ⬜ 未做 | **需用户当次明确指令**；合规阻塞已解除，技术上可推 |
| AC7：推后用干净 profile `dsh plugin add github:…` | ⬜ 待推送后人工 | 依赖上一项 |
| AC1 / AC10 第④层：桌面端手敲 `/impeccable-hook status` | ⬜ 待人工 | 用户执行，留截图/原文即可 |
| 破坏 `tools/post-execute` 签名场景下看到启动 warning | ⬜ 待人工 | 同上（可与上一条同场做） |
| `findPluginEntry` 的 `options.name` **端到端** | ⬜ 无法实测 | 本 profile 未安装本插件（`Config` provider `entries` 为空），仅单测覆盖；安装后 `on`/`off` 顺手验一次持久化 |

## 10. 风险与对策

| 编号 | 风险 | 对策 |
|---|---|---|
| R1 | 事件签名变动 | **D11 启动自检** + 运行期 try/catch；单测覆盖 |
| R2 | 工具名→文件路径映射不全（`ops_bash` 用 shell 写文件抓不到） | 首版只覆盖带 `file_path` 的工具（`write`/`edit` 类）；`status` 里如实说明这个盲区 |
| R3 | 与本机已有 skill 冲突 | rank + 启动 warning + `status` 打印实际路径（AC1）；删不删用户定 |
| R4 | 上游大改导致 sync 错位 | sync 时断言关键文件存在 + **sync 后 `git diff` 必须为空** |
| R5 | asar 内官方模板无法被 shell 读取 | 已验证可用 Node 解析 asar header 抽取 |
| R6 | Apache-2.0 合规遗漏 | LICENSE + `NOTICE.md`（复刻上游原文）+ `MODIFICATIONS.md` + README 写明来源与「非官方」 |

## 11. 参考项目

| 项目 | 许可 | 参考了什么 |
|---|---|---|
| `pbakaus/impeccable` | Apache-2.0 | skill 内容来源；design hook 输入输出协议；引擎发布形式与 sha256 校验；`docs/CLI-CONTRACT.md` |
| `Cassius0924/dsh-impeccable` | MIT | 借鉴：双阶段分层思路、去重缓存、每回合最多拦一次、skill 路径自愈、0-Token 命令分流。**不借鉴**：进程内 import 上游私有函数、vendored 老引擎、占位空包 |
| `superpowers-dsh@0.4.0` | — | 包结构、`ctx.skills.registerProvider` 写法、sync-from-upstream 思路 |
| DSH 内置 `dsh-repeat-tool-reminder` | — | `tools/post-execute` 精确写法（`additionalContexts` 前置合并） |

## 12. 分步推进计划

| 步骤 | 内容 | 产出 |
|---|---|---|
| S1 | 设计文档评审 | 本文档 v0.2 |
| S2 | 包骨架 + 空 hook（能装能卸） | 最小可安装包 |
| S3 | 引擎定位与降级 | `lib/engine.js` + 单测 |
| S4 | hook 链路（含 top-N、配额、去重、日志、自检） | `lib/hook.js`、`lib/log.js` + AC2/4/5/9 |
| S5 | 宿主命令 | `lib/index.js` 命令部分 + AC1/3/10 |
| S6 | 版本 lock 与手动比对脚本 | `scripts/*.mjs` + AC6 |
| S7 | 测试补齐 | `test/*.mjs` + AC8 |
| S8 | 代码评审（不同成员） | 评审结论 + 修订 |
| S9 | README/NOTICE/LICENSE + 推 GitHub（**需用户点头**） | 仓库 |

## 13. 留给实施者的自由度

- rank 具体数值（以实测不冲突为准）
- top-N 与配额的具体默认值（8 / 40 条 / 12k 字符是起点）
- 日志前缀与措辞
- 单测细节（默认 `node --test`）

---

## 修订记录

### v0.1 → v0.2（吸收评审意见 + 契约复核）

**契约复核修正（我用 `cordis_inspect_query` 亲自核的，原架构评审两次跑挂）**
1. C2 新增：`additionalContexts` 类型是 `UserMessage[]`，不是字符串数组——v0.1 的写法会直接编译不过/运行报错。
2. C4/C5 修正：rank **只在同一层内**决胜，层由调用上下文决定；skill summary 带 `path`/`provider`，可用于 AC1 断言。
3. C3 新增：异步监听器必须观察 `exec.signal`。

**评审意见采纳（维护者/使用者视角，12 条）**
| 意见 | 处置 |
|---|---|
| 1 砍 CI 巡检 | 部分采纳：cron 推迟 v1.1，保留 lock + 手动脚本（N6） |
| 2 删 `engine` 子命令 | 采纳 |
| 3 `doctor` 并入 `status` | 采纳（命令收敛为 status/on/off/log） |
| 4 开关写插件 config | 采纳（D3 + 6.2），并补充 C11 说明引擎自身会写 config |
| 5 删 4.2 第一行 | 采纳（变三级） |
| 6 top-N + 会话配额 | 强采纳（D9 + AC9） |
| 7 注入日志 + status 计数 | 强采纳（D10） |
| 8 verify-vendor + MODIFICATIONS.md | 部分采纳：MODIFICATIONS.md 必做；verify 简化成 sync 后 `git diff` 为空 |
| 9 启动自检 | 强采纳（D11 + AC10） |
| 10 下载时机 | 强采纳（D12） |
| 11 NOTICE/license/非官方声明 | 采纳（C12 已核实上游有 NOTICE.md） |
| 12 AC1 打印实际路径 | 强采纳 |

### v0.2 → v0.2.1（实施期回填，captain 批准）

1. **文件清单回填**：新增 §5.1，记录 S2–S5 期间经批准的文件拆分与新增（`lib/config.js`、`lib/commands.js`、`lib/log.js`、`verify.yml`、`scripts/*.mjs`、`upstream.lock.json`、`test/plugin.test.mjs`）。
2. **验收方式补充（AC1/AC3/AC10）**：headless 会话拿不到命令回显（启动即 `MISSING_CREDENTIAL`，模型凭据只在桌面进程内），因此这三条改为**四层证据** =
   - ① 真实命令代码（读代码可核）
   - ② 假 Service 单测（`test/plugin.test.mjs`）
   - ③ 真实隔离 `DSH_HOME` 下的 `dsh plugin add/remove` + `dump-config`
   - ④ **人工一步：在桌面端会话手敲 `/impeccable-hook status`，肉眼确认路径与计数**（需用户执行，记为 t6/t7 的人工验收动作）
3. **演示/取证纪律**：引擎自身会在工程目录写 `.impeccable/hook.cache.json`，跨进程也压住重复注入 ⇒ 演示「首次注入」必须每次用**新工程目录 + 新 session id**。
4. 术语统一：引擎降级为**三级**（v0.1 的「四级」及团队简介措辞作废）。

### v0.2.1 → v0.2.2（验收回写，t9）

1. **§9 重写为「判据 + 证据层级」两段**：新增 §9.2，逐条标明 AC1–AC10 的**实际**证据层级（① 单测 / ② 真机链路 / ③ 命令输出 / ④ **人工**），并明确判读规则——任一层未执行就写「④待人工」，不允许把四层合并写成「已通过」。新增 §9.3 剩余阻塞与人工项清单。
2. **AC5 改写成「两条独立防线」**（评审 N4 的取证归因修正）：真机第二轮 `findings=0` 是**引擎侧跨进程 claim 抑制**生效，不是我们的去重；插件侧 `文件::规则` 指纹去重由单测 + 评审独立脚本（8/8/4/0、配额停 40）证明。v0.2.1 此前把两者混为「插件去重生效」。
3. **C11 事实修正**（评审 N5，t9 补实测）：引擎跑 hook 时既写**工程内** `.impeccable/hook.cache.json` + `.impeccable/audit.ndjson`，也写**全局** `~/.impeccable/hook-claims`、`hook-sessions`；而 `.impeccable/config.json` **只读、不会被跑 hook 创建**——v0.2 把它写成「引擎自己会写」是错的（§6.2 措辞同步改正）。证据见 `docs/acceptance-evidence.md` §七。
4. **§5.1 补登文档**：`docs/code-review-S2-S6.md`（第一轮，needs_revision）、`docs/code-review-round2.md`（第二轮，pass）、`docs/acceptance-evidence.md`（含 §七）、`docs/completion-summary.md`（交付总账）；同时把测试用例数从 85 更正为 **91**。
5. **状态行更新**：从「待用户批准，未写任何产品代码」改为「已实施，两轮代码评审通过；待推送 GitHub（需用户当次明确指令）」。

**未采纳/未做**（如实登记，避免下一轮误以为漏项）：评审 R2-1…R2-4 四条 non-blocking 本轮**不改代码**——R2-1（engine.js:229 注释陈旧）、R2-2（lock 补 `tarballSource`）、R2-3（MODIFICATIONS.md 补「第二条规则命中 0 处」）、R2-4（README 补 deferContext 双通道说明）均记在 `docs/completion-summary.md` §五，留待下一轮或用户指示。

### v0.2.2 → v0.2.3（第二轮残留下的沉，t13/t14）

**第二轮评审结论：pass**（`docs/code-review-round2.md`：第一轮两个 blocking 已用可复算事实关闭，7 项复核全过）。

1. **R2-1 / R2-2 / R2-3 由 T13 清理完毕**：R2-1 把 `lib/engine.js` 探针注释改成「只用在一处 —— `status` 的深度体检」（`verify` 选项早已在 t10 删除，注释不再指向不存在的分支）；R2-2 给 `upstream.lock.json` 增加 `tarballSource` 字段，`tarballSha256` 改为钉 **commit URL** 的 tarball（`0af11ea7…557ba`）而非移动 ref `refs/heads/main`，从此可随时复算；R2-3 在 `skills/impeccable/MODIFICATIONS.md` 补记第二条规则 `dsh-home-scripts` 本次命中 0 处。
2. **R2-4 由 T14 补齐**：README 新增 §7.5「已知盲区」，写明①宿主工具 `deferContext()` 与本插件 decision 侧注入在理论上可能各存一份同批 findings（真机未观察到重复，附关 `hook.enabled` 的对照定位办法）、②shell 重定向 / `node -e` 等非写类工具改文件不会被扫（已确认为真实行为：判定依据是写类工具名 + `file_path`）；`status` 的「已知盲区」行同步指向 §7.5。
3. **上一条 v0.2.2 末段「R2-1…R2-4 本轮不改」自此作废**：四条均已处置，仅 **N6（每日 CI 巡检）仍按原计划推迟到 v1.1**。



### v0.2.3 → v0.2.4（t9 收尾：口径统一，captain 接管）

t9（验收汇总回写）连续两次撞同一用户并发上限（`PI_AI_ERROR`）失败，改由 captain 本回合接管完成；其已落盘内容经复核为真，只需修正**过期数字**，不改任何结论：

1. `docs/completion-summary.md`：测试数 **91 → 92**（24 engine + 40 hook + 28 plugin）；`upstream.lock.json` 行改为 t13 后的真值（`tarballSha256 0af11ea7…557ba`、`tarballSource …/tar.gz/<commit>`、`fetchedAt 2026-10-31T11:20:42.894Z`）；§四 残留问题表加「历史快照」标注并列出 R2-1…R2-4 的处置结果（仅 N6 推迟 v1.1）。
2. `docs/acceptance-evidence.md`：§三 测试数改为最终态 92 并写清 85→89→91→92 的演进来源（t6 / t10 / t12 / t13）；新增 §八，用一张表覆盖 §六 里的过期 lock 值（旧的分支版 `176f5ea7…` 明确标注作废），并记录 t13 带来的三个副作用（sync fail closed、MODIFICATIONS 全量列规则、verify.yml 增加 `tarballSource` 守卫）。
3. **判读规则不变**：AC7 仍标「待推送后人工」、AC1/AC10 的第④层仍标「待人工」，本轮不因收尾而升级任何结论。

### v0.2.4 → v0.2.5（S9：推送 GitHub + AC7 实测）

1. 仓库推上 GitHub（public，`github.com/zxhbloomer/dsh-impeccable-hook`，首提交 `f4400dc`，默认分支 `main`），84 文件（含 `.gitignore`）。
2. **AC7 由「待人工」升级为「通过」**：源码在干净 clone 后不装依赖即可 `npm test` 92/92；隔离 `DSH_HOME` 下 `dsh plugin --profile ac7 add github:zxhbloomer/dsh-impeccable-hook` 成功装成 0.1.0 并自动登记 bundle。取证见 `docs/acceptance-evidence.md` §九。
3. 遗留：`.github/workflows/verify.yml` 因 `gh` token 缺 `workflow` scope 未能入库（本地保留），补推后 CI 才生效；AC1/AC10 第④层与 `findPluginEntry` 端到端仍需桌面会话人工确认。

### v0.2.5 → v0.2.6（CI 入库 + 首跑失败修复）

1. `.github/workflows/verify.yml` 随 `a20de38` 入库（此前因 `gh` token 缺 `workflow` scope 被 GitHub 拒收）。
2. **CI 首跑失败，暴露真实兼容缺陷**：`scripts.test = "node --test test/"` 的目录实参在本机 node 26 可用，在 CI 的 node 22 报 `Cannot find module '…/test'`（ubuntu 与 windows 两平台同因）。改为 `node --test`（无参自动发现 `test/*.mjs`），本地 92/92 不变，跨版本兼容。
3. 教训记录：**本机 node 26 通过 ≠ CI node 22 通过**；`node --test` 的路径实参属于版本相关行为，npm script 里不要带目录。
