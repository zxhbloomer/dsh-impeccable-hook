# 代码评审报告：dsh-impeccable-hook（S2–S6 交付物）

- 评审人：reviewer（未参与编码）
- 评审对象：`D:\2026_project\99_dsh\dsh-impeccable-hook` 仓库现状（t2–t6 全部交付物）
- 依据：`docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md`（v0.2 + v0.2.1 修订）
- 评审方式：不采信交付说明，全部命令自己重跑；契约用 `cordis_inspect_query` 亲核宿主 provider；真实引擎亲跑（不是 mock）
- 日期：2026-10-31

## 一、总结论

**needs_revision（不通过，需修订）**。编码质量本身合格：契约（C1/C2/C4/C5）、热路径纪律（D12/C9）、注入治理（D9/AC9）、诚实性（AC1/AC3 措辞）都经得起独立复核；85 条单测全绿且我复跑一致。

**但有 2 项 blocking**，且都不是「代码写错」而是「实物缺失」：

1. **B1 包内 skill 快照从未落地**（`skills/impeccable/` 整个目录不存在）。这是 G1 的实物前提，导致 `/impeccable` 装完不可用、AC1 的「实际路径＝包内路径」不可能成立、AC6 的「已是最新」分支不可达、AC7 无从验证。
2. **B2 缺 LICENSE / NOTICE.md**（Apache-2.0 合规，C12）。本包要分发上游 impeccable 的 skill 副本，`package.json.files` 已把这两个文件名写进发布清单却无对应文件 —— **补齐前不得推 GitHub**。

放行口径见第六节：**不许「验收通过」，但允许 doc-writer 继续做 t8**（t8 正是补 LICENSE/NOTICE/README 的任务），B1 必须在 t9 验收汇总前由具备 S6 职责的角色落地。

我独立复跑的两条基线：

```
$ cd D:/2026_project/99_dsh/dsh-impeccable-hook && npm test
# tests 85 / suites 0 / pass 85 / fail 0 / cancelled 0 / skipped 0 / todo 0（637ms，exit 0）

$ node scripts/check-upstream.mjs
[check-upstream] lock：skill 0.1.18 ｜ engine 0.1.18 ｜ ref main
⚠ 包内 skill 快照未落地（skills/impeccable/scripts/VERSION 不存在）
提示：先运行 node scripts/sync-upstream.mjs 把上游快照落到包内。   # exit 0
```

即 AC6 的 exit 0 成立，但**「已是最新」这句文案当前打不出来**（分支要求快照文件存在），打出来的是上面那条 ⚠。这不是缺陷，是 B1 的连带症状。

## 二、合同契约亲核结果（不是照抄设计文档）

用 `cordis_inspect_query` 查宿主真实 schema：

| 设计里的说法 | 宿主实际契约 | 结论 |
|---|---|---|
| C1 `(exec, result, next) => Promise<PostToolDecision>` | `'tools/post-execute': waterfall`，签名一致 | ✅ 成立 |
| C2 `additionalContexts: UserMessage[]` | `PostToolDecision` 三个变体都带 `additionalContexts?: UserMessage[]`；`UserMessage extends MessageBase { readonly role: 'user' }` | ✅ 成立（v0.1 写成字符串数组会运行失败，已修） |
| C3 监听器必须观察 `exec.signal` | `ToolExecutionInput.signal: AbortSignal` 存在，事件说明也要求异步监听器观察它 | ✅ 成立 |
| C4 rank 只在同层内决胜 | `registerProvider` 的 `create(control)` 在调用上下文层注册；同层重名抛错，`rank` 仅同层去重 | ✅ 成立 |
| C5 `SkillSummary` 暴露 `path/provider`，但**没有** `rank` | `SkillSummary {path?, name, description, whenToUse?, invocation, source, provider, resourceBase?}`；`rank` 只在 `SkillCandidate` | ✅ 成立，`lib/commands.js` 里那句「rank 不在 SkillSummary 上」是对的 |
| 命令面 `handler(invocation)`，`rawInput` 是名字之后的全部 | `CommandInvocation {commandId, agent, rawInput, attachments, signal}` | ✅ 成立 |
| D3 开关写插件 config | `configEditor.edit(entry, change)` 存在 | ✅ 能力可用，但匹配方式有隐患（见 N1） |

## 三、逐条核对（captain 指定的 10 项）

### 1. C7：只许注册 `impeccable-hook` —— **通过**

`grep -rn "commands.register(" lib` 只有一处：`lib/commands.js:422`，`name: COMMAND_NAME`（`= 'impeccable-hook'`，`lib/commands.js:27`）。`'impeccable'` 只作为 `SKILL_NAME` 常量（`:30`）用于 `skills.get('impeccable')`，从不进命令注册表。单测另有 `C7：只注册 impeccable-hook 一个命令，绝不注册 impeccable` 锁死。

### 2. C2：`additionalContexts` 是 `UserMessage[]` —— **通过**

- 形状：`lib/hook.js:createInjectionMessage` 产出 `{id, role:'user', content:[{type:'text',text}], source:{kind:'dsh-impeccable-hook', form:'notice', summary}}`，**深冻结**（单测 `createInjectionMessage：深冻结` 断言 `Object.isFrozen` 递归成立）。
- 前置合并：`mergeAdditionalContexts` 把我们的消息放在数组**第一位**，下游原有的往后排。我的真机脚本第 [6] 项实测：下游先带 1 条 `additionalContexts`，合并后长度 2 且本节在第 0 位 ✅。
- 真机取证：`additionalContexts[0].role === 'user'`、`content[0].type === 'text'` 成立。

### 3. 热路径纪律（D12/C9）—— **通过**

`lib/hook.js:19-25` 的 import 只有 `node:child_process`、`node:crypto`、`node:path`、`./config.js`、`./engine.js`（**只取 `locateEngine`**）、`./log.js`。**热路径**纪律按 v0.3 口径限定：`grep -n "allowDownload" lib/hook.js` **零命中**、`grep -n "ensureEngine" lib/hook.js` **零命中**（v0.2.1 原文此处写的是「`lib/` 内 `ensureEngine` 无生产调用方」——v0.3 起该函数由 `lib/index.js` 在 `apply()` 后异步调用以自动备齐引擎，因此那条**全仓**判据已被 v0.3 取代，只剩「热路径零命中」这条仍然成立）。

> 口径修正（v0.3）：能联网的只有两处——启动期 `ensureEngine`（`hook.autoDownload`，默认开）与显式 `/impeccable-hook status download`；hook 每次编辑仍然只做 `locateEngine`。

整链 `fetch=0` 是**真实用例**不是注入假 locate：`test/plugin.test.mjs:336+` 把 `globalThis.fetch` 换成计数即抛的实现，`DSH_HOME`/`IMPECCABLE_HOME` 指向空临时目录，然后走 `apply()` 的真实监听器 → 真实 `locateEngine`，断言 `counter.fetches === 0`、`out === decision`、`calls` 增量 0、`noEngine` 增量 1。我读过这段代码，也把它当可信证据。

### 4. `next()` 语义 —— **通过**

我的真机脚本（真引擎）四项全过：next 调用次数恰好 1；无注入分支 `d1.value === downstream.value`（`Object.is` 级同一引用）；有注入分支 `kind/value` 保留；下游 `{kind:'block', feedback}` 时 `out.kind==='block'` 且 `out.feedback === feedback`（同一引用，未被重建）。

补充：`accept.content` 变体走的是 `{...decision, additionalContexts:[...]}` 展开，`content` 原样带过，符合契约的互斥字段设计。

### 5. 注入治理三件套（D9/AC5/AC9）—— **通过（我自己写脚本验的）**

用假引擎灌 20 条 findings（`topN=8`、`maxFindingsPerSession=40`），连打同一文件：

```
第一轮注入规则： anti-0,anti-1,…,anti-7          # top-N=8 生效
第二轮注入规则： anti-8,…,anti-15                # 已注入的 0–7 被指纹去重，不重复注入
第三轮注入规则： anti-16,anti-17,anti-18,anti-19 # 只剩 4 条新规则
第四轮：        additionalContexts = undefined    # 无新规则 ⇒ 完全静默
stats: calls=4 injections=3 findings=20 dedup=20 quota=0 last.result='dedup'
```

再看配额：连打 6 个文件（每文件 20 条/注入 8 条），第 5 次注入后累计正好 40 条，第 6、7 次 `result='quota'`、注入 0 条，`stats.quota=40` 与 `state.injectedFindings=40` 一致。`log.js:100-128` 的计数语义（`calls`/`injections`/`findings`/`chars`/`dedup`/`quota`）与上述实测**逐项对得上**，status 读的就是同一份 `stats()`。

一个语义细节值得记录（不是缺陷）：`state.seen` 只记「真正注入过」的指纹，所以被 top-N/配额砍掉的条目下一轮仍有机会出现 —— 这是对的（它们还没被审过），实现上体现为 `injectedFingerprints` 而非 `kept` 落库。

### 6. D3：on/off 不碰用户仓库 `.impeccable/config.json` —— **通过**

`lib/` 内没有任何代码写 `.impeccable/config.json`：`grep -rn "\.impeccable" lib` 只命中注释与用户提示文案；唯一的 `writeFile` 在 `lib/engine.js:556-571`（写引擎缓存的临时文件 + rename）。`setEnabled`（`lib/commands.js:297-348`）先改内存 `handle.switch.enabled`（立刻生效），再 `configEditor.edit(entry, …)` 只改 `hook.enabled` 并保留其余字段；configEditor 缺失 / 找不到 entry / 写入抛错都返回 `kind:'error'` 且明说「没能持久化」，不假装成功。单测 `D3：on/off 立刻生效并写回插件 config，不碰 .impeccable/config.json` 断言目标文件未被创建。

### 7. AC1 诚实性 —— **通过（但见 B1）**

`lib/commands.js:74-110` 走 `skills.list()` 找 `impeccable` 再 `skills.get('impeccable', options)`，拿 `definition.path ?? summary.path` 作为**实际路径**，与 `join(skillDir,'SKILL.md')` 用 `samePath`（win32 忽略大小写）比对，输出 `一致 ✓` / `不一致 ✗（包内应为 …，实际解析到 …）`；**没有自己拼路径充当结果**。

未知状态如实说：`samePath` 两侧任一 undefined 时打印 `（provider 未提供 path）` / `实际解析到 未知`，并补一句「同层有更高优先级的 impeccable（例如 `$DSH_HOME/skills/impeccable`）」的含义解释。裸 null 问题已被 t6 修掉并有回归用例（`status：引擎 verified 不是 true 时不打印裸 null`，断言 `!/(；|：)null/`）；「未探测到引擎」也不再被说成「与钉死一致」（回归用例断言 `report.engine.state==='unknown'` + 文案 `/未探测到本机引擎/`）。我用 `sideBySide`（`:61-69`）逐分支验算过，四个分支都不会吐出裸 `null`。

**但**：`packagedPath` 指向的 `skills/impeccable/SKILL.md` 当前不存在，所以真实运行只会打「不一致 ✗」——这就是 B1，status 的诚实性反而把缺口暴露出来了。

### 8. D11/AC10 启动自检 —— **通过**

`lib/index.js:184-224` `runStartupSelfCheck` 是**真走监听器**：构造 `downstream = {kind:'accept', value:{selfCheck:true}}`，调 `handle.listener({name:'read', arguments:{}}, {}, async () => downstream)`（无 `file_path` ⇒ 引擎一次都不会被调，不违反 A1），断言 `decision !== downstream` 就抛「下游 PostToolDecision 未被原样透传」；再对 `mergeAdditionalContexts` 结果验 C2 三件事（数组、`role==='user'`、`content[0].type==='text'`）与「合并后 `kind/value` 未丢」。失败 → `handle.selfCheck={ok:false,reason}` + `ctx.logger.warn('[dsh-impeccable-hook] 启动自检失败：…（详情见 /impeccable-hook status）')`；`renderStatus` 在 `selfCheckFailed` 时返回 `kind:'error'`（客户端会标红）。自检是 `void` 异步的，不阻塞启动（符合 A1）。单测覆盖「下游判定被改写时失败」「改 shape 时失败」两条反向路径。

### 9. 简单优先（CLAUDE.md §2）—— **存疑：有一批「以后可能用到」的死代码**

可删/需改清单（全部 non-blocking，但属于「不该提前长出来的东西」）：

| 位置 | 问题 | 处置 |
|---|---|---|
| `lib/engine.js:656` `ensureEngine` | 无任何生产调用方（commands 用的是 `resolveEngine`）；只为单测存在 | 删掉，或让 `status download` 真正走它 |
| `lib/engine.js:509` 注释 | 「只有 ensureEngine（status / 显式动作）会走到这里」——**事实错误**，status 走的是 `resolveEngine`（`lib/commands.js:189` 的默认 `engineResolver`） | 改注释，或按上一条统一入口 |
| `lib/engine.js:456` `verify === 'probe'` 分支 + `probeEngineVersion`(:247) + 注入的 `probeArgs`/`spawnImpl` | 生产不可达：`lib/index.js` 调 `registerCommands` 时不传 `engineOptions`，`verify` 恒为 `'digest'` | 要么 status 传 `verify:'probe'` 真用上，要么删（`lib/engine.js:172-173` 注释「status 深度体检」随之要改） |
| `lib/engine.js:32` `ENGINE_LEVELS` | 导出但 lib 内无调用方 | 删导出 |
| `lib/engine.js:127` `windows-arm64 → x64` 回退 | 推测分支（上游没有 windows-arm64 资产） | 删，或注明依据 |
| `lib/config.js` 的 `maxCharsPerSession=12000` | 默认 `maxFindingsPerSession=40` 时永远够用（我实测 40 条 ≈1.6k 字符），字符配额基本不可达 | 保留可以，但要知道默认值下它是死参数；建议注释说明 |

`lib/hook.js`（531 行）我没找到多余抽象：`extractFilePath`/`buildEngineEvent`/`runEngineHook`/`parseEngineOutput`/`parseInjection`/`renderInjection`/`createInjectionMessage`/`mergeAdditionalContexts`/`createHookState`/`createPostExecuteHook`/`attachHook` 各有确定调用方，且都是单测接缝。`engine.js` 的体量主要是引擎降级链 + 摘要校验 + 下载纪律的实在逻辑，扣掉上表几项后不算过度设计。（v0.3 注：降级链已收敛为**两级**——共用缓存 `~/.impeccable` + 官方 Release 下载；本行原文写的层级数为 v0.2.x 时口径。）

### 10. 合规（Apache-2.0 / C12）—— **不通过（B2）**

```
$ ls
cordis.patch.yml  docs  lib  package.json  scripts  test  upstream.lock.json
```
`LICENSE`、`NOTICE.md`、`README.md` 均不存在，但 `package.json.files` 已把它们列进发布清单。上游 impeccable 是 Apache-2.0 且带 `NOTICE.md`，本包分发其 skill 副本 ⇒ **缺这两份文件即构成合规缺口，补齐前不得推 GitHub**（这也直接封死 AC7）。另外 skill 快照落地后还需 `skills/impeccable/MODIFICATIONS.md`（D6 的改动登记）。

## 四、AC1–AC10 证据层级核对（诚实性专查）

| AC | 交付文档口径 | 我的核对 | 结论 |
|---|---|---|---|
| AC1 status 打实际解析路径 | 「通过（渲染与比对逻辑）｜待人工确认」 | 代码路径正确、诚实；但包内文件不存在 ⇒ 真实运行只会「不一致」 | **受阻（B1）**；文档标注诚实，可接受 |
| AC2 注入 `[impeccable@1]` + 规则名 | 通过（真机 35ms） | 我亲跑：43ms，`additionalContexts[0]` 是 UserMessage，正文 `[impeccable@1] … - [gradient-text] …` | 通过 |
| AC3 无引擎静默关 + status 说明 | 通过 | 整链用例（真 `locateEngine` + 空 DSH_HOME）断言 noEngine+1、`last.reason` 含「静默关闭」；真机 `.md` 用例不触发定位 | 通过 |
| AC4 单次 < 200ms | 通过 35ms（31–38ms） | 我亲测首轮 43ms；摘要缓存后二次 18ms；超时路径有单测且永不抛 | 通过 |
| AC5 同文件同问题不重复注入 | 「真机第二轮 additionalContexts 长度 0、stats.dedup=1」 | 我的真机复跑：第二轮 `findings=0`、`dedup=0` —— **是引擎自己压住了重复**（状态落在 `~/.impeccable/hook-claims`），不是我们的去重。我们的去重我用假引擎单独验证是好的（见第三节第 5 条） | **行为通过，证据归因需修**（见 N4） |
| AC6 check-upstream exit 0 + 「已是最新」 | 通过（exit 0 + --online 一致） | exit 0 成立；`--online` 确实打印「上游 main 的 skill 版本 0.1.18 与 lock 一致」；但离线分支的「✓ 已是最新」因快照缺失打不出 | exit 0 通过；「已是最新」受阻（B1） |
| AC7 干净 clone 装一次 | 「待 S9」+ 本地等价路径已验证 | 未验证且 **不可能成立**（无 LICENSE/NOTICE、无 skills 快照） | 待 B1/B2 |
| AC8 `.md`/`.java` 不调引擎 | 通过 | 我亲测 `.md`：calls 与 noEngine 增量均 0，`extSkip=1`；`.md` 连 `locateEngine` 都不进 | 通过 |
| AC9 20+ findings 只注 top-N，计数一致 | 通过 | 我独立脚本：8/8/4/0 四轮 + `quota=40`，`stats` 与 `state` 一致 | 通过 |
| AC10 破坏签名时自检失败可见 | 通过（待人工确认） | 代码与 3 条单测扎实；桌面端红字提示仍待人工敲一次 | 通过（人工项保留） |

**没有发现「把待人工确认写成已通过」**。`docs/acceptance-evidence.md` 的 §四 单列了 3 条待人工项，§五 主动登记了 t6 修掉的两个真缺陷，这份文档的诚实度是合格的。唯一需要修的是 AC5 的证据归因（N4）。

## 五、Blocking 必改项（可直接执行）

### B1 落地包内 skill 快照 `skills/impeccable/`

- 现象：仓库无 `skills/` 目录；`lib/index.js` 的 provider `list()` 因目录缺失恒返回 `[]`，装完 `/impeccable` 不可用；`AC1/AC2/AC6/AC7` 的实物前提缺席。
- 改法：
  1. `node scripts/sync-upstream.mjs`（脚本已存在，336 行）把上游 `pbakaus/impeccable@main` 的 `.dsh/skills/impeccable` 落到 `skills/impeccable/`；
  2. 把 `upstream.lock.json` 的 `commit` / `fetchedAt` / `tarballSha256` 从 `null` 填成实际值（当前三字段皆 null，出生证明形同虚设）；
  3. 按 D6 只改脚本路径前缀（`$DSH_HOME/skills/impeccable/scripts` → 包内实际路径），改动逐条写进 `skills/impeccable/MODIFICATIONS.md`；
  4. 跑 `node scripts/check-upstream.mjs` 确认打出「✓ 已是最新」，再跑 `npm test` 确认 85 条仍全绿；
  5. 用 `/impeccable-hook status` 确认「与包内路径 一致 ✓」（AC1 第④层人工证据）。
- 验收：`ls skills/impeccable/SKILL.md` 存在 + `check-upstream` 打出「已是最新」+ status 打「一致 ✓」。

### B2 补齐 LICENSE / NOTICE.md（合规闸门）

- 现象：`package.json.files` 已列 `LICENSE`、`NOTICE.md`、`README.md`，文件全缺；本包分发 Apache-2.0 上游的 skill 副本。
- 改法：从上游根目录取 `LICENSE`（Apache-2.0 原文）与 `NOTICE.md`，放到包根；`NOTICE.md` 里保留上游版权与出处（repo + commit + 快照版本），并声明本插件为非官方移植；`README.md` 中文说明安装/命令/已知盲区（t8 范围）。三者齐备前**禁止 git push 到 GitHub**。
- 验收：`ls LICENSE NOTICE.md README.md` 三件齐；`node -e "console.log(require('./package.json').files)"` 列出的每个条目都实际存在（可加进 CI 的 lock 检查步骤）。

## 六、Non-blocking 建议（按严重度）

- **N1（medium）`findPluginEntry` 的 entry 身份匹配不符合 DSH 惯例** —— `lib/commands.js:274-275` 只比 `entry.name|id|plugin|package|module`，读不到 `entry.options.name/id`。参考已安装插件：`dsh-ops/lib/config-updates.js:86-95` 用 `ctx.fiber?.entry` + `entry.options?.name`，`dsh-better-sidebar/lib/index.js:9244` 用 `entry.options.id` + `entry.options.name`。当前能命中只因 `cordis.patch.yml` 里显式写了 `id: dsh-impeccable-hook`；patch 被改写（未安装、被 override 合并）时 on/off 会落到「找不到 entry ⇒ 没能持久化」的错误分支。改法：候选值集合加入 `entry?.options?.name`、`entry?.options?.id`，并优先用 `ctx.fiber?.entry`。当前 profile 未安装本插件，`Config` provider 的 `entries` 为空，此条无法端到端实测 —— 建议 t9 的桌面端人工项里顺手验一次 on/off 真持久化。
- **N2（low）engine.js 死代码与错注释** —— 见第三节第 9 条表格（`ensureEngine`、`verify:'probe'`、`ENGINE_LEVELS`、arm64 回退、509 行注释）。建议在 t9 前一次性收敛，避免下一位读者把注释当真。
- **N3（low）hook 未跳过 `result.isError === true`** —— 写失败（权限/磁盘满）时仍会拿旧文件内容跑引擎。与上游 PostToolUse 语义一致，可留 v1.1；若做，只需 `if (result?.isError === true) return next()`。
- **N4（low）AC5 真机证据归因不准** —— 交付文档写「真机第二轮 stats.dedup=1」，但我两次真机复跑都是 `findings=0`/`dedup=0`：本机引擎自己就把重复压住了（持久状态在 `~/.impeccable/hook-claims`、`~/.impeccable/hook-sessions`）。建议改成「AC5 有两条独立防线：引擎侧 claim 抑制（真机观察）+ 插件侧 `文件::规则` 指纹去重（假引擎单测 + reviewer 独立脚本：8/8/4/0）」。
- **N5（low）设计文档 C11 与实际不符** —— C11 说引擎在项目内写 `.impeccable/config.json` + `hook.cache.json`；实测本机引擎（0.1.18）把状态放在 `~/.impeccable/` 全局目录，项目内 `tmp` 目录**没有**创建 `.impeccable`。不影响 D3 的实现（我们本来就不写），但 t9 回写时应按实测修正 C11 措辞。
- **N6（low）默认配置下 `maxCharsPerSession=12000` 不可达** —— `maxFindingsPerSession=40` 时 40 条 ≈1.6k 字符，字符配额永远不触发。要么在 config 注释里说明「仅在放大条数配额时才有意义」，要么把默认值调到与条数配额同一量级。

## 七、是否放行 t8 / t9

- **t8（补齐 LICENSE/NOTICE/README，doc-writer）**：**放行**。它正是 B2 的修复任务，必须先做。
- **t9（验收汇总回写）**：**暂不放行**。B1（skill 快照）当前没有任何任务认领，若不先落地，t9 只能把 AC1/AC2/AC6/AC7 写成「受阻」，验收结论必然不成立。建议 captain 在 t8 之外单开一个「S6 skill 快照落地」任务（含 `upstream.lock.json` 三字段填实 + `MODIFICATIONS.md`）。
- **发布（推 GitHub）**：B1 + B2 全清之前**禁止**。

## 八、我实际执行过的验证命令（可复现）

```bash
cd D:/2026_project/99_dsh/dsh-impeccable-hook
npm test                                  # 85/85 pass, 0 skip, exit 0
node scripts/check-upstream.mjs           # exit 0，打印 ⚠ 快照未落地
node scripts/check-upstream.mjs --online   # exit 0，打印「上游 main 的 skill 版本 0.1.18 与 lock 一致」
node --check lib/*.js scripts/*.mjs test/*.mjs   # 全通过
node C:/Users/Administrator/AppData/Local/Temp/imp-review-ac2.mjs  # 真引擎：AC2/AC4/AC5/AC8 + block/前置合并/next 次数
node C:/Users/Administrator/AppData/Local/Temp/imp-review-ac5.mjs  # 指纹去重：8/8/4/0 + dedup=20
node C:/Users/Administrator/AppData/Local/Temp/imp-review-ac9.mjs  # top-N/条数配额/字符配额 + 计数一致性
```
