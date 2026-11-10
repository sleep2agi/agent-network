#!/bin/bash
# CommHub 生产库定时备份
#
# 由来：2026-07-29 巡检发现，中枢的全部状态就是一个 390MB 的 SQLite 文件，
# **没有任何定时备份**。仅有的两份备份都是出事故时人工手抄的。
# 而且那两份是对**正在被写入的 WAL 库**直接 `cp` 出来的 ——
# 这种拷贝不保证一致性，真要拿它恢复时才会发现问题。
#
# 正确做法是用 SQLite 的 `VACUUM INTO`：
#   - 它是**读操作**，而库是 WAL 模式，读不阻塞写 → 95 个 agent 照常收发，不受影响
#   - 产出的是**一致性快照**，不是逐字节拷贝
#   - 顺带压掉空闲页（实测 390MB → 187MB）
#   - 实测耗时约 1 秒
#
# 设计约束：
#   1. 只读打开生产库，绝不写生产库
#   2. 备份必须先通过 integrity_check 才允许进入保留目录 ——
#      **绝不用一份坏备份去顶掉好备份**（否则备份反而制造了虚假的安全感）
#   3. 先写临时文件再原子改名，避免留下写到一半的半成品
#   4. 保留有限份数，自动轮转，不把盘撑爆

set -uo pipefail

DB="${HUB_DB:-$HOME/.commhub/commhub.db}"
DEST_DIR="${HUB_BACKUP_DIR:-$HOME/.commhub/backups}"
KEEP="${HUB_BACKUP_KEEP:-4}"
LOG="${HUB_BACKUP_LOG:-$HOME/.commhub/backup.log}"
BUN="$(command -v bun 2>/dev/null || ls -1 "$HOME"/.nvm/versions/node/*/bin/bun 2>/dev/null | tail -1)"

log() { echo "[hub-backup $(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

[ -n "$BUN" ] && [ -x "$BUN" ] || { log "🔴 找不到 bun，无法备份"; exit 1; }
[ -f "$DB" ] || { log "🔴 库不存在：$DB"; exit 1; }

mkdir -p "$DEST_DIR"

# 磁盘余量预检：备份本身要写一个和库同量级的文件（实测约 160MB）。
# 磁盘吃紧时最不该做的事，就是为了"保数据"反而把最后一点空间吃掉 ——
# 中枢写不了库比少一次备份严重得多。
# 阈值取 (库大小 × 2 + 2GB 余量)，够写完还留出安全垫。
DB_MB=$(( $(stat -c %s "$DB" 2>/dev/null || echo 0) / 1024 / 1024 ))
NEED_MB=$(( DB_MB * 2 + 2048 ))
AVAIL_MB=$(( $(df --output=avail "$DEST_DIR" 2>/dev/null | tail -1) / 1024 ))
if [ "$AVAIL_MB" -lt "$NEED_MB" ]; then
  log "🔴 磁盘余量不足，跳过本次备份：可用 ${AVAIL_MB}MB < 需要 ${NEED_MB}MB（库 ${DB_MB}MB）"
  log "   宁可少一次备份，也不能把磁盘写满导致中枢写不了库。"
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
TMP="$DEST_DIR/.tmp-$STAMP.db"
FINAL="$DEST_DIR/commhub-$STAMP.db"

# 备份 + 自检。integrity_check 不为 ok 就直接失败，不留下这份备份。
export DB TMP
"$BUN" -e "
const { Database } = require('bun:sqlite');
const src = process.env.DB, tmp = process.env.TMP;
const db = new Database(src, { readonly: true });   // 只读打开生产库
db.exec(\`VACUUM INTO '\${tmp}'\`);
db.close();
const chk = new Database(tmp, { readonly: true });
const r = chk.query('PRAGMA integrity_check').get();
const tables = chk.query(\"SELECT count(*) c FROM sqlite_master WHERE type='table'\").get().c;
chk.close();
const ok = r && r.integrity_check === 'ok';
console.log(JSON.stringify({ ok, integrity: r && r.integrity_check, tables }));
if (!ok) process.exit(2);
if (tables < 1) { console.log('no tables'); process.exit(3); }
" > "$DEST_DIR/.last-check" 2>>"$LOG"
rc=$?
CHECK="$(cat "$DEST_DIR/.last-check" 2>/dev/null | head -1)"

# ⚠️ 不能只信退出码。实测：源库损坏时 `bun -e` 里的 VACUUM INTO 失败了，
#    但 bun 依然返回退出码 0 —— 脚本据此以为成功，去 mv 一个根本不存在的文件，
#    然后**在日志里写下"✅ 备份完成"，而实际上一份备份都没有**。
#    定时任务报告成功却什么都没备份，比没有备份更危险：它制造虚假的安全感。
# 所以判据改成【检查产物本身】：临时文件必须存在、非空，且自检输出必须是 ok。
if [ $rc -ne 0 ] || [ ! -s "$TMP" ] || ! grep -q '"ok":true' <<<"$CHECK"; then
  log "🔴 备份未通过验证，已丢弃这一份，原有备份保持不动"
  log "   退出码=$rc 临时文件存在=$([ -s "$TMP" ] && echo 是 || echo 否) 自检输出=${CHECK:-<空>}"
  rm -f "$TMP"
  exit 1
fi

# 验证通过才原子落位
mv -f "$TMP" "$FINAL"

# 落位后再确认一次：mv 也可能因为磁盘满等原因失败
if [ ! -s "$FINAL" ]; then
  log "🔴 落位后备份文件不存在或为空：$FINAL（磁盘满？）"
  exit 1
fi

SIZE=$(du -h "$FINAL" | cut -f1)
log "✅ 备份完成 $(basename "$FINAL")（$SIZE），自检：$CHECK"

# 轮转：只保留最近 KEEP 份
# 🔴 必须同时匹配 .db 与 .db.gz —— 只匹配 .db 的话，压缩过的历史快照**永远不会被轮转**，
#    盘会慢慢涨回去，而日志里看不出任何异常（"轮转"照常打印）。
mapfile -t olds < <(ls -1t "$DEST_DIR"/commhub-*.db "$DEST_DIR"/commhub-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)))
for f in "${olds[@]:-}"; do
  [ -n "$f" ] && rm -f "$f" && log "   轮转删除 $(basename "$f")"
done

# 压缩：除最新一份外，历史快照 gzip -6。
# 为什么保留最新一份不压：出事时第一时间要的是**能直接打开**的那一份；
# 多一步 gunzip 在紧张时刻就是多一次出错机会。
# 792MB 的库压完约 150–250MB —— 同样的保留份数，盘占用降到 1/4。
# 恢复：gunzip -c <file>.db.gz > /tmp/restore.db && sqlite3 /tmp/restore.db 'PRAGMA integrity_check;'
if [ "${HUB_BACKUP_COMPRESS_OLDER:-1}" = "1" ] && command -v gzip >/dev/null 2>&1; then
  mapfile -t olddb < <(ls -1t "$DEST_DIR"/commhub-*.db 2>/dev/null | tail -n +2)
  for f in "${olddb[@]:-}"; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    if gzip -6 -f "$f"; then log "   压缩 $(basename "$f").gz"; else log "   ⚠ 压缩失败，保留原文件 $(basename "$f")"; fi
  done
fi

exit 0
