# MODIFICATIONS.md —— 本包对上游 impeccable skill 快照做过的改动

上游：pbakaus/impeccable（Apache-2.0，ref=main，commit=b7a89176e4e87422b40f98adabceb051dbb5448b）
tarball sha256：`0af11ea7f3d0accd91ea7c52bbe53e4e01c6a9505693617e9ac2c676767557ba`
tarball 来源（钉 commit 不钉分支）：`https://codeload.github.com/pbakaus/impeccable/tar.gz/b7a89176e4e87422b40f98adabceb051dbb5448b`
同步工具：`node scripts/sync-upstream.mjs`（只改写脚本路径前缀，不改正文，D6）

## 路径重写（逐条）

- `dsh-home-scripts`：0 处 → 改为 `<skill-base-dir>/scripts`
- `relative-dsh-scripts`：82 处 → 改为 `<skill-base-dir>/scripts`

## 未改动

- reference/ 正文、command-metadata.json、engine-checksums.txt 一律原样保留。
- 引擎二进制不入库（G5/C8）：安装时按 engine-checksums.txt 校验后下载。

## 引擎缓存位置（本插件的约定，不是对上游正文的改动）

v0.3 起引擎只有两处来源，第一级就是上游 launcher 的默认缓存位：

- **① 共用缓存**：`${IMPECCABLE_HOME:-~/.impeccable}/bin/<engineVersion>/impeccable[.exe]`（同目录另存 `<可执行文件名>.verified` 戳，内容为 `<sha256> <字节数>`）。这个目录**既是本插件的引擎缓存，也是上游 skill launcher 的默认查找位置**（launcher 解析序：`$IMPECCABLE_BIN` → 同级 `bin/<os>-<arch>` → `~/.impeccable/bin/impeccable` → `${IMPECCABLE_HOME:-~/.impeccable}/bin/<ver>/`），所以两边共用**同一份**二进制，物理上不会出现第二份缓存。**它不是「上游残留」，不要为了「干净」改名或删除**——改名会导致 launcher 与本插件各自下载一份。
- **② 官方 Release 下载**：`https://github.com/pbakaus/impeccable/releases/download/engine-v<ver>/impeccable-<os>-<arch>[.exe]`，按本目录 `scripts/engine-checksums.txt` 校验 sha256 后**原子 rename** 落到①；临时文件校验失败即删，不留半截文件。

引擎**不随本快照分发**（`skills/impeccable/` 内 `.exe` 命中 0），由插件在首次启动时后台备齐（`hook.autoDownload`，默认开），或用 `/impeccable-hook status download` 显式下载。

> 维护提示：本节是**手工补充**。`node scripts/sync-upstream.mjs` 会整文件重写本文件（`writeModifications()`），届时本节会丢失——重跑同步后请把本节重新补上，或在后续版本里并进脚本模板（v1.1 待办）。
