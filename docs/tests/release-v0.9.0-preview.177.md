# 0.9.0-preview.177

> 重新上线「首次 retention sweep 等事件循环安静」（`#3119` → 撤销 → `#3122`）。撤销的理由已被证伪。

## 1. 为什么撤销过，又为什么回来

```
20:32  判定 .175「启动即崩、pm2 重启 164 次」→ 回滚 + .176 撤销
21:58  核对日志后更正：
        · 20:32–20:38 有 1,460 条正常请求行（Hub 全程在服务）
        · 20:38:18 才出现唯一一次 .175 banner
        · 用**生产库副本**单独起 .175：启动正常，12 秒后仍 ALIVE
        · “164 次重启”是 pm2 的累计值，不是崩溃循环
        · 真正的错在部署脚本：读了上一次留下的 /tmp/h162.json，把旧版本号当成新部署结果
```

⇒ 改动本身从未被证伪；当时的“死亡报告”是工具链的假信号。

## 2. 本版内容（与 #3119 相同）

```
首次 sweep：先等 180 秒（最低），再等循环安静：
  mcp_inflight < 20            且
  最近一次 stall 至少 60 秒前
每 15 秒看一次，最多等 15 分钟；等不到就照常跑（宁可慢，不可不删）
整点的每小时 sweep 不受影响
```

## 3. 部署方式变了（这条比代码更重要）

部署脚本现在有四道门，任一不过就不动生产：

```
① 安装后先用**生产库副本** + 临时端口起一次
② 起来后 6 秒再看一次（.175 若真崩，是「起了然后死」）
③ /health.version 必须等于目标版本
④ 版本不符/起不来/起来后死 → exit 1，且打印诊断
```

## 4. 测试

```
retention-first-sweep-quiet.test.ts  5 条（纯函数）
retention.test.ts                    25 条
```

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.177
commhub-server --version   # 0.9.0-preview.177
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.177
commhub-server --version   # 0.9.0-preview.177
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.177` 后 `npm install`，
指到新目录再重启；`runtime-v176-preview176` 保留即可回滚，无数据迁移。

## 验收

```bash
curl -sS --max-time 8 http://127.0.0.1:9200/health \
 | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["version"], d["event_loop"].get("stall_count"))'
# 期望：0.9.0-preview.177（且部署脚本已断言过这一条）
grep "commhub retention" ~/.commhub/pm2-hub-out.log | tail -1
```

回滚：`HUB_RUNTIME_DIR` 指回 `runtime-v176-preview176` 并重启。
