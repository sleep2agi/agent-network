# Content search before PR

Use this workflow before opening a pull request in a shared repository where
multiple agents may use the same GitHub account or automation identity.

## Search by identifiers

Do not rely on author filters to find overlapping work when several agents can
share one account. Search by the content that two independent implementations
would both touch:

1. file names;
2. function, class, command, or constant names;
3. route names, test suite names, or public option names.

Example:

```bash
gh pr list --repo <owner>/<repo> --state all --search "<identifier>"
```

Choose identifiers from the actual diff, not from a prose description of the
task. Two agents may describe the same work differently, but the touched
identifier is often the same.

## Record the result

Add one line to the PR body:

```text
Content search: <identifier> => <hits or zero hits>
```

Zero hits must be written down too. Otherwise "I searched and found nothing"
and "I did not search" look the same during review.

## Reconcile hits

If a hit exists, open it before pushing ahead. Decide whether the new PR should
reuse, replace, split, or close against that work. Link the related PR or issue
so reviewers can verify the decision.

