#!/usr/bin/env python3
"""Synthetic codex rollout for #734. MODE: paginated | legacy | mixed | big
paginated = codex >= 0.145 shape (session_meta.history_mode=paginated, every line has an ordinal)
legacy    = pre-0.145 shape (no history_mode, no ordinals)
mixed     = paginated head + lines appended without an ordinal (what codex 0.133 leaves behind)
big       = paginated head + ~300 MB of padding lines (bounded-read test)
Prints the path."""
import json, os, sys
home, tid, mode = sys.argv[1], sys.argv[2], sys.argv[3]
d = os.path.join(home, "sessions", "2026", "10", "07"); os.makedirs(d, exist_ok=True)
p = os.path.join(d, f"rollout-2026-10-07T21-30-58-{tid}.jsonl")
ts = "2026-10-07T21:30:58.386Z"; turn = "01a11846-d7c9-7e42-b945-b7df37498e53"
meta = {"session_id": tid, "id": tid, "timestamp": ts, "cwd": "/tmp/w", "originator": "codex_exec", "cli_version": "0.159.2",
        "source": "exec", "thread_source": "user", "model_provider": "openai", "base_instructions": {"text": "x"}}
paginated = mode != "legacy"
if paginated: meta["history_mode"] = "paginated"
recs = [("session_meta", meta),
        ("event_msg", {"type": "task_started", "turn_id": turn, "started_at": 1791408658, "model_context_window": 258400, "collaboration_mode_kind": "default"}),
        ("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "say hi"}]}),
        ("event_msg", {"type": "user_message", "message": "say hi", "images": [], "local_images": [], "text_elements": []})]
tail = [("event_msg", {"type": "task_started", "turn_id": "01a11848-4634-7cd3-a47a-7e4267469447", "started_at": 1791408752, "model_context_window": 258400, "collaboration_mode_kind": "default"}),
        ("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "second msg"}]})]
with open(p, "w") as f:
    for i, (t, pl) in enumerate(recs):
        o = {"timestamp": ts}
        if paginated: o["ordinal"] = i
        o.update({"type": t, "payload": pl}); f.write(json.dumps(o, separators=(",", ":")) + "\n")
    if mode == "mixed":
        for t, pl in tail: f.write(json.dumps({"timestamp": ts, "type": t, "payload": pl}, separators=(",", ":")) + "\n")
    if mode == "big":
        pad = ("x" * (1024 * 1024 - 1)) + "\n"
        for _ in range(300): f.write(pad)
print(p)
