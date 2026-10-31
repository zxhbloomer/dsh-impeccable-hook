# v0.3 方案评审（架构/契约视角）

评审人：独立评审 subagent（2e26572e），2026-10-31。结论：**needs_revision**（3 blocking + 5 non-blocking）。

## Blocking

| ID | 问题 | 证据 | 处置决定（captain 裁决） |
|---|---|---|---|
| B1 | D-15「缓存目录改名 `~/.dsh-impeccable-hook`」与**不可修改**的 skill launcher 冲突：launcher 解析序为 `$IMPECCABLE_BIN` → 同级 `bin/<os>-<arch>` → `~/.impeccable/bin/impeccable` → `${IMPECCABLE_HOME:-~/.impeccable}/bin/<ver>/`。改名后 `/impeccable` 的 CLI 动词找不到引擎，会自行再下一份到 `~/.impeccable`，形成两套缓存，正好复现用户要消除的「混淆」 | `skills/impeccable/scripts/impeccable:3-6,108,122,127-128,155-157,193`；`lib/engine.js:14` 注释 | **取消 D-15**。缓存目录保持 `~/.impeccable/bin/<ver>/` —— 这正是 launcher 默认查找位置，插件与 skill CLI 共用同一份引擎，物理上只有一份。文档需写明「该目录是引擎共用缓存，不是上游残留」 |
| B2 | D-14「启动期自动 ensure」会让既有断言 `sandbox.counter.fetches === 0` 失败（夹具把 `globalThis.fetch` 换成抛错计数器、home 指空目录）；且缺开关与单次保护；`lib/engine.js:166` 默认 `log: () => {}`，不显式传 log 则下载失败完全静默；`:530` 的 `.part` 仅在写失败时清理 | `test/plugin.test.mjs:412-441,479`；`lib/engine.js:166,514,530,533` | 全部采纳：新增 `config.hook.autoDownload`（默认 true）；模块级单次 flag（非 per-handle）；`void ensureEngine(...).catch(...)` 且显式传 `log`；失败路径清理 `.part`；`:479` 用例改为「仅热路径 fetch=0」 |
| B3 | D-16 若「把 `configEditor` 加进 `inject`」会把可选服务变硬依赖，缺服务即整插件加载失败，与 `commands.js:365` 的降级语义冲突；且 `test/plugin.test.mjs:207-229` 的 `createFakeCtx` 是平对象，永远绿，无回归保护 | `lib/commands.js:41-53,364-365`；参考实现 `dsh-ops/lib/config-updates.js:112`、`dsh-mnemon/lib/index.js:17886` | 改用 `ctx.get('configEditor')` 优先：`getService` 里 `ctx[key]` 直取放最后并 try/catch；`'configEditor'` **不进** `inject`；补 Proxy 契约用例（模拟「未 inject 访问即抛」） |

## Non-blocking（本轮一并处理）

1. AC4 既有证据（`acceptance-evidence.md:14`「命中 level=user-skill、35ms」）随 level① 删除作废，须重测，并单列「下载尚未完成时首轮 hook 报 no-engine」的时间窗。
2. `lib/engine.js:158` 的 `dshHome`/`DSH_HOME` 在删 level① 后成为死参数，清掉。
3. 历史文档「allowDownload 零命中」表述在 D-14 后不成立，限定为「仅热路径」：`code-review-S2-S6.md:62`、`completion-summary.md:68`。
4. AC15 只能弱证，改为可执行判据：`grep -rn "user-skill\|用户级已装" README.md docs/*.md` 命中 0（历史修订记录节除外）。
5. `skills/impeccable/MODIFICATIONS.md` 补记缓存位置与「不改 skill 内容」的一致性说明。

## 已确认无风险

- `upstream.lock.json` 的 engineVersion 校验走 `lib/version.js:145-171`（lock ↔ 包内 `skills/impeccable/scripts/VERSION`），与 level 无关；删 level① 后 pin 更权威。
- D-14 与 D11 `runStartupSelfCheck` 不重复：自检调用 listener 不带 `file_path`，`lib/hook.js:339` 之前即返回，永不进 `locateEngine`；插入点 `lib/index.js:225-231` 之后安全。
- `.gitignore`、`upstream.lock.json`、`.github/workflows/verify.yml` 无需改动。
