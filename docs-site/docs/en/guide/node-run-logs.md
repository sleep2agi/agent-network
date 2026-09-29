# Node run logs

The Run logs section on a node page (运行日志) shows the tail of that node's own agent-node process log, read-only. It is not the same as running [`anet logs`](/en/guide/agent-node) on the machine: that command reads the files locally. This page asks the node, through the Hub, for a tail that has already been redacted.

iOS is still TestFlight, and there is no public link yet. This page describes what you can open on desktop and Android.

The section is on the node page, after Scheduled tasks (定时任务), and it is always shown. Its title and buttons stay in Chinese when the rest of the app is in English.

## The section opens, but most nodes cannot answer yet

A Hub that has already been released accepts the request. The node answers only after it reports `logs_capable`. The node program in the current release channel does not include that yet, so the section usually says 节点版本过旧，升级后可查看日志 (this node is too old; upgrade it to read logs) and the client does not send the request. The page is not broken. Wait for the next node release.

Two other cases do not send a request either:

- The status payload has no `logs_capable` field: 服务器版本过旧，升级后可查看日志 (the server is too old).
- A Claude Code session: Claude Code 会话没有 agent-node 运行日志 (that session has no agent-node run log).

The rest of this page is what happens once the node reports the capability.

## Who can read

Sign in with a user account. The node's owner, and an owner or admin of that network, can read. Other members and viewers cannot. A node token cannot. A node in another network cannot.

The Hub gives the result to the login that asked, once, then deletes it. An unread result is deleted after five minutes. Each live-follow tick is a new request. It does not continue someone else's result.

## What you see

The newest line is at the bottom, and opening the section scrolls there. Errors are red. Warnings are amber.

- **Level**: 全部 (all), 信息 (info), 警告 (warn), 错误 (error). The chosen level matches exactly. It does not mean "this level and worse". Debug lines appear only under 全部. There is no debug button.
- **Search**: case-insensitive, at most 200 characters. It matches the text after redaction, so searching for a token does not find it.
- **Live follow** (实时跟随): a new tail every 3 seconds. It pauses while the app is in the background. A line that shows up again in the same second is dropped by its position. The screen keeps at most 2000 lines and drops the oldest.
- **Copy** (复制): disabled when there are no lines. It copies the lines on screen. It briefly says 已复制 N 行.
- **Export / share**: desktop says 导出 and saves a file such as `demo-node-20260929-153045.log` (local time; characters a filename cannot use in the alias become underscores). A phone says 分享.
- **Refresh** (刷新): asks again. A failure can be retried.

On desktop, Ctrl+F or ⌘F focuses the search box. Desktop can select the log text. A phone cannot; use copy.

When more lines matched than are on screen, the footer says 只显示最新的 N 行（共 M 行匹配） (showing the latest N of M matches).

## What the node reads

There is no path argument. The node reads only its own log directory and does not follow symlinks there. If it has daily files named `YYYY-MM-DD.log`, it reads the latest two days. Otherwise it reads the newest `start-*.log`. Each file contributes only its last 4MB. A line longer than 4000 characters is cut and marked with 「…(截断)」. The screen asks for 500 lines. Calling the [MCP tool](/en/api/mcp-tools) `tail_node_logs` directly allows at most 2000 lines; more than that is rejected, and `debug` is not a valid level argument.

Before the text leaves the node, tokens (`ntok_`, `utok_`, `atok_`), Bearer, Authorization, and values whose key name contains token, key, secret, or password are replaced with `[REDACTED]`.

## Empty and failed

- No log files yet: 节点还没有写运行日志.
- Files exist, but the level or the search matched nothing: 没有匹配的日志行.
- Files exist and they have no lines: 日志是空的.
- The node does not answer: 节点没有响应（可能离线）.
- The node failed while reading: the node's reason is included.
- The wrong role, a node token, the wrong network, or an unknown node: each has its own sentence. None of these is shown as an empty log.

## See also

- [Agent Node](/en/guide/agent-node) (local `anet logs`)
- `tail_node_logs` in [MCP Tools](/en/api/mcp-tools)
- [Desktop and mobile clients](/en/guide/desktop-app)
