# NOT-IN-CI — test812-tmux-target-semantics

**Who runs it:** nobody in CI. This suite is a **one-off reproduction** that backed the
evidence for #812 (tmux target semantics: one `tmux new-session -t` target must not be
silently re-used across nodes when the session name collides). It ran once, on a private
Docker host, against the tree that produced the #812 report; its output is quoted in that
report and is not a standing regression gate.

**Why it is not wired into `scripts/qa.sh`:** the suite pins a specific tmux build and a
private network namespace layout to reproduce the original collision. Nothing in it asserts
behaviour of current `main` beyond what `tests/test751-*` / the copresence identity tests
already cover on every push, and wiring it in would add a multi-minute Docker job whose
only failure mode is environment drift (tmux version, loopback layout), not product
regression.

Revisit-when: A tmux-target/copresence-collision regression reaches `main` again, or the
tmux pin is dropped from the daemon path. At that point either convert this into a
hermetic fixture under an existing suite, or delete it together with the report it came
from.

Verified: 2026-10-18

The reproduction passed on `main` @ `d4b288fb` (the merge of #812); the report cites its
output.
