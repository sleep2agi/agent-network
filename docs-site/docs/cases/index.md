# 案例

当前保留的 Agent Network 案例，从简单到复杂。带 `demos/` 目录的案例可用 Docker 一键启动，其余为基于当前 CLI 和 Dashboard 的手动流程。

## 入门案例

| 案例 | 难度 | Agent 数量 | 用到的模型 | 亮点 |
|------|:----:|:---------:|-----------|------|
| [你好世界](/cases/hello-world) | ★ | 2 | MiniMax | 最简单的两个 Agent 对话 |
| [翻译流水线](/cases/translation-pipeline) | ★★ | 3 | MiniMax + DeepSeek | 中→英→日 链式翻译 |
| [代码审查](/cases/code-review) | ★★ | 3 | Claude + DeepSeek | 写代码 + 自动 Review |

## 进阶案例

| 案例 | 难度 | Agent 数量 | 用到的模型 | 亮点 |
|------|:----:|:---------:|-----------|------|
| [成语接龙](/cases/idiom-chain) | ★★★ | 5 | MiniMax | 多 Agent 游戏对战 |
| [军团编队](/cases/telegram-squad) | ★★★★ | 11 | Codex + MiniMax | 1 指挥 + 10 兵，Docker 编排 |
| [混合模型协作](/cases/mixed-model) | ★★★ | 4 | Claude + MiniMax + DeepSeek | 不同模型各司其职 |

::: tip 运行案例前
确保已完成 [上手指南](/guide/getting-started)，CommHub Server 正在运行。

已删除未实现或仅占位的行业案例页面。多 Agent 手动案例依赖模型能力和当前网络状态，推荐先跑通 `demos/hello-world` 或 `demos/translation-pipeline`。
:::
