# REST 端点清单（草稿，非分母）

> 由 `scripts/report-rest-endpoints.py --markdown` 生成，**不要手改**。
> 对象：`server/src/server.ts`（只是这一个文件）。
> 它不是分母：变量拼的路径、其它文件里的匹配、中间件顺序都看不见。
| path | 匹配形态 |
|---|---|
| `/api/` | starts_with |
| `/api/admin/users` | eq |
| `/api/adoption-candidates` | eq |
| `/api/audit-log` | eq |
| `/api/auth/login` | eq |
| `/api/auth/me` | eq |
| `/api/auth/me/avatar` | eq |
| `/api/auth/me/avatar/upload` | eq |
| `/api/auth/node-token` | eq |
| `/api/auth/password` | eq |
| `/api/auth/register` | eq |
| `/api/auth/sessions` | eq |
| `/api/auth/sessions/revoke-others` | eq |
| `/api/auth/tokens` | eq |
| `/api/broadcast` | eq |
| `/api/completions` | eq |
| `/api/dm` | eq |
| `/api/dm/threads` | eq |
| `/api/host-supervisors` | eq |
| `/api/messages` | eq |
| `/api/messages/ack` | eq |
| `/api/networks` | eq |
| `/api/networks/join` | eq |
| `/api/node-create-requests` | eq |
| `/api/node-lifecycle-requests` | eq |
| `/api/node-rename/abort` | eq |
| `/api/node-rename/commit` | eq |
| `/api/node-rename/prepare` | eq |
| `/api/nodes` | eq |
| `/api/providers` | eq |
| `/api/secrets` | eq |
| `/api/server-logs` | eq |
| `/api/servers` | eq |
| `/api/skills` | eq |
| `/api/stats` | eq |
| `/api/stats/routes` | eq |
| `/api/stats/sse` | eq |
| `/api/stats/versions` | eq |
| `/api/status` | eq |
| `/api/task` | eq |
| `/api/task_events` | eq |
| `/api/tasks` | eq |
| `/api/upload` | eq |
| `/api/users` | eq |
| `/events/users/me` | eq |
| `/health` | eq |
| `/mcp` | eq |
| `api` | regex_prefix |
| `events` | regex_prefix |
| `ws` | regex_prefix |

共 50 条（对象：server/src/server.ts；生成于本脚本，**不要手改**）
