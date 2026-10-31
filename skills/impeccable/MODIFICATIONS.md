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
