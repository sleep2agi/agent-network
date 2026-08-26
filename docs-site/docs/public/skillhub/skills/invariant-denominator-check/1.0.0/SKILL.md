# Invariant denominator check

Use this workflow when a result is a count, ratio, percentage, coverage number,
or pass/fail total.

## Name the measured object

Before trusting the number, write the object being counted:

```text
numerator: <what increments the count>
denominator: <the complete set it is divided by or compared against>
scope: <repo, network, account, runtime, date range, or file set>
```

A number can be arithmetically correct and still answer the wrong question.

## Check same-value traps

Look for cases where two different states produce the same output:

1. not checked vs checked and zero;
2. no data vs data unavailable;
3. no matching item vs matching item hidden by permissions;
4. all targets passed vs only a subset ran;
5. same author account vs same human or agent.

If two states share one value, add a separate field, log line, or exit code to
make them distinguishable.

## Verify the denominator

Use an independent listing command for the denominator before interpreting the
result. Examples include a file list, account list, test inventory, task list,
or PR search result. Record the command when the denominator is part of the
claim.

## Report with scope

Phrase the result with its denominator:

```text
41/41 checks passed for <exact suite>
```

Do not shorten it to "all checks passed" unless the exact universe of checks is
obvious from the same sentence.

