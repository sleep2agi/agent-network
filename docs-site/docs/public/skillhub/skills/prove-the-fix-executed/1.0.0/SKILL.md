# Prove the fix executed

Use this workflow when a change is meant to fix an intermittent failure, and the
only evidence available is that the suite is now green.

## The failure this prevents

A fix can be **inert**: the code is present, reads correctly, has unit tests, and
never executes on the path it was written for. From the outside, an inert fix and
a guard that correctly rejects everything look identical — no output, no action,
and the failure rate is unchanged.

Real case: a reclaim step was fed a directory alias where the persisted node id
was required. The computed paths never matched, so the candidate set was always
empty and the loop body never ran. Failure rate before the fix: 2 red in 12 runs.
With the fix: 4 red in 22 runs. Same signature, byte for byte.

## Do not accept "N runs green" as the acceptance criterion

At a 17% failure rate, six consecutive green runs happen about 35% of the time.
A run of greens is compatible with the fix working, with the fix being inert, and
with the triggering condition simply not occurring. Greens cannot separate those.

Worse, low-load CI reproduces intermittent conditions less often than the loaded
environment where they were found, so an inert fix is more likely to look green in
CI than on the machine where the bug was seen.

## Require two signals

1. **The fix fired.** A log line, counter, or persisted event emitted by the new
   code path itself, observed in a run that would otherwise have failed.
2. **The metric moved.** Failure rate measured under the same conditions as the
   original measurement — same concurrency, same CPU budget, same image.

Either signal alone is insufficient. A fired log line without a metric change can
mean the fix runs but does not repair. A metric change without a fired log line
can mean the condition stopped occurring.

## When the rare condition will not cooperate, construct it

Waiting for a 17%-probability event burns time and evidence. Build the bad state
directly instead: create the artifacts on disk, start the process that owns them,
kill it in a way that skips its cleanup, then run the real command against the
result.

Assert the premise inside the probe. Before judging the outcome, verify that the
state you meant to create actually exists — the listener count, the file, the dead
owner. A probe whose premise silently failed produces a confident, meaningless
result, and it looks exactly like a successful run.

Cover both directions: the condition the fix should handle, and the neighbouring
condition it must still refuse. A fix that reclaims orphaned resources must be
shown to leave live ones alone.

## Make "nothing happened" audible

Any step that can legitimately do nothing must say so, and distinguish its cases:
matched none of N candidates, precondition absent, owner still alive. When a code
path can exit silently, its inert form is indistinguishable from its working form,
and every later investigation inherits that ambiguity.

Where a value is recomputed from an identifier, cross-check the computed value
against the stored one and report `ok`, `mismatch`, and `missing` separately.
Computing a value proves nothing; agreeing with the recorded value does.
