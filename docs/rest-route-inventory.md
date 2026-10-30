# REST 端点清单（草稿，非分母）

> 由 `scripts/report-rest-endpoints.py --markdown` 生成，**不要手改**。
> 对象：只扫 `server/src/server.ts`。它不是分母：变量拼的路径、其它文件里的匹配、中间件顺序都看不见。
> **口径**：回答「散落的手写匹配有多少条、各是什么形态、在源码哪一行、哪些 path 出现在多处」，不回答「一共有多少个端点」。

> generated_from: `server/src/server.ts` @ `5ab2abdd6`
> reproduce: `python3 scripts/report-rest-endpoints.py --markdown`
> 重跑后与本文档不一致 ⇒ 本文档过期（它没有经过这一行的生成器就进来了）

| path | 匹配形态 | 源码行 |
|---|---|---|
| `ws` | regex_prefix | :1750 |
| `/mcp` | eq | :1758 |
| `events` | regex_prefix | :1847 |
| `/events/users/me` | eq | :1906 |
| `events` | regex_prefix | :1930 |
| `/api/auth/register` | eq | :2069 |
| `/api/auth/login` | eq | :2084 |
| `/api/auth/me` | eq | :2122 |
| `/api/auth/me/avatar` | eq | :2142 |
| `/api/auth/me/avatar/upload` | eq | :2175 |
| `api` | regex_prefix | :2262 |
| `/api/auth/me` | eq | :2310 |
| `/api/auth/password` | eq | :2335 |
| `/api/auth/node-token` | eq | :2361 |
| `/api/node-rename/prepare` | eq | :2381 |
| `/api/node-rename/commit` | eq | :2400 |
| `/api/node-rename/abort` | eq | :2417 |
| `/api/auth/tokens` | eq | :2435 |
| `/api/auth/tokens` | eq | :2445 |
| `api` | regex_prefix | :2461 |
| `/api/auth/sessions` | eq | :2475 |
| `/api/auth/sessions/revoke-others` | eq | :2485 |
| `api` | regex_prefix | :2499 |
| `/api/networks` | eq | :2514 |
| `/api/networks` | eq | :2544 |
| `api` | regex_prefix | :2564 |
| `api` | regex_prefix | :2611 |
| `api` | regex_prefix | :2680 |
| `api` | regex_prefix | :2722 |
| `api` | regex_prefix | :2781 |
| `api` | regex_prefix | :2782 |
| `api` | regex_prefix | :2822 |
| `api` | regex_prefix | :2843 |
| `api` | regex_prefix | :2844 |
| `api` | regex_prefix | :2845 |
| `api` | regex_prefix | :2846 |
| `api` | regex_prefix | :3035 |
| `api` | regex_prefix | :3131 |
| `api` | regex_prefix | :3184 |
| `/api/networks/join` | eq | :3201 |
| `/api/admin/users` | eq | :3218 |
| `/api/users` | eq | :3247 |
| `api` | regex_prefix | :3258 |
| `/health` | eq | :3335 |
| `/api/node-lifecycle-requests` | eq | :3672 |
| `/api/adoption-candidates` | eq | :3677 |
| `api` | regex_prefix | :3739 |
| `api` | regex_prefix | :3766 |
| `api` | regex_prefix | :3814 |
| `api` | regex_prefix | :3850 |
| `api` | regex_prefix | :3887 |
| `api` | regex_prefix | :4004 |
| `/api/skills` | eq | :4106 |
| `/api/secrets` | eq | :4107 |
| `/api/providers` | eq | :4108 |
| `api` | regex_prefix | :4157 |
| `api` | regex_prefix | :4188 |
| `api` | regex_prefix | :4189 |
| `/api/dm` | eq | :4239 |
| `/api/dm/threads` | eq | :4239 |
| `/api/dm` | eq | :4243 |
| `/api/dm/threads` | eq | :4264 |
| `/api/stats/routes` | eq | :4289 |
| `/api/stats/versions` | eq | :4303 |
| `/api/stats/sse` | eq | :4319 |
| `/api/status` | eq | :4341 |
| `/api/servers` | eq | :4520 |
| `api` | regex_prefix | :4592 |
| `/api/upload` | eq | :4722 |
| `api` | regex_prefix | :5022 |
| `/api/task` | eq | :5153 |
| `/api/broadcast` | eq | :5481 |
| `api` | regex_prefix | :5517 |
| `api` | regex_prefix | :5541 |
| `/api/messages` | eq | :5581 |
| `/api/messages` | eq | :5648 |
| `/api/messages/ack` | eq | :5680 |
| `/api/stats` | eq | :5748 |
| `/api/server-logs` | eq | :5788 |
| `/api/audit-log` | eq | :5804 |
| `/api/task_events` | eq | :5827 |
| `api` | regex_prefix | :5847 |
| `api` | regex_prefix | :5900 |
| `api` | regex_prefix | :5954 |
| `api` | regex_prefix | :6051 |
| `/api/node-create-requests` | eq | :6106 |
| `/api/host-supervisors` | eq | :6127 |
| `/api/nodes` | eq | :6334 |
| `api` | regex_prefix | :6554 |
| `/api/tasks` | eq | :6626 |
| `/api/completions` | eq | :6689 |
| `/api/` | starts_with | :6704 |

共 92 条匹配（去重后 50 条 path+形态；重复 42 条）
（对象：server/src/server.ts；生成于本脚本，**不要手改**）

按 path 分组：50 个不同 path，其中 **8 个出现在多处**（共 50 条匹配）

| path | 处数 | 各处行号 | 形态是否一致 |
|---|---|---|---|
| `api` | 36 | :2262, :2461, :2499, :2564, :2611, :2680, :2722, :2781, :2782, :2822, :2843, :2844, :2845, :2846, :3035, :3131, :3184, :3258, :3739, :3766, :3814, :3850, :3887, :4004, :4157, :4188, :4189, :4592, :5022, :5517, :5541, :5847, :5900, :5954, :6051, :6554 | 是 |
| `/api/auth/me` | 2 | :2122, :2310 | 是 |
| `/api/auth/tokens` | 2 | :2435, :2445 | 是 |
| `/api/dm` | 2 | :4239, :4243 | 是 |
| `/api/dm/threads` | 2 | :4239, :4264 | 是 |
| `/api/messages` | 2 | :5581, :5648 | 是 |
| `/api/networks` | 2 | :2514, :2544 | 是 |
| `events` | 2 | :1847, :1930 | 是 |

⇒ 本日**没有**形态不一致的分组（0 组）—— 所以这一格今天不构成风险；但它必须留在输出里：下次出现时，读者才知道该看哪一栏。
