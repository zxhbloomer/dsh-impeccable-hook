# 代码评审（第二轮）：t10 修复复核

- 评审人：reviewer（未参与编码）
- 评审对象：t10 的修复增补（skill 快照落地、lock 出生证明、`findPluginEntry`、engine.js 死代码清理、N3 写失败闸门）+ 一轮遗留项收敛
- 基线版本：`dsh-impeccable-hook@0.1.0`
- 关联文档：`docs/code-review-S2-S6.md`（第一轮，结论 needs_revision）、`docs/acceptance-evidence.md`

## 一、总结论

**通过（pass）。** 第一轮两个 blocking 全部关闭，且关闭方式是「可复算的事实」而不是措辞：

1. **B1（skill 快照未落地）— 已关闭**：`skills/impeccable/` 现有 59 个文件、1.6MB，内容与上游 commit `b7a8917…` 的 tarball 逐字节可比（见 §二.1 的独立复算）；provider 端到端跑通，`list()` 返回 1 条、`get()` 返回正文，`/impeccable-hook status` 打印的实际解析路径与包内路径**一致 ✓**。
2. **B2（Apache-2.0 合规文件缺失）— 已关闭**：`LICENSE` 与上游 Apache-2.0 全文**逐字节相同**；`NOTICE.md` 逐字保留了上游 NOTICE（503B，sha256 `c60a093c…`）并追加非官方声明；`README.md` 为中文完整文档；`package.json.files` 三者齐全。

遗留的只有 **1 条非阻断注释陈旧**（§三），不影响功能、不影响发布判据。**结论：放行 t8 文档收尾与 t9 验收回写**；但 t9 汇总时 AC7（干净 profile 从 GitHub 安装）仍需在**实际推送后**由人工跑一次，不能用本地等价路径冒充。

## 二、逐条复核（本轮 7 项，全部我自己复跑）

| # | 复核项 | 结论 | 证据（我实跑） |
|---|--------|------|----------------|
| 0 | 基线 | **通过** | 复核窗口内 t10 与我的一轮建议 N3 并行落地，用例数 89 → **91**（`lib/{hook,commands,log}.js` 19:03:49、`test/hook.test.mjs` 19:04:21 各改一次，N3 写失败闸门 + 2 条用例）。**最终态**实跑：`npm test` ⇒ tests 91 / pass 91 / fail 0 / cancelled 0 / skipped 0 / todo 0，618.87ms，exit 0；`node scripts/check-upstream.mjs` ⇒ exit 0，打印「✓ 已是最新：包内快照 0.1.18 与 lock 一致。」；12 个 js/mjs 全部 `node --check` 通过。本文所有证据（含 §二.7 的 N3 代码位置、status 输出）均取自 **19:04 之后的最终态** |
| 1 | B1 快照真落地 | **通过** | 59 文件 / 1.6MB；`SKILL.md` 11755B，frontmatter `name: impeccable`、`version: 4.8.0`、`license: Apache 2.0`；`reference/` 45 文件；`scripts/` 含 VERSION(7B)/command-metadata.json/engine-checksums.txt/data/，**无 .exe**（G5/C8）；provider 数量=1、`list()`=1 条（`rank=900`、`source=custom`、`provider=dsh-impeccable-hook`、`path=<pkg>/skills/impeccable/SKILL.md`）、`get()` 正文 11058 字符、`resourceBase={kind:'directory',…}`；status：**`与包内路径 一致 ✓`**（走 `ctx.skills.get`，非自拼路径） |
| 2 | lock 出生证明真实性 | **通过** | `git ls-remote … refs/heads/main` ⇒ `b7a89176e4e87422b40f98adabceb051dbb5448b`，与 `upstream.lock.json.commit` 一致；下载 `codeload…/tar.gz/refs/heads/main` ⇒ 27811141B、sha256 `176f5ea7…5bf91e`，与 `tarballSha256` **完全一致**，证明该值是真抓的、不是凑的；`fetchedAt` 10:50:20.828Z ≈ 本地 18:50，与文件 mtime 吻合；四个 null 字段已全部消除 |
| 3 | MODIFICATIONS.md 与实际改动一致 | **通过** | 我自写比对脚本：对上游 commit tarball 的 `.dsh/skills/impeccable` 施加文档声明的两条重写规则后逐文件 sha256 比对 ⇒ 上游 58 / 包内(除 MODIFICATIONS.md) 58 / 共有 58，**双向差集为空**、**内容不一致文件 0**；重写次数 82 处 / 17 文件，与 `MODIFICATIONS.md` 记载的「82 处」逐文件吻合（SKILL.md 4、hooks.md 11、live.md 14、new-work.md 13…） |
| 4 | check-upstream 离线可用 | **通过** | 离线即打印「✓ 已是最新」，「快照未落地」告警消失（这正是第一轮 AC6 不可达的根因，现已修复）；`--online` 分支另行可验 |
| 5 | findPluginEntry 规范化 | **通过** | `lib/commands.js:279` 先认 `ctx?.fiber?.entry`（Loader 记录的真实行），回退到「名字匹配」；候选列表含 `entry.options.name` / `entry.options.id`（`lib/commands.js` 的 `findEntryByField`），与参考插件 `dsh-ops/lib/config-updates.js:86-95`、`dsh-better-sidebar/lib/index.js:9244` 的用法对齐；新增 3 条单测（`test/plugin.test.mjs:234` 只有 `options.name` 也能定位、`:252` 优先 fiber.entry、`:272` 深度体检行） |
| 6 | engine.js 死代码清理 | **通过（1 条注释陈旧）** | `ensureEngine`、`ENGINE_LEVELS` 在 `lib/` 与 `test/` 中零命中；`verify` 选项已从 `normalizeOptions` 彻底移除、`'probe'` 分支不存在；`probeEngineVersion` 改为由 `lib/commands.js:127 describeProbe()` 调用并真的出现在 status 里（我实跑到「深度体检 engine-probe 自报 0.1.18（钉死 0.1.18，一致）」）；arm64 由「悄悄回退到 x64 摘要」改为**如实拒绝**（`lib/engine.js:495-500` armNote + 拒绝未校验下载） |
| 7 | 没有为了过测而放水 | **通过** | 全 `test/` 无 `.skip` / `todo:` / `.only(` / `assert.ok(true`；断言总数 95+167+110；第一轮的关键强断言仍在（`dedup===2`、`countItemLines(injected)===8`、`AC10 warnings.length===1`、整链 `noEngine` 增量断言）；用例数 85（一轮）→ 89（t10）→ **91（N3 补 2 条）**，全程净增，无一条被删除或弱化 |

### 额外核过、结论为正的点

- **N3（写失败闸门）不但做了，还做对了位置**：`lib/hook.js:484` `if (result?.isError === true) { log.count('errorSkip'); return next() }` 位于路径提取**之前**，因此 `next()` 仍恰好调用一次（第一轮验证的「恰好一次 + 原样透传」不变量未被破坏）；契约侧确认 `ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure`，其中 `isError: true/false` 是**真实字段**（host Event provider `listEvents tools/post-execute` 的 `referencedTypes`），所以这个闸门不是对着不存在的字段写的死代码。计数器 `errorSkip` 落到 `lib/log.js:83`，并在 `lib/commands.js:250`/`:429` 的 status 与 log 里分别以「写失败跳过」呈现（D10 口径一致），配 2 条单测。
- **合规复核**：`LICENSE` 与上游逐字节相同（191 行 Apache-2.0）；`NOTICE.md` 1820B，其中上游 NOTICE 原文（503B / sha256 `c60a093c2845fd9fb82f9c6f742ece31f379f8190b535309d32d66c45ccffdcb`）**逐字包含**，另附「非官方声明」与「本插件分发内容」；`package.json` 的 `license: "Apache-2.0"` 与 `files` 覆盖 `LICENSE`/`NOTICE.md`/`README.md`/`skills`。**「补齐前不得推 GitHub」的阻塞已解除**，可以推。

## 三、残留问题（非阻断，不影响放行）

| ID | 严重度 | 位置 | 问题 | 改法 |
|----|--------|------|------|------|
| R2-1 | low | `lib/engine.js:229` | 注释写「只在 `verify:'probe'` 或 status 深度体检时用」，但 `verify` 选项已在 t10 中删除，现在**只有** status 深度体检会调用 | 改成「只在 `/impeccable-hook status` 的深度体检里用」；顺手可把 `probeArgs`/`spawnImpl` 的「为跨平台单测预留」注释保留（那句仍准确） |
| R2-2 | low | `upstream.lock.json` | `tarballSha256` 钉的是**移动 ref**（`refs/heads/main`）的 tarball 哈希，不是 commit URL 的（同一 commit 的 commit-URL tarball 哈希为 `0af11ea7…`，与记录值不同）。含义：一旦上游 main 前进，该字段既不可复算也不再代表 commit 内容 | 在 lock 里补一个字段明确来源（如 `tarballSource: "refs/heads/main"`），或改为记录 commit-URL tarball 的哈希；纯文档/字段口径修正，不改代码 |
| R2-3 | low | `skills/impeccable/MODIFICATIONS.md` | 只列了命中 82 处的规则 `relative-dsh-scripts`，未说明脚本里还存在第二条规则 `dsh-home-scripts`（命中 0 处） | 加一行「第二条规则本次命中 0 处」，让「逐条」名副其实 |
| R2-4 | info | `lib/hook.js` 合并路径 | `ToolExecutionSuccess.additionalContexts?` 与 `ToolRunContext.deferContext()` 也是官方的用户消息注入通道；若某个工具自己 defer 了上下文，我们的注入与它可能在 result 与 decision 两侧各存一份。真机与现有测试均未观察到重复 | 无需改动；在 README「已知盲区」补一句即可 |

## 四、是否放行

- **放行 t8（文档收尾）**：合规文件已就位，README 已是中文完整版（非官方声明 / 安装 / 命令 / 三级降级 / 排错 / 许可 8 章齐全）。
- **放行 t9（验收汇总回写）**，但有两项必须**如实标注为「待人工/待推送后」**，不得写成已通过：
  1. **AC7**：`dsh plugin add github:zxhbloomer/dsh-impeccable-hook` 要求仓库已推送且干净 profile 可装；当前仓库未推 GitHub，本地只验证了「绝对路径 add/remove 等价路径」。
  2. **AC1/AC10 的第 ④ 层（桌面端手敲 `/impeccable-hook status`）**：我这轮是用自造 skills 服务 + 真实 apply() 跑通的（status 文本、路径比对、自检行均为真实产物），但「桌面 GUI 里手敲」这一层仍需人工点一次留证。
- **可以推 GitHub**：合规阻塞（LICENSE / NOTICE / README）已解除。

---
评审人：reviewer ｜ 复核时间：2026-10-31 ｜ 复核方式：全部命令与比对脚本由本人在本机实跑，未采信交付说明中的任何数字
