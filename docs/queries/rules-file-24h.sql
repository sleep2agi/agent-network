-- Bind ?1 to the network id. Terminal request outcomes by completion time,
-- not "latest session state" or proof of rules injection. Empty input => [].
WITH observed AS (
  SELECT status,
    CASE WHEN status = 'timeout' THEN
      CASE WHEN timeout_reason IN ('not_pulled', 'pulled_no_ack', 'not_capable')
        THEN timeout_reason ELSE 'unclassified' END
      ELSE NULL END AS reason
  FROM node_rules_requests
  WHERE network_id = ?1 AND op IN ('read', 'write')
    AND status IN ('done', 'failed', 'timeout')
    AND acked_at >= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 86400000
), totals AS (
  SELECT count(*) AS terminal_count,
    sum(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS succeeded,
    sum(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timed_out
  FROM observed
)
SELECT o.status, o.reason, count(*) AS count,
  t.terminal_count, round(100.0 * t.succeeded / t.terminal_count, 2) AS success_pct,
  round(100.0 * t.timed_out / t.terminal_count, 2) AS timeout_pct
FROM observed o CROSS JOIN totals t
GROUP BY o.status, o.reason, t.terminal_count, t.succeeded, t.timed_out
ORDER BY count DESC, o.status, o.reason;
