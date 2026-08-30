# @sleep2agi/agent-network 2.3.0-preview.71

## 为什么发这一版

`.70` 里「创建能力」那几行**在 80 列终端会折行，且折点落在句子中间**。
2026-08-30 由 `Mac打包牛` 在 macOS 真机（隔离前缀、只读、未连 hub）验收发现；
随后逐个 kind 量出**另外两种情况也超宽**（`never-reported` 91 列、`ready-age-unknown`），
那两种他手上没有 daemon 所以看不到。

改后五种 kind 每一行 **≤ 71 显示列**，并加了常驻判据（按显示列算、含分母自证与正控），
不再靠人去数。见 #1573。

🔴 **这一版的存在本身就是 SOP §2.6 的例子**：修复合进 main ≠ 用户拿得到。
`.70` 在 npm 上仍然吐 99 列的那一行，实测确认过。

## Install

新装（首次使用）：

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.71
anet --version
```

## Upgrade

已经装过的：

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.71
anet --version        # 应显示 2.3.0-preview.71
```

验收（按 SOP §2.5 的四步，第 ④ 步不能省）：

```bash
npm view @sleep2agi/agent-network dist-tags.preview          # 2.3.0-preview.71
npm view @sleep2agi/agent-network@2.3.0-preview.71 exports    # 含 ./daemon-capability-display
# ③ npm pack + tar -tzf 列出该文件
# ④ 解包后 import 跑一次,并量首行显示列数 <= 80
```

## 发布方式

`release-gate (v0)` workflow_dispatch，`package=agent-network`、
`version=2.3.0-preview.71`、`publish=true`。**只发 preview 通道**；
promote 到 latest 需要 owner ACK，本次**不做**。
