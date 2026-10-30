# REST 端点清单（草稿，非分母）

> 由 `scripts/report-rest-endpoints.py --markdown` 生成，**不要手改**。
> 对象：只扫 `server/src/server.ts`。它不是分母：变量拼的路径、其它文件里的匹配、中间件顺序都看不见。
> **口径**：回答「有多少条、什么形态、在源码哪一行、同一 path 出现在几处、各自的判别键是什么」，不回答「一共有多少个端点」。

> generated_from: `server/src/server.ts` source_sha256=`a9585bd32a2d`
> reproduce: `python3 scripts/report-rest-endpoints.py --table-json`（或 --markdown）
> 机器可读版本（表草稿，尚未被任何代码消费）：`docs/rest-route-table.json`
> 重跑后与本文档不一致 ⇒ 本文档过期（它没有经过这一行的生成器就进来了）

| 序 | path | method | query 判别 | 匹配形态 | 源码行 |
|---|---|---|---|---|---|
| 1 | `ws` | — | — | regex_prefix | :1750 |
| 2 | `/mcp` | — | — | eq | :1758 |
| 3 | `events` | — | — | regex_prefix | :1847 |
| 4 | `/events/users/me` | GET | — | eq | :1906 |
| 5 | `events` | — | — | regex_prefix | :1930 |
| 6 | `/api/auth/register` | POST | — | eq | :2069 |
| 7 | `/api/auth/login` | POST | — | eq | :2084 |
| 8 | `/api/auth/me` | GET | — | eq | :2122 |
| 9 | `/api/auth/me/avatar` | PUT | — | eq | :2142 |
| 10 | `/api/auth/me/avatar/upload` | POST | — | eq | :2175 |
| 11 | `api` | — | — | regex_prefix | :2262 |
| 12 | `/api/auth/me` | PUT | — | eq | :2310 |
| 13 | `/api/auth/password` | POST | — | eq | :2335 |
| 14 | `/api/auth/node-token` | POST | — | eq | :2361 |
| 15 | `/api/node-rename/prepare` | POST | — | eq | :2381 |
| 16 | `/api/node-rename/commit` | POST | — | eq | :2400 |
| 17 | `/api/node-rename/abort` | POST | — | eq | :2417 |
| 18 | `/api/auth/tokens` | GET | — | eq | :2435 |
| 19 | `/api/auth/tokens` | POST | — | eq | :2445 |
| 20 | `api` | — | — | regex_prefix | :2461 |
| 21 | `/api/auth/sessions` | GET | — | eq | :2475 |
| 22 | `/api/auth/sessions/revoke-others` | POST | — | eq | :2485 |
| 23 | `api` | — | — | regex_prefix | :2499 |
| 24 | `/api/networks` | GET | — | eq | :2514 |
| 25 | `/api/networks` | POST | — | eq | :2544 |
| 26 | `api` | — | — | regex_prefix | :2564 |
| 27 | `api` | — | — | regex_prefix | :2611 |
| 28 | `api` | — | — | regex_prefix | :2680 |
| 29 | `api` | — | — | regex_prefix | :2722 |
| 30 | `api` | — | — | regex_prefix | :2781 |
| 31 | `api` | — | — | regex_prefix | :2782 |
| 32 | `api` | — | — | regex_prefix | :2822 |
| 33 | `api` | — | — | regex_prefix | :2843 |
| 34 | `api` | — | — | regex_prefix | :2844 |
| 35 | `api` | — | — | regex_prefix | :2845 |
| 36 | `api` | — | — | regex_prefix | :2846 |
| 37 | `api` | — | — | regex_prefix | :3035 |
| 38 | `api` | — | — | regex_prefix | :3131 |
| 39 | `api` | POST | — | regex_prefix | :3184 |
| 40 | `/api/networks/join` | POST | — | eq | :3201 |
| 41 | `/api/admin/users` | GET | — | eq | :3218 |
| 42 | `/api/users` | GET | — | eq | :3247 |
| 43 | `api` | — | — | regex_prefix | :3258 |
| 44 | `/health` | — | — | eq | :3335 |
| 45 | `/api/node-lifecycle-requests` | GET | — | eq | :3672 |
| 46 | `/api/adoption-candidates` | GET | — | eq | :3677 |
| 47 | `api` | — | — | regex_prefix | :3739 |
| 48 | `api` | — | — | regex_prefix | :3766 |
| 49 | `api` | — | — | regex_prefix | :3814 |
| 50 | `api` | — | — | regex_prefix | :3850 |
| 51 | `api` | — | — | regex_prefix | :3887 |
| 52 | `api` | — | — | regex_prefix | :4004 |
| 53 | `/api/skills` | — | — | eq | :4106 |
| 54 | `/api/secrets` | — | — | eq | :4107 |
| 55 | `/api/providers` | — | — | eq | :4108 |
| 56 | `api` | — | — | regex_prefix | :4157 |
| 57 | `api` | — | — | regex_prefix | :4188 |
| 58 | `api` | — | — | regex_prefix | :4189 |
| 59 | `/api/dm` | — | — | eq | :4239 |
| 60 | `/api/dm/threads` | — | — | eq | :4239 |
| 61 | `/api/dm` | POST | — | eq | :4243 |
| 62 | `/api/dm/threads` | — | — | eq | :4264 |
| 63 | `/api/stats/routes` | GET | — | eq | :4289 |
| 64 | `/api/stats/versions` | GET | — | eq | :4303 |
| 65 | `/api/stats/sse` | — | — | eq | :4319 |
| 66 | `/api/status` | — | — | eq | :4341 |
| 67 | `/api/servers` | — | — | eq | :4520 |
| 68 | `api` | — | — | regex_prefix | :4592 |
| 69 | `/api/upload` | POST | — | eq | :4722 |
| 70 | `api` | — | — | regex_prefix | :5022 |
| 71 | `/api/task` | POST | — | eq | :5153 |
| 72 | `/api/broadcast` | POST | — | eq | :5481 |
| 73 | `api` | — | — | regex_prefix | :5517 |
| 74 | `api` | — | — | regex_prefix | :5541 |
| 75 | `/api/messages` | — | scope | eq | :5581 |
| 76 | `/api/messages` | — | — | eq | :5648 |
| 77 | `/api/messages/ack` | POST | — | eq | :5680 |
| 78 | `/api/stats` | — | — | eq | :5748 |
| 79 | `/api/server-logs` | — | — | eq | :5788 |
| 80 | `/api/audit-log` | — | — | eq | :5804 |
| 81 | `/api/task_events` | — | — | eq | :5827 |
| 82 | `api` | — | — | regex_prefix | :5847 |
| 83 | `api` | — | — | regex_prefix | :5900 |
| 84 | `api` | — | — | regex_prefix | :5954 |
| 85 | `api` | — | — | regex_prefix | :6051 |
| 86 | `/api/node-create-requests` | GET | — | eq | :6106 |
| 87 | `/api/host-supervisors` | — | — | eq | :6127 |
| 88 | `/api/nodes` | — | — | eq | :6334 |
| 89 | `api` | — | — | regex_prefix | :6554 |
| 90 | `/api/tasks` | — | — | eq | :6626 |
| 91 | `/api/completions` | — | — | eq | :6689 |
| 92 | `/api/` | — | — | starts_with | :6704 |

共 92 条匹配（去重后 50 条 path+形态；重复 42 条）
（对象：server/src/server.ts；生成于本脚本，**不要手改**）

按 path 分组：50 个不同 path，其中 **8 个出现在多处**（共 50 条匹配）

| path | 处数 | 各处行号 | 判别键（method / query） | 形态是否一致 |
|---|---|---|---|---|
| `api` | 36 | :2262, :2461, :2499, :2564, :2611, :2680, :2722, :2781, :2782, :2822, :2843, :2844, :2845, :2846, :3035, :3131, :3184, :3258, :3739, :3766, :3814, :3850, :3887, :4004, :4157, :4188, :4189, :4592, :5022, :5517, :5541, :5847, :5900, :5954, :6051, :6554 | -@:2262 ｜ -@:2461 ｜ -@:2499 ｜ -@:2564 ｜ -@:2611 ｜ -@:2680 ｜ -@:2722 ｜ -@:2781 ｜ -@:2782 ｜ -@:2822 ｜ -@:2843 ｜ -@:2844 ｜ -@:2845 ｜ -@:2846 ｜ -@:3035 ｜ -@:3131 ｜ POST@:3184 ｜ -@:3258 ｜ -@:3739 ｜ -@:3766 ｜ -@:3814 ｜ -@:3850 ｜ -@:3887 ｜ -@:4004 ｜ -@:4157 ｜ -@:4188 ｜ -@:4189 ｜ -@:4592 ｜ -@:5022 ｜ -@:5517 ｜ -@:5541 ｜ -@:5847 ｜ -@:5900 ｜ -@:5954 ｜ -@:6051 ｜ -@:6554 | 是 |
| `/api/auth/me` | 2 | :2122, :2310 | GET@:2122 ｜ PUT@:2310 | 是 |
| `/api/auth/tokens` | 2 | :2435, :2445 | GET@:2435 ｜ POST@:2445 | 是 |
| `/api/dm` | 2 | :4239, :4243 | -@:4239 ｜ POST@:4243 | 是 |
| `/api/dm/threads` | 2 | :4239, :4264 | -@:4239 ｜ -@:4264 | 是 |
| `/api/messages` | 2 | :5581, :5648 | -?scope@:5581 ｜ -@:5648 | 是 |
| `/api/networks` | 2 | :2514, :2544 | GET@:2514 ｜ POST@:2544 | 是 |
| `events` | 2 | :1847, :1930 | -@:1847 ｜ -@:1930 | 是 |

⇒ 同一 path 下**判别键不同**（method/query）的有 6 个：`/api/auth/me`, `/api/auth/tokens`, `/api/dm`, `/api/messages`, `/api/networks`, `api`
   抽表时它们是**不同的行**，且顺序承载语义（更具体的判别必须在前）——
   按 path 做键会把它们合并成一行，而合并后行为改变、测试未必红。
⇒ 本日**没有**形态不一致的分组（0 组）—— 所以这一格今天不构成风险；但它必须留在输出里：下次出现时，读者才知道该看哪一栏。
