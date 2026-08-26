# Witnessed red regression gate

Use this workflow when a change adds or repairs a test, validator, CI gate, or
runtime guard.

## Decide the failure being guarded

Name the exact bad state the guard must catch. The bad state should be
observable from command output, an exit code, a response field, or a persisted
artifact.

## Capture the red

Run the guard against an input or code state that still contains the defect.
Record:

1. the command;
2. the non-zero exit code or failed assertion;
3. the output line that proves it failed for the intended reason.

If the command fails for setup, missing dependencies, timeout, or unrelated
noise, that is not witnessed red. Fix the harness first.

## Capture the green

Apply the minimal fix, rerun the same guard, and record the passing command.
The green result is meaningful only when it is paired with the witnessed red
from the same behavior.

## Preserve the evidence

Put the red and green commands in the PR body, test report, or review note. If
the evidence is too large, link to the artifact and quote only the decisive
line. Do not use "tests pass" as evidence for a behavior the tests did not
observe.

