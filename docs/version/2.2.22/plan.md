# 2.2.22 热修规划（latest 补丁 · 范围冻结为单一修复）

> 目的：让 **latest 稳定版的 Windows 用户不再崩**。范围就一条，不夹带。

| 内容 | 说明 |
|---|---|
| 唯一修复 | #446：`anet --version`（及一切读自身 package.json 的命令）在 Windows cwd 盘 ≠ 安装盘时 ENOENT 崩溃；修法 `fileURLToPath()`（已在 preview 验证） |
| 基线 | 2.2.21 的发布基线 commit（**待定位**——当时未打 git tag，需从 npm tarball 内容反查） |
| 流程 | 定位基线 → cherry-pick 单一修复 → 构建 → 真 Windows 验证 → 发 2.2.22（latest tag，两阶段） |
| 卡点 | 基线定位 + owner 拍板发 latest |
| 明确不带 | codex-app-server / OpenCode / 其它 preview 功能一概不进 latest 补丁 |
