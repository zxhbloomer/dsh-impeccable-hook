# v0.3 代码评审（第三轮）— 引擎自给自足 / 启动自动下载 / on-off 修复

> 评审人：reviewer（未参与 v0.3 编码）
> 评审对象：t15（引擎降为两级）、t16（启动期自动下载）、t17（on/off 走 `ctx.get`）、t18（文档回写）
> 仓库：`D:\2026_project\99_dsh\dsh-impeccable-hook`
> 结论口径：所有结论均由评审人**自己跑的**命令/脚本产出，不采信交付说明。凡"未跑"一律标"待人工确认"，不写成通过。

---

## 一、总结论

**结论：pass（放行 t8 / t9）。**

- 三个 blocking（B1 缓存目录不许改名、B2 启动自动下载的开关/单次/不静默、B3 `configEditor` 不许进 `inject`）**均已落地并可复现**；
- 六项必查全部给出可重算证据（见 §三），其中 AC11「空缓存 → 首启自动就位」原实现只有单测，本轮由评审人用**本地假 Release 服务器 + 真引擎字节**跑通了整链；
- 无新增 blocking。剩余 3 条 non-blocking（路径比较未归一化、README/A3 注释与「摘要不符已 fatal」的措辞漂移、`engine.js` 两处死分支）+ 2 条 info，见 §四；
- 回归无退化：`npm test` 104/104、`check-upstream` exit 0 且离线打「✓ 已是最新」、12 个 js/mjs 全过 `node --check`、测试里无 `.skip`/`.only`/空断言。

一处必须披露的**临时改动**：为验证 B3 的 Proxy 契约测试不是空跑，我临时把 `lib/commands.js` 的 `getService` 改回 `ctx?.[key]`（red 跑）后**已按备份还原，sha256 校验回原值**，详见 §三.3。除该实验外未改任何实现文件，未安装插件、未触碰任何 profile。

---

## 二、评审范围与不做的事

| 项 | 说明 |
|---|---|
| 覆盖 | t15/t16/t17/t18 的改动 + 其对既有 AC 的影响 |
| 不覆盖 | 第一轮（C7/C2/next()/注入治理/D3/AC1 诚实性/D11）与第二轮（快照保真、lock 真实、MODIFICATIONS）已判定的项，除回归外不重判 |
| 不做 | 未执行 `dsh plugin add`、未改任何 profile、未 `git add/commit/push` |
| 环境 | Windows x64、Node v26.13.0、真引擎 `~/.impeccable/bin/0.1.18/impeccable.exe`（sha256 `8f61e96b0c97…`） |

---

## 三、六项必查逐条

### 3.1 B1：引擎解析只剩两级，机器上不会有第二份缓存 —— **通过**

| 证据 | 命令 | 结果 |
|---|---|---|
| 删除干净 | `grep -rn "user-skill" lib test` | **0 命中** |
| 文案删除 | `grep -rn "用户级已装" lib test` | 1 命中，仅 `lib/engine.js:14` 的删除说明注释 |
| 死参数删除 | `grep -rn "dshHome" lib` | 0 命中（`DSH_HOME` 只剩 skill 目录相关注释） |
| 两级标签 | `lib/engine.js:32-35` | `LEVEL_LABEL = {'user-cache': '①共用缓存 ~/.impeccable', download: '②官方 Release 下载'}` |
| 无第二候选路径 | `lib/engine.js:172-187` | `enginePaths()` 只返回 `userCacheBin`，无 `userSkillBin`；实测 `'userSkillBin' in enginePaths({}) === false` |
| **全库写盘点** | `grep -rn "mkdirSync\|writeFileSync\|renameSync\|chmodSync\|rmSync" lib/` | 仅 6 处，全在 `downloadLevel`，目标全是 `paths.userCacheBin`（`~/.impeccable/bin/<ver>/`）+ `.verified` 戳 + `.part.*` 清理 → **不存在第二个缓存目录** |
| 缓存位必须留在 `~/.impeccable` | `lib/engine.js:15-16` 注释 | 写明包内不可修改的 launcher 也在该处找引擎，改名会分裂成两套缓存 |
| 真机解析 | `node --input-type=module -e "import {locateEngine} from './lib/engine.js'; …"` | `available:true, level:'user-cache', label:'①共用缓存 ~/.impeccable', path:'C:\Users\Administrator\.impeccable\bin\0.1.18\impeccable.exe', engineVersion:'0.1.18', verified:true`，44ms |
| 机器只有一份引擎 | `find ~/.impeccable -name "impeccable*" -type f` | 只有 `bin/0.1.18/impeccable.exe` + `impeccable.exe.verified`；无 `~/.impeccable-hook`、`~/.dsh-impeccable-hook` |
| 只有一份 skill | `ls ~/.dsh/skills` | 已无 `impeccable`（旧的用户级 skill 安装不再存在）→ skill 源头唯一 |

### 3.2 B2：启动期自动补引擎（有开关、单次、失败不静默、清 `.part`）—— **通过**

| 证据 | 位置/命令 | 结果 |
|---|---|---|
| 热路径仍只定位 | `test/plugin.test.mjs:437`（整链用例，真 `locateEngine`，未注入假 locate） | `fetches === 0`、`calls` 增量 0、`noEngine` +1、`last.reason` 命中 `/静默关闭/` |
| 开关默认值 | `lib/config.js:50` / `:134-137` | `autoDownload: true`；只有 `false/'false'/0` 才算关 |
| 启动接线 | `lib/index.js:226-244` → `:256-268` | `apply()` 内 `void runStartupSelfCheck` 后调 `bootstrapEngine(handle)`；网关 `handle?.config?.autoDownload !== true` 直接返回 |
| 单次/不抛 | `lib/engine.js:636-680` | 模块级 `let ensured`，复用同一 Promise；`.catch()` 兜底，永不 reject；`resetEnsureState()` 仅供测试 |
| **评审人独立复算 1：apply 自己会发起下载** | `/tmp/verify-bootstrap.mjs`（桩 ctx + 抛错 fetch + 空 `IMPECCABLE_HOME`，**不手动调 ensureEngine**） | 默认配置 ⇒ `fetch = 1`；`autoDownload:false` ⇒ `fetch = 0` |
| **评审人独立复算 2：失败不静默** | `/tmp/verify-warning.mjs` | hook 日志恰 1 条 `warning`：「两级引擎链全部失败（引擎版本 0.1.18，资产 impeccable-windows-x64.exe）：①共用缓存 ~/.impeccable — 文件不存在 ②官方 Release 下载 — 下载失败：offline 按 AC3 处理」；`no-engine` 计数 0（不被误记成热路径事件）；`ctx.logger.warn` 0 次（按设计走 hook 日志，由 `status`/`log` 呈现） |
| `.part` 清理 | `test/plugin.test.mjs:649` + `lib/engine.js:476-510` | 所有失败路径都过 `fail()` → `cleanupPartials()`；用例预置两个 `.part` 残File，断言目录内 `.part.` 归零 |
| 不重试/不重复下载 | `test/plugin.test.mjs:634` | 3 个并发 `ensureEngine` ⇒ 只 `fetch=1`，且三者拿到同一对象 |
| **AC11 整链（原仅有单测）** | `/tmp/verify-ac11.mjs`：本地 http 服务器把 `engine-v0.1.18/impeccable-windows-x64.exe` 换真引擎字节，`IMPECCABLE_HOME` 指向空目录，`IMPECCABLE_DOWNLOAD_BASE` 指向该服务器，只调 `apply()` | 下载前 `available:false` 且 `bin/` 不存在 → apply 后 `available:true, level:'user-cache', verified:true, version:'0.1.18'`；目录内 `['impeccable.exe','impeccable.exe.verified']`；`.part` 残留 `[]`；`.verified` 戳 `8f61e96b… 20435344` |

### 3.3 B3：`configEditor` 不进 `inject`，`ctx.get` 优先，且契约测试真的会红 —— **通过**

| 证据 | 位置/命令 | 结果 |
|---|---|---|
| 未进 inject | `lib/index.js:32` | `const inject = ['skills', 'commands']` |
| 取服务顺序 | `lib/commands.js` `readService` + `getService` | 先 `ctx.get(key)`，仅当返回 `undefined` 才在 `try/catch` 里读 `ctx[key]` ⇒ 可选服务不变成硬依赖 |
| 用例存在 | `test/plugin.test.mjs:741` 起（`createStrictCtx` Proxy 对未 inject 属性抛错） | 覆盖「未 inject `configEditor` 时 on/off 仍能写回」等 4 条 |
| **临时还原实验（已还原并披露）** | 备份 `/tmp/commands.js.orig`（原 sha256 `74e04301f620488701518659654e9128218f228ad1f74d434f4231695c336ab3`）→ 改成 `function getService(ctx, key) { return ctx?.[key] }`（sha256 `0aaf2921…`）→ `node --test test/plugin.test.mjs` | **tests 36 / pass 32 / fail 4 / skip 0**，红的正是这 4 条：`B3：未 inject configEditor 时 on/off 仍能写回 config`、`D3：on → status 开 → off → status 关`、`D：verified=null（清单未收录）由真实 resolveEngine 产出`、`D：lock 落后于包内 VERSION`；错误链 `cannot get property "skills" without inject`（Proxy@`test:741` → `commands.js:65 getService` → `:88 resolveSkillView` → `:194 renderStatus`），与真机故障链一致 |
| 还原校验 | sha256 比对 + `npm test` | 回到 `74e04301…`，104/104 pass |
| 独立四步配对 | `/tmp/verify-onoff.mjs`（桩 `configEditor`，entry 只有 `options.name`） | ① `status` → 「开」 ② `off` → success「已关闭（之前是「开」）」 ③ `status` → 「关」 ④ `on` → success ⑤ `status` → 「开」；`edit()` 收到的持久化内容 `{"hook":{"enabled":true,"topN":8}}`（其余字段保留） |

### 3.4 真机引擎解析 —— **通过**

见 §3.1 真机行：`level=user-cache`、`verified=true`、`0.1.18`、44ms；`~/.impeccable/bin` 下只有一份引擎。未安装插件、未改 profile。

### 3.5 诚实性（AC11–AC15 与过时表述）—— **通过，附 2 条措辞漂移**

| 证据 | 命令 | 结果 |
|---|---|---|
| AC11/AC12/AC13 未被写成已通过 | `docs/acceptance-evidence.md:173/183/192` | 分别为「部分证据｜**待人工确认**」「单测通过｜**真机待人工确认**」「单测通过｜**真机待人工确认**」，复验命令齐全 |
| AC14/AC15 有可执行判据 | `:201` / `:207` | AC14 静态终态；AC15 判据为 grep 命中 0 |
| 交付文档无过时 `user-skill` | `grep -rn "user-skill\|用户级已装" README.md docs/*.md skills/impeccable/MODIFICATIONS.md` | 命中仅出现在 `docs/code-review-v0.3-plan.md`（评审历史件，属豁免范围）；README / acceptance-evidence / completion-summary / code-review-S2-S6 / MODIFICATIONS **0 命中** |
| AC4 旧证据作废并重测 | `:14` | 明确写「旧证据作废」，并给出首轮 74ms / 次轮 31ms 与「下载未完成时首轮报 no-engine」的时间窗说明 |
| **评审人复测 AC4（v0.3 build）** | `/tmp/verify-ac4.mjs`（真引擎整链） | 首轮 **74.9ms**、二轮 23.2ms（均 <200ms）；首轮注入 1 条、`value` 原样透传；`~/.impeccable` 之外的临时工程目录内**未生成 `.impeccable/`**（符合 D3/C11） |

### 3.6 回归 —— **通过**

| 命令 | 结果 |
|---|---|
| `npm test` | **104 / pass 104 / fail 0 / skipped 0 / todo 0**，≈640ms，exit 0；per-file：engine 28 例/104 断言、hook 40 例/167 断言、plugin 36 例/151 断言 |
| `grep -rn "\.skip\|\.only(\|todo:\|assert.ok(true" test/` | 0 命中（无新增跳过、无空断言） |
| `node scripts/check-upstream.mjs` | exit 0，离线打「✓ 已是最新：包内快照 0.1.18 与 lock 一致」，无「快照未落地」 |
| `node --check lib/*.js scripts/*.mjs test/*.mjs` | 12 个文件全过 |
| 快照保真复算（第二轮脚本重跑） | 上游 58 / 包内 58 / 共有 58，仅 82 处路径改写（17 文件），逐文件 sha256 不一致数 **0** |
| lock 可复算 | `sha256sum up.tar.gz`（commit-pinned tarball `b7a8917…`）= `0af11ea7…` == `upstream.lock.json.tarballSha256`；`tarballSource` 已钉 commit（第二轮 R2-2 的「钉移动分支」问题已消除） |

---

## 四、问题清单

### Blocking

**无。**

### Non-blocking（建议 v1.1 或顺手修）

| ID | 严重度 | 问题 | 证据 | 建议改法 |
|---|---|---|---|---|
| N-1 | low | `samePath()` 只做 win32 小写化，不归一化分隔符；若上游/宿主给出的 `path` 用正斜杠（`D:/…/SKILL.md`），`status` 会打出**假的**「与包内路径 **不一致 ✗**」并附「同层有更高优先级/同名的 impeccable」的误导解释 | `lib/commands.js:129`；评审人桩数据（正斜杠路径）实测复现该误报 | 比较前把 `\` 与 `/` 归一（并可去掉重复分隔符 / 做 `realpath`），或在文案里区分「仅分隔符差异」 |
| N-2 | low–medium（文档诚实性） | `README.md:162` 与 `lib/engine.js:12`（A3 注释）称「引擎与钉死版本不一致 ⇒ 记 warning、状态是**可用但自述不一致**」，但 v0.3 已把摘要不符变 fatal（跳过该级），`available` 结果里不会再出现 `verified:false`；`acceptance-evidence.md:63` 已如实写「不可达」，README/A3 未同步 | `lib/engine.js:299`（「摘要不符一律 fatal」）、`:327 fatal:true`、`:427 if (check.fatal) skip` vs `README.md:162` | 措辞改为：摘要不符 ⇒ 跳过该级（视为被改动），不交付可用引擎；**版本漂移只体现在 `status` 的并排显示与 `version.js` 报告**，不产生 hook warning |
| N-3 | low | `verified === false` 相关的两处兜底已成死分支：`availableResult` 的 `warning` 三元（`lib/engine.js:362`）与 `tryLevel` 的 `warning: check.verified === false ? …`（`:443`） | 因 `:427` 先 `fatal` 跳过，`available` 分支永远拿不到 `verified===false` | 二选一：删掉两处 `verified===false` 分支并在 `verifyCandidate` 注释里写明「`false` 只用于内部 fatal 判定」；或保留但在注释标注「当前不可达（见 :427）」 |
| N-4 | info | 下载尚未完成的时间窗：首启后极短时间内热路径会记 `no-engine` 并跳过注入 | AC4 说明段（`acceptance-evidence.md:14`）已披露；§3.2 的整链用例也把该状态固定成断言 | 无需改代码；建议在 `status` 的「注入统计」旁直接提示「引擎自动就绪中」以减少困惑 |
| N-5 | info | 第二轮评审文档 `docs/code-review-round2.md:46` 仍描述 README 有「三级降级」章节（历史件，已随 v0.3 变两级） | `grep -rn "三级" docs/*.md` 唯一命中处 | 若希望 grep 判据更干净，可给该行加「（当时为三级）」的历史标注 |

### 已闭环的上一轮遗留

- R2-1（`lib/engine.js:229` 过时 `verify:'probe'` 注释）：**已修**，现文为「只用在一处 —— `status` 的深度体检（`commands.js` 的 `describeProbe → probeEngineVersion`）」，且 `probeEngineVersion` 确由 `describeProbe` 调用。
- `ensureEngine` / `ENGINE_LEVELS` 删除：**已确认 0 命中**；`verify:'probe'` 选项已彻底移除，`probeEngineVersion` 由 `status` 深度体检实际调用。
- arm64：不再拿 x64 摘要顶替，改为如实拒绝 + `armNote`。
- `findPluginEntry`：已读 `entry.options.name/id` 并优先 `ctx.fiber.entry`；本条由 §3.3 的四步配对在「entry 只有 `options.name`」的情况下实测通过。

---

## 五、放行建议

- **放行 t8（文档收尾/合规）与 t9（验收汇总回写）**：v0.3 无 blocking，三个 blocking 的修复均可复现，回归无退化。
- t9 回写时请一并吸收：§四 N-2 的措辞修正（README/A3 注释）与 N-1 的 `samePath` 归一化建议；并将其登记为非阻塞待办（或安排进 v1.1）。
- 仍需**待人工确认**（评审人无桌面凭据，一律不写成已通过）：AC1 第④层（桌面手敲 `status` 看真实解析路径）、AC10 第④层（破坏事件签名看启动 warning）、AC11 真机「清空缓存→新会话自动补回」、AC12 真机断网首启、AC13 桌面手敲 `on|off` 并核对 profile 落盘。
- **发布前置不变**：LICENSE / NOTICE.md / README 已就位（第二轮已验证 LICENSE 与上游逐字节一致、NOTICE 与上游通知全文一致），但对外推送前仍应按 `docs/completion-summary.md` 的检查表再跑一遍（AC7 GitHub 形态已在第二轮实测）。

---

## 六、可复现命令清单

```bash
cd D:/2026_project/99_dsh/dsh-impeccable-hook
npm test                                            # 104/104 pass, 0 skip
node scripts/check-upstream.mjs                     # exit 0，「✓ 已是最新」
node --check lib/*.js scripts/*.mjs test/*.mjs      # 全过
grep -rn "user-skill" lib test                      # 0 命中
grep -rn "dshHome" lib                              # 0 命中
grep -rn "\.skip\|\.only(\|todo:\|assert.ok(true" test/   # 0 命中
node --input-type=module -e "import {locateEngine} from './lib/engine.js'; console.log(await locateEngine())"
find ~/.impeccable -name "impeccable*" -type f      # 只有 bin/0.1.18 一份 + .verified

# 评审人独立脚本（不属仓库，仅供复算）
node /tmp/verify-bootstrap.mjs   # apply 自触发下载：默认 1 次 fetch，autoDownload:false 时 0 次
node /tmp/verify-warning.mjs     # 自动下载失败：hook 日志恰 1 条 warning，无 no-engine 误记
node /tmp/verify-ac11.mjs        # 空缓存 + 本地假 Release ⇒ 自动下载就位、verified=true、无 .part 残留
node /tmp/verify-onoff.mjs       # status 开 → off → 关 → on → 开，持久化保留其它字段
node /tmp/verify-ac4.mjs         # 真机整链 74.9ms / 23.2ms
```
