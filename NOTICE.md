# Third-Party Notices

This project includes content derived from third-party work, used under the terms of its original license.

## Platform Design Skills

The `skill/reference/ios.md` and `skill/reference/android.md` platform reference files are distilled from ehmo's `platform-design-skills` (Apple Human Interface Guidelines and Material Design 3 rules), rewritten in Impeccable's voice.

**Original work:** https://github.com/ehmo/platform-design-skills
**Original license:** MIT
**Author:** ehmo

---

# 本插件的声明（dsh-impeccable-hook）

上面是上游 `pbakaus/impeccable` 的 `NOTICE.md` 原文，逐字保留不动。以下为本插件（`dsh-impeccable-hook`）追加的声明。

## 非官方声明

**本项目 `dsh-impeccable-hook` 不是 `pbakaus/impeccable` 的官方产物，也未获得该项目维护者的背书或认证。**
它只是社区第三方编写的 DeepSeek Harness 插件，按 Apache License 2.0 的条款使用上游开源的 skill 内容与检测引擎。

## 本插件分发的内容

- 本插件在 `skills/impeccable/` 下分发 `pbakaus/impeccable` 的 **skill 副本**：
  - skill 版本：**4.8.0**
  - 引擎版本：**0.1.18**（上游 Release 预编译资产，不在仓库内入库）
- 上游项目：<https://github.com/pbakaus/impeccable>，许可：**Apache License 2.0**（全文见本仓库 `LICENSE`）。
- 副本的出生证明（commit / 抓取时间 / tarball sha256 / 版本号）记录在 `upstream.lock.json`。

## 本插件自身的改动

- skill 副本相对于上游的**逐条改动**（主要是脚本路径前缀重写，不改 reference 正文）记录在
  `skills/impeccable/MODIFICATIONS.md`。
- 插件自身的实现代码位于本仓库 `lib/`，设计依据见
  `docs/superpowers/specs/2026-10-31-dsh-impeccable-hook-design.md`。
