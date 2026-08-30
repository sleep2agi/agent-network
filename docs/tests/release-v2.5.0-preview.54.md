# @sleep2agi/agent-node 2.5.0-preview.54 — release notes

一条修复，但它修的是**用户照着官方提示做也修不好**的那种。

- **`anet_bin_source` 给出的修复命令根本跑不通**（PR #1521，#1353）。daemon 丢了 `ANET_BIN` pin 之后，
  错误信息里的 `Fix:` 是用户拿到的**唯一**修法，而它有两个独立缺陷，**都不会报「你没权限」**：

  ① **shell 语法就不成立**：`"$(node -e \"…\" …)"` —— `$( )` 内部的 `\"` 不是转义、是语法错误。
     实测 `bash -n` **rc=2**：`syntax error near unexpected token '('`。粘进终端**一步都不执行**。
  ② **sudo 盖错了半边**：`install -d -m 0755 /etc/anet-daemon` **没有** sudo，普通用户下实测 exit 1
     （`install: cannot change permissions of '/etc/anet-daemon': No such file or directory`）
     ⇒ `&&` 当场断链 ⇒ 后面的 `sudo tee` **根本不执行** ⇒ path.conf 没写成。

  **一条跑不通的修复建议比没有建议更糟：它让人以为自己已经修过了。**

  现在的命令（POSIX 分支；Windows 那条是 PowerShell、不受影响）：

  ```bash
  ANET_BIN_REAL="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$(command -v anet)")" \
    && sudo install -d -m 0755 /etc/anet-daemon \
    && printf 'ANET_BIN_ABS=%s\n' "$ANET_BIN_REAL" | sudo tee /etc/anet-daemon/path.conf >/dev/null
  ```
  node 内联脚本改用单引号包（内部才用 `"fs"`，两层引号不再打架）；`sudo` 盖住建目录；
  realpath 在 sudo **之前**算好存进变量（root 环境里 `command -v anet` 可能解析到另一个二进制）。
  实测 `bash -n` rc=0、非 sudo 段真跑通。

🔴 **#1353 的持久化方向本身不在本版**：那两条路被堵是**设计**（`/etc/anet-daemon/path.conf` 是
root 拥有的 production trust root），**不要**改成"用户可写的 path.conf" —— daemon 用这个路径
**执行**每个子节点，一旦它由 daemon 自己那个用户可写，拿到该用户权限的东西就能把它指向自己的脚本。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.69 @sleep2agi/agent-node@2.5.0-preview.54
```

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.54
anet node restart <节点名>
```

## 本版包含

| PR | issue | 内容 |
|---|---|---|
| #1521 | #1353 | `anet_bin_source` 的修复命令改成实测可执行（bash -n rc=0 + sudo 盖住建目录） |
