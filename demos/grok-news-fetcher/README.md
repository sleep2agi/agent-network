# demos/grok-news-fetcher — A站 ai-insight 兜底新闻抓取脚本

> **Pitch**: 用 grok-build CLI 0.2.x 的 headless 模式 (`grok -p ... --output-format json`) 当 X (Twitter) 新闻抓取的*兜底源*，给 A站 [ai-insight](https://ai-insight.org) 在 twitterapi.io 402 额度耗尽后顶上。
>
> 输出 schema 跟 ai-insight 现有 `auto_update_news.js --fetch-only` **一字不差**，可直接接入其下游翻译 / 写库管线。

## 背景

- A 站 ai-insight 用 `twitterapi.io` 抓 10 个锚定账号的最新推文，翻译入库再发布。
- 2026-06-03 起 twitterapi.io 返 **HTTP 402 quota exceeded**，管线断流，6-03 起每日抓取 0 条。
- Vincent 决定用 grok-build (已实证支持 native X 搜索，见 [`demos/grok-x-search/`](../grok-x-search/)) 当**兜底**而非主源 — 频率低、容忍 LLM 输出微抖动。

## 交付内容

| 文件 | 作用 |
|------|------|
| [`fetch_news_via_grok.js`](./fetch_news_via_grok.js) | 主脚本 (Node.js, 无 npm 依赖) |
| `README.md` | 本文 |

零 npm 依赖、纯 Node.js stdlib (`child_process`, `fs`, `path`)，方便丢任意机器或 cron 上跑。

## 前置

- Node.js ≥ 18 (用 `node:child_process` 等内建模块)
- `grok` 0.2.29+ on `$PATH`，已 `grok login` (`~/.grok/auth.json` 存在)
- 网络可达 `grok-build` 的 LLM endpoint

```bash
grok --version       # 应当 grok 0.2.x (alpha 也行)
grok login           # 一次性 OAuth
```

## 一句话跑

```bash
# 默认 10 锚定账号 + 最近 24h + 输出 ./news.json
./fetch_news_via_grok.js

# 指定账号 / 时间窗 / 输出位置
./fetch_news_via_grok.js \
  --accounts @OpenAI,@AnthropicAI,@sama \
  --since 24h \
  --max-per 5 \
  --out /var/lib/ai-insight/fallback.json

# 绝对日期窗 + stdout
./fetch_news_via_grok.js --since 2026-06-06 --out -
```

## CLI 参数

| Flag | 默认 | 说明 |
|------|------|------|
| `--accounts <list>` | 10 锚定账号 (见下) | 逗号分隔的 `@handle` 列表 |
| `--since <window>` | `24h` | `Nh` 相对小时 (例 `24h`, `72h`) 或 `YYYY-MM-DD` 绝对日期 |
| `--start-id <n>` | `1` | 输出 `nextId` 字段起点 |
| `--out <path>` | `./news.json` | 输出文件路径，`-` = stdout |
| `--max-per <n>` | `5` | 每账号最多抓几条 |
| `--timeout <secs>` | `180` | 每次 grok 子进程超时 |
| `-v, --verbose` | off | 每账号进度打 stderr |
| `-h, --help` | — | 用法 |

默认 10 锚定账号: `@OpenAI`, `@AnthropicAI`, `@GoogleDeepMind`, `@xai`, `@sama`, `@karpathy`, `@Alibaba_Qwen`, `@deepseek_ai`, `@Kimi_Moonshot`, `@nvidia`。

## 输出 schema (跟 `auto_update_news.js --fetch-only` 对齐)

```json
{
  "nextId": 7,
  "tweets": [
    {
      "account": "@sama",
      "name": "Sam Altman",
      "user": "sama",
      "tweetId": "2062661191969972645",
      "text": "天啊，互联网的早期真的很特别。",
      "date": "2026-06-04",
      "likes": 0,
      "views": 0,
      "url": "https://x.com/sama/status/2062661191969972645",
      "source": "@sama",
      "category": "行业",
      "imageUrl": ""
    }
  ]
}
```

字段规则 (v2 已收紧):
- `user` = handle 不带 `@`
- `account` / `source` = `@<user>` (两个字段同值，保留是兼容 A站老 schema)
- `url` = 必须是真实 `https://x.com/<user>/status/<digits>` 链接，**否则那条 tweet 被脚本静默丢弃**
- `tweetId` = 从 url 正则抠 (`/status/(\d+)`)
- `date` = `YYYY-MM-DD`，**LLM 返不出真实发布日期 (非 `YYYY-MM-DD` 格式 / 日期缺失) → 那条 tweet 整条 drop**。不再 fallback 今天 — 避免老帖被伪装成新帖混进窗口
- `date` 还做**窗口双保险校验**：`cutoff <= date <= today` 才保留，超窗 silent drop
- `imageUrl` = LLM 返的 `media_url` 字段，**必须通过 curl HEAD 校验**：
  - host 必须是 `pbs.twimg.com` / `video.twimg.com` / `ton.twitter.com` 之一
  - HTTP 200 + content-type `image/*` 或 `video/*`
  - 校验失败 → `imageUrl` 置 `""`（tweet 本身保留，只是没图）
  - **防 LLM 幻觉假图链** — A 站全替代 pilot 的关键防线
- `likes` / `views` = `0` (grok native 拿不到 engagement metadata，X 平台限制，诚实不编造)
- `category` = `"行业"` 固定值

## 失败语义 (A站硬要求)

| 情况 | 输出 | exit |
|------|------|------|
| 至少 1 条 tweet 聚合成功 | 正常 JSON | `0` |
| 所有账号失败 / 总数为 0 | `{nextId, tweets: []}` 仍写文件 | `1` |
| CLI 参数错误 | stderr 报错 | `2` |
| `grok` 不在 PATH | stderr 报错 | `3` |

**绝对不塞假数据**。下游翻译看到空 tweets 应当跳过写库，按 ai-insight 现有约定。

## 实测 (2026-06-07, 通信demo马, v2)

> 命令: `./fetch_news_via_grok.js --accounts @sama,@OpenAI,@karpathy --since 72h --max-per 3 -v`

```
[fetch-grok] accounts=3 since=72h max-per=3 window=[2026-06-03, 2026-06-06]
[fetch-grok] → @sama
[fetch-grok]   ✓ 3 tweet(s) kept
[fetch-grok] → @OpenAI
[fetch-grok]   ✓ 3 tweet(s) kept
[fetch-grok] → @karpathy
[fetch-grok]   ✓ 0 tweet(s) kept
[fetch-grok] wrote 6 tweet(s) to news.json
[fetch-grok] summary: freshest=2026-06-05 (1d ago) | oldest=2026-06-04 | window=[2026-06-03, 2026-06-06] | media-verified=1/6
[fetch-grok] date distribution:
  2026-06-04: 5
  2026-06-05: 1
[fetch-grok] media verify: 1/1 passed (HTTP 200 + image/video content-type)
  [@OpenAI 2062630454537424930] ✓ video/mp4
    https://video.twimg.com/amplify_video/2062605181427339264/vid/avc1/480x270/0mV_E3qR35fCtFaE.mp4

real    3m30s
exit    0
```

- 6/6 URL 实测真链接（例如 `https://x.com/sama/status/2062661191969972645`, `https://x.com/OpenAI/status/2062927046448431587`）
- 6/6 date 都在窗口 `[2026-06-03, 2026-06-06]` 内（freshest=2026-06-05，1d ago）
- schema 12 字段一字不差
- LLM 返了 1 条 `video.twimg.com` 真链接，curl HEAD 验证 content-type `video/mp4` → 入库；其余 5 条 LLM 没返 `media_url`（grok 诚实地不编，行为符合预期）
- 串行（避免 `auth.json` / rate-limit 冲突）：3 账号 ~3.5min，10 账号大约 12-15min

> 命令: `./fetch_news_via_grok.js --accounts @ThisAccountDefinitelyDoesNotExistFooBar2026 --since 1h --max-per 2`

```
[fetch-grok] zero tweets aggregated — exit 1 (downstream should skip write)
exit    1
news.json: {"nextId": 1, "tweets": []}
```

## Cron 接入示例

```cron
# /etc/cron.d/ai-insight-grok-fallback
# 每 6h 抓一次，输出到 fallback 目录
0 */6 * * * ai-insight cd /opt/ai-insight && /opt/ai-insight/scripts/fetch_news_via_grok.js \
    --since 6h --out /var/lib/ai-insight/grok-fallback.json \
    >/var/log/ai-insight/grok-fetch.log 2>&1 ; \
    test -s /var/lib/ai-insight/grok-fallback.json && \
    /opt/ai-insight/scripts/translate_and_upsert.js \
        --in /var/lib/ai-insight/grok-fallback.json
```

下游应当先用 `jq '.tweets | length'` 或检查 exit code 决定是否走翻译入库。

## 已知边界 / gotcha

| 现象 | 原因 | 应对 |
|------|------|------|
| stderr 里有 `failed to watch root recursively` / `Error reading from stream: serde error` | grok-build CLI 给 `/tmp` 文件监视和流解析的告警噪音，跟实际任务无关 | 脚本只 parse stdout，stderr 全丢，正确行为 |
| 某账号 `0 tweet(s)` 但实际有发 | LLM `web_search` 索引可能滞后；或 X 反爬丢 `web_fetch`；或 LLM 拿不到真实日期被双保险丢 | 增大 `--since` 时间窗；或重跑 |
| `WARN: freshest tweet is N days old — grok web index may be lagging` | grok 索引滞后于实时 X，A 站要 last-24h 时这条提示让你早发现 | 增大 `--since`；或调度更高频；或这个时段 grok 兜底确实拿不到当天新帖，跳过翻译入库 |
| 某账号 grok 异常退出 (timeout / non-zero exit) | LLM 卡顿 / endpoint 5xx | 脚本静默跳过该账号，继续下一个，最后 stderr 列出失败列表 |
| `likes` / `views` 永远 `0` | X 不向匿名 / 非 logged-in 客户端开放 engagement metadata，grok web_search 也拿不到，正确诚实地不编造 | A 站下游若需要排序请用其他信号 (如发布时间) |
| `imageUrl` 经常为 `""` | LLM 诚实地不返 `media_url`（没图 / 拿不准 host），或 `media_url` curl 校验失败被 drop | 这是**好行为**（防幻觉假图链）；如果某账号长期 0 imageUrl，可调 prompt 增强但 LLM 行为非确定，A 站可降权或回退 twitterapi.io |
| 某条 LLM 返了 `media_url` 但 curl 校验失败 | 假链（LLM 幻觉）/ X CDN 5xx / content-type 不是 image/video | 静默丢图保 tweet（imageUrl 置 ""）；verbose 模式打 `✗ http XXX` 或 `✗ non-media content-type` |
| 整条 tweet 因 date 缺失被 drop | LLM 没返 `date` 字段或非 `YYYY-MM-DD` 格式 — 我们拒绝把老帖伪装成新的 | 提升 prompt 严格度；或承认那条无法验证日期、跳过 |
| 整条 tweet 因超窗被 drop | LLM 不守 cutoff 提示，给了老帖；脚本本地双保险拦截 | drops 计数 + verbose 日志会标出 `outOfWindow=N`；调短 `--since` 让 LLM 更准 |
| 跑得慢 (10 账号 ~15min) | grok 单轮 LLM 调用 30-90s × 串行 10 次 | cron 调度别小于 30min；并发可加但要先解决 `auth.json` 锁 (本脚本未做) |

## 与 A站 现有 `auto_update_news.js` 的关系

```
        ┌─ 主源: twitterapi.io (--fetch-only)
        │
auto_update_news.js  ──→  下游翻译 / 写库
        │
        └─ 兜底: fetch_news_via_grok.js (本脚本)
                 输出文件路径相同的 schema, A站把它当 --fetch-only 的结果替代
```

集成方式由 A 站负责人决定:
1. 在 ai-insight 的调度脚本里检测 twitterapi.io 返 402 → fallback 跑本脚本
2. 或独立 cron 每 6-12h 跑本脚本，下游用 `nextId` 做去重

## 红线 (开发自约束)

- ❌ **不碰 A 站生产服务器 `47.77.216.1`** — 那是 A 站自己装 grok + 部署；本仓库只交付脚本 + 用法
- ❌ **不内置任何 A 站凭据 / endpoint / 路径**
- ✅ 本地 / Docker 自测，用本仓库 anet 团队的 grok login

## 关联

- 兜底起因: A 站 ai-insight twitterapi.io 402 quota exceeded
- grok native X 搜索能力探测: [`demos/grok-x-search/README.md`](../grok-x-search/README.md)
- E2E 实证: [`docs/tests/p-grok-native-xsearch-e2e/report.md`](../../docs/tests/p-grok-native-xsearch-e2e/report.md)
- 通信demo马 dispatch chain: commhub task `58afee64-899b-468b-90e6-3b8fb379258d`

## 维护

- 主笔: 通信demo马 (claude-code-cli runtime)
- Review: 通信龙
- 下游对接: A 站负责人 (Vincent 指定)
