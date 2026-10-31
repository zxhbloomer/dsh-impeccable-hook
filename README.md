# dsh-impeccable-hook

把 [impeccable](https://github.com/pbakaus/impeccable) 的 **设计 skill** 随包分发到 DeepSeek Harness，并复刻它的 **design hook**：你改完 UI 文件后自动跑确定性检测，把 findings 回灌给模型，模型下一轮主动修——不用你记得手动跑。

> **非官方声明**：本插件不是 `pbakaus/impeccable` 的官方产物，也未获其维护者背书。许可见文末。

---

## 1. 参考了什么项目

| 项目 | 许可 | 参考了什么 |
|---|---|---|
| [`pbakaus/impeccable`](https://github.com/pbakaus/impeccable) | Apache-2.0 | **skill 内容来源**（`skills/impeccable/` 是其快照副本）；design hook 的输入输出协议（`hookSpecificOutput.additionalContext`）；引擎发布形式与 `engine-checksums.txt` sha256 校验；`docs/CLI-CONTRACT.md` |
| [`Cassius0924/dsh-impeccable`](https://github.com/Cassius0924/dsh-impeccable) | MIT | **借鉴**：双阶段分层思路、去重缓存、每回合最多拦一次、skill 路径自愈、0-Token 命令分流。<br>**刻意不抄**：进程内 `import` 上游私有函数（上游一改就崩）、vendored 老引擎（20MB 二进制入库、跨平台不可用）、占位空包（装得上但没功能） |
| `superpowers-dsh@0.4.0` | — | 包结构、`ctx.skills.registerProvider` 写法、sync-from-upstream 思路 |
| DSH 内置 `dsh-repeat-tool-reminder` | — | `tools/post-execute` 的精确写法（`additionalContexts` 前置合并、`UserMessage[]` 形状） |

许可合规文件：`LICENSE`（上游 Apache-2.0 全文，逐字复制）+ `NOTICE.md`（上游原文 + 本插件追加声明）+ `skills/impeccable/MODIFICATIONS.md`（skill 副本逐条改动）。

---

## 2. 本插件做什么 / 不做什么

### 做什么

| 编号 | 能力 |
|---|---|
| G1 | **skill 随包分发**：装完 `/impeccable` 立即可用，不需要另外装 skill |
| G2 | **design hook**：编辑 UI 文件（`.tsx/.vue/.html/.css` 等白名单扩展名）后调引擎检测，findings 以 `[impeccable@1] …` 形式进模型下一轮上下文 |
| G3 | **0-Token 宿主命令** `/impeccable-hook`：查引擎在不在、hook 开没开、注入过几次 |
| G4 | **版本可追溯**：内置快照版本钉死在 `upstream.lock.json`；上游升级能被发现（`scripts/check-upstream.mjs`），但不阻断 |
| G5 | **只走 GitHub 安装**：仓库内是已构建纯 JS，零构建、无 `node_modules` |

### 非目标（明确不做）

| 编号 | 非目标 | 原因 |
|---|---|---|
| N1 | 不做 Web「设计」面板 | findings 已直接进模型上下文；面板是给人做设计探索用的 |
| N2 | 不在本机编译 Rust 引擎 | 用户机器无 Rust 工具链；直接用上游预编译资产 |
| N3 | 不发布 npm | `dsh-impeccable` 名字已被占；用户只要 GitHub 安装 |
| N4 | 不改上游 skill 正文 | 只重写脚本路径前缀，不改 `reference/` 正文 |
| N5 | 不做设计判断 | 审美是模型的活；引擎只做机械判定 |
| N6 | v1 不做每日 CI 巡检 | 无人升级时只产噪音；`upstream.lock.json` + 手动脚本已够 |

---

## 3. 安装

> **当前状态**：本仓库尚未推送到 GitHub。**S9 步骤（推送到 `github.com/zxhbloomer/dsh-impeccable-hook`）完成并需要用户点头之后**，下面这条命令才可用。

```bash
dsh plugin add github:zxhbloomer/dsh-impeccable-hook
```

装完后：

1. 新开一个会话（插件在启动时 `apply()`）；
2. 敲 `/impeccable-hook status`，确认引擎、skill 路径、开关三项；
3. 敲 `/impeccable shape` 之类试一下 skill 是否可用。

卸载：`dsh plugin remove dsh-impeccable-hook`。

---

## 4. 命令与参数

### 4.1 `/impeccable-hook`（本插件注册的宿主命令，0-Token，不产生 model 消息）

```text
/impeccable-hook status          # 默认动作，等价于不带参数
/impeccable-hook status download # 同上，且引擎缺失时下载官方引擎（约 20MB，sha256 校验）
/impeccable-hook on | off        # 开关 design hook（写插件 config，立刻生效，不用重启）
/impeccable-hook log [n]         # 最近 n 条注入/跳过记录，n 默认 20
```

#### `status` 输出字段

| 区块 | 内容 |
|---|---|
| **hook 开关** | 开 / 关，以及 `config.hook.enabled` 的实际值 |
| **启动自检** | `tools/post-execute` 是否挂上、`PostToolDecision` 形状是否存活；失败时命令标红（`kind=error`）并打印原因——含义是本版插件与当前 DSH 契约不匹配，hook 不会生效 |
| **skill 解析** | **实际解析到的 `SKILL.md` 绝对路径**、`provider=` / `source=` / 视图（`scoped` 或 `global`）、与包内路径「一致 ✓ / 不一致 ✗」。不一致说明同层有更高优先级的同名 skill 顶掉了包内副本 |
| **引擎** | `level=`（①用户级已装 / ②`~/.impeccable` 缓存 / ③官方下载）、`label=`、`path=`、版本（与 lock 钉死版本并排）、`verified=`、摘要校验结论、深度体检（`engine-probe` 自报的版本）。找不到时打印「未找到（三级降级全部失败）」+ 逐级失败原因 |
| **注入统计** | 已注入 N 次 / M 条 / K 字符；去重跳过、配额用尽；引擎调用次数、超时、无引擎、错误、白名单外跳过；上次结果 `ok\|timeout\|no-engine\|dedup\|error\|…` 与时间 |
| **会话配额** | 已用 findings 数 / 上限、已用字符 / 上限、top-N 当前值 |
| **版本三件套** | 插件版本、内置快照版本、快照漂移（一致 / 落后 / 领先）、引擎版本、出生证明（`upstream.lock.json` 的 repo@ref 与抓取时间）、上游巡检提示 |
| **已知盲区** | 只覆盖带 `file_path` 的写类工具；用 shell 重定向 / `node -e` 写文件抓不到（两条盲区的完整说明见 §7.5） |

#### `on` / `off`

- 立刻切换运行期开关（本会话立即生效）；
- 把 `hook.enabled=<true|false>` 写回**插件 config**（profile 的 `cordis.patch.yml` 里本插件那一行）；
- **绝不写**用户仓库的 `.impeccable/config.json`（那份是只读的，引擎自己会写）。

若 `configEditor` 服务不可用或定位不到插件行，命令会明确说「本会话已生效，但**没能持久化**」，并给出要手改的键。

#### `log [n]`

- `n` 是正整数，缺省 20；
- 先打一行计数汇总（同 `status` 的注入统计）；
- 再打明细表：`时间 | 结果 | 文件 | 条数（注入/发现）| 耗时(ms) | 原因`；
- 本进程内无记录时明确写「暂无记录」，不假装有数据。

### 4.2 `/impeccable <子命令> [目标]`（由 **skill** 提供，插件不注册同名命令）

共 **24** 个子命令。**插件绝不注册 `/impeccable`**——客户端会优先把 `/name` 解析成宿主命令，注册同名命令会抢掉 skill 的用户入口。

| 分组 | 子命令 |
|---|---|
| **构建** | `craft [feature]`（废弃兼容别名，无额外行为）、`shape [feature]`（写代码前先规划 UX/UI）、`init`（项目初始化：访谈并写 `PRODUCT.md`）、`document`（从代码库提炼 `DESIGN.md` 设计系统）、`extract [target]`（把重复模式/组件/token 收进设计系统） |
| **评估** | `critique [area]`（UX 视角评审：层级、信息架构、情感共鸣）、`audit [area]`（技术质量检查：可访问性、性能、主题、响应式、anti-pattern，输出 P0–P3 打分报告） |
| **精修** | `polish`（交付前最后一轮细节打磨）、`bolder`（加大视觉力度）、`quieter`（收敛过度刺激的设计）、`distill`（去冗余、回到本质）、`harden`（生产就绪：错误处理、i18n、文本溢出、边界情况）、`onboard`（引导流、首启、空状态） |
| **增强** | `animate`（动效与微交互）、`colorize`（补战略性色彩）、`typeset`（字体、层级、字号、可读性）、`layout`（布局、间距、视觉节奏）、`delight`（惊喜细节与个性）、`overdrive`（高冲击、技术上更激进的实现） |
| **修复** | `clarify`（UX 文案、错误信息、标签）、`adapt`（断点、流式布局、触摸目标、多端适配）、`optimize`（加载、渲染、动画、图片、包体积） |
| **迭代** | `live`（浏览器里点选元素、实时换 HMR 变体，需开发服务器）、`generate [n] [action] [element]`（自动在页面找到元素并生成 n 个方向的变体） |

**参数归属**：子命令是 **skill 的分派关键字**，目标（`[target]` / `[area]`）是**给模型的自然语言目标**，插件不解析。例如 `/impeccable audit src/views` 里的 `src/views` 只是告诉模型审计哪里；只有 skill `reference/` 里写明的引擎调用（如 `impeccable detect --json <path>`）才真正把路径交给引擎。

---

## 5. 引擎三级降级与「热路径不下载」

引擎是可执行文件（`impeccable[.exe]`），按以下顺序查找，命中即用：

| 顺序 | 来源 | 说明 |
|---|---|---|
| ① `user-skill` | `$DSH_HOME/skills/impeccable/scripts/bin/<os>-<arch>/impeccable[.exe]` | 用户自己装过 skill 的那一份 |
| ② `user-cache` | `~/.impeccable/bin/<engineVersion>/impeccable[.exe]` | 上游 launcher 的标准版本化缓存位 |
| ③ `download` | `https://github.com/pbakaus/impeccable/releases/download/engine-v<ver>/impeccable-<os>-<arch>[.exe]` | 约 20MB，按 `engine-checksums.txt` 校验 sha256 |

全部失败 ⇒ **不抛错、不做副作用**，返回 `{ available:false, reason, attempts }`；skill 照常可用，hook 静默关闭，`status` 逐级说明原因（AC3）。

**热路径不下载（D12）**：hook 每次编辑都会定位引擎，但只**定位**（`locateEngine`，`allowDownload:false`），永不联网。下载只发生在显式动作 `/impeccable-hook status download`，流程为「写临时文件 → 校验 sha256 → 原子 rename」，任何一步失败都不留脏文件。

引擎版本**只读 `scripts/VERSION`**（C10）——`impeccable --version` 返回的是 **skill 版本**（4.8.0），不能用它判断引擎版本。

其他约定：Windows 必须交出真实 win32 绝对路径（盘符 + 反斜杠），POSIX 风格路径会让引擎静默 `exit 0`；引擎版本与 lock 钉死版本不一致时不静默，记 warning 并在 `status` 可见；上游没有 Windows-on-ARM 资产，arm64 机器如实报「不支持」，不拿 x64 摘要顶替。

---

## 6. 配置项与文件位置

### 插件 config（真源）

在 **profile 的 `cordis.patch.yml`** 里本插件那一行（`id: dsh-impeccable-hook`）的 `config` 段：

```yaml
- insert:
    - id: dsh-impeccable-hook
      name: 'dsh-impeccable-hook'
      config:
        hook:
          enabled: true              # design hook 总开关（/impeccable-hook on|off 改的就是它）
          topN: 8                    # 单次最多注入多少条 findings（1–100）
          maxFindingsPerSession: 40  # 全会话 findings 配额（1–10000 条）
          maxCharsPerSession: 12000  # 全会话字符配额（500–200000）
          timeoutMs: 3000            # 单次引擎调用超时（100–60000 ms），超时算「跳过」
          allowedExts: ['.tsx', '.jsx', '.html', '.htm', '.vue', '.svelte', '.astro',
                        '.css', '.scss', '.sass', '.less', '.ts', '.js']
```

- 非法值一律**夹紧到区间**或退回默认，不会因为一个错配置把 hook 打死；
- 只有显式 `false` / `'false'` / `0` 才算关闭；
- 名单外扩展名（`.md` / `.java` / `.json` …）根本不会调用引擎，零开销（AC8）。

### 文件与环境变量

| 位置 / 变量 | 含义 |
|---|---|
| `lib/` | 插件实现：`index.js`（组合根）、`hook.js`、`engine.js`、`commands.js`、`config.js`、`log.js`、`version.js` |
| `skills/impeccable/` | 上游 skill 快照（`SKILL.md`、`reference/`、`scripts/`、`MODIFICATIONS.md`） |
| `upstream.lock.json` | 出生证明：`skillVersion` / `engineVersion` / `cliVersion` / `commit` / `fetchedAt` / `tarballSha256` |
| `cordis.patch.yml` | bundle patch，把本插件插进宿主插件表 |
| `$DSH_HOME`（默认 `~/.dsh`） | DSH 家目录；①级引擎位置、同层 skill 冲突都发生在这里 |
| `IMPECCABLE_HOME`（默认 `~/.impeccable`） | ②级引擎缓存根 |
| `IMPECCABLE_DOWNLOAD_BASE` | ③级下载通道覆盖（默认上游 Release 地址） |
| `<工程>/.impeccable/config.json`、`hook.cache.json` | **引擎自己写**的工程级缓存；本插件只读不写。跨进程也会压住重复注入，所以演示「首次注入」要换新工程目录 + 新 session |

### 维护者操作（不需要终端用户执行）

```bash
node scripts/sync-upstream.mjs             # 从 pbakaus/impeccable@main 同步 skill 快照并更新 lock
node scripts/check-upstream.mjs            # 离线：比对包内快照版本与 lock
node scripts/check-upstream.mjs --online   # 联网：比对上游 main 是否有新版本（退出码恒 0，不阻断）
npm test                                   # node --test 全量单测
```

---

## 7. 排错

### 7.1 引擎缺失 / hook 不生效

先跑 `/impeccable-hook status`，看「引擎」区块：

- `引擎 未找到（三级降级全部失败）` → 下面会逐级列出原因（文件不存在 / 不是原生绝对路径 / sha256 不符 / 清单没收录该平台资产）；
- 需要插件下载官方引擎：`/impeccable-hook status download`（约 20MB，sha256 校验）；内网可先设 `IMPECCABLE_DOWNLOAD_BASE` 指向镜像；
- 卸载/损坏的缓存会被忽略（sha256 对不上就不使用），删掉重下即可；
- **Windows-on-ARM** 上上游没有 arm64 引擎，如实报不支持，不会拿 x64 顶替。

### 7.2 skill 双来源冲突（`/impeccable` 打开的是旧版 skill）

`status` 的「skill 解析」会同时给出**实际解析到的 `SKILL.md` 绝对路径**与「与包内路径 一致 ✓/✗」：

- ✗ 说明同层有更高优先级的同名 skill（最常见：`$DSH_HOME/skills/impeccable` 你自己装过一份），包内副本没生效；
- 处理：删掉/改名那份用户级 skill，或调整优先级后重启会话；插件**不会**自动删用户文件；
- 判断依据永远是**实际路径**，不是猜。

### 7.3 改了 UI 文件但「无回显」（下一轮没有 `[impeccable@1]`）

按顺序排查：

1. `/impeccable-hook status` → hook 开关是否「开」；启动自检是否 ✗（契约不匹配时 hook 根本不挂）；
2. **文件扩展名**是否在白名单里（`.md` / `.java` / `.json` 等不触发，AC8）；
3. 是否用的**写类工具**（`edit` / `write` / `apply_patch` …）：只用 `ops_bash` 里 `echo > file` / `sed -i` 写文件**抓不到**——这是已知盲区；
4. 注入统计里「引擎调用 / 超时 / 无引擎 / 错误」哪一项在涨；超时（默认 3s）算跳过，加大 `timeoutMs` 或查引擎是否被杀软拦；
5. 「去重跳过」在涨 ⇒ 同一文件同一问题**已经报过**（AC5 的预期行为），不是故障；
6. 「配额用尽」在涨 ⇒ 本会话 findings / 字符已达上限，重开会话或调 `maxFindingsPerSession` / `maxCharsPerSession`；
7. `log 50` 看最近明细里的 `原因` 列，那里写的是人话。

### 7.4 其他

- `status` 里「快照漂移 快照 X 落后于 lock Y」⇒ 包打错了，维护者应跑 `scripts/sync-upstream.mjs`；
- 「出生证明 未找到 `upstream.lock.json`」⇒ 打包漏文件；
- `on/off` 报「没能持久化」⇒ 手改 profile 的 `cordis.patch.yml` 里 `hook.enabled`。

### 7.5 已知盲区（如实说明，来自第二轮评审 R2-4）

1. **注入通道可能重复一份**：宿主工具自身的 `deferContext()` 与本插件的 decision 侧注入（`additionalContexts`）是两条并列的官方用户消息通道。若某个工具自己也 defer 了上下文，同一批 findings 在理论上可能在 result 与 decision 两侧各存一份——**真机与现有测试均未观察到重复**。假若某天真的看到同批 findings 出现了两次，定位办法：在 `$DSH_HOME` 下本插件所在 profile 的 `cordis.patch.yml` 里把本插件 `hook.enabled` 关掉再跑一次对照，若重复消失即可确认来自本插件这条通道，而不是宿主工具自己 defer 的那份。
2. **非写类工具改文件不会被扫**（真实存在、已确认，不是待观察项）：本插件的判定依据是**写类工具名 + 结果里的 `file_path`**（`edit` / `write` / `apply_patch` / `multi_edit` 等 11 个名字）。因此用 `ops_bash` 里的 shell 重定向（`echo > f`、`cat <<EOF > f`）、`sed -i`、`node -e "fs.writeFileSync(...)"` 这类方式改文件，**完全不会触发检测**——即使改的是白名单内的 `.css` / `.tsx`。要覆盖这类改动，请改用写类工具，或手动跑引擎（`impeccable detect --json <path>`）。

---

## 8. 非官方声明与许可

- **非官方**：本项目 `dsh-impeccable-hook` **不是** `pbakaus/impeccable` 的官方产物，未获其维护者背书或认证。
- 本插件分发 `pbakaus/impeccable` 的 skill 副本（skill **4.8.0** / engine **0.1.18**），许可见 `LICENSE`（Apache License 2.0 全文，逐字复制自上游，未改写）。
- 上游 `NOTICE.md` 原文逐字保留在本仓库 `NOTICE.md` 开头，其后为本插件的追加声明；skill 副本中对上游的逐条改动见 `skills/impeccable/MODIFICATIONS.md`。
- 设计依据与全部约束/决策：`docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md`。
