# test765 — batch/runtime conflict behavior gate

Pins the two product behaviors merged by PR #769:

1. `create --batch --runtime <value>` fails before create side effects and
   points to the usable single-node `--runtime` command;
2. plain `create --batch` still reaches the existing selector-unavailable
   fallback, whose guidance distinguishes preset-supported runtimes from the
   non-batch runtime path.

Three witnessed-red mutations remove the conflict guard, over-widen it to
reject every batch invocation, and regress the fallback to an unusable
`--preset`-only instruction. The suite runs the real production CLI entry and
is registered in the active `scripts/qa.sh` L1 list.
