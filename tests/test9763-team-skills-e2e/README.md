# test9763 — 团队技能端到端

真 hub + 真 agent-node（容器内端口 9763，不碰宿主 hub）。

验收：

- `~/.anet/skills/team-echo` 在 claude 节点启动前被链到 `~/.claude/skills`，`skills_list` 带 `origin:"team"`，`skill_read` 字节与源文件一致
- 日志写「全机生效」，且技能日志不含本机绝对路径
- 已存在、且不是指向团队目录的同名目录不被覆盖
- 两个 codex 节点只链进各自 `config.codexHome/skills`，不链进继承的 `CODEX_HOME`，也不链进 `~/.codex/skills`
- 变异：拿掉 `board-team-skills-install` 那一行之后，重启不再产生链接。no-op 变异由 `tests/lib/mutation-guard.sh` 判红
