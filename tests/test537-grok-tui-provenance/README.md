# test537 — Grok TUI saved-report provenance

This gate compares the source commit declared by saved Grok TUI reports with
the exact candidate commit being reviewed. It also requires the
`git archive`-expanded source marker to equal that commit, so changing only
`EXPECTED_SOURCE_COMMIT` cannot make a different checkout pass. It must run
before test219, test224, or test225; a mismatch is a hard stop, not an
instruction to relabel old reports.

From the reporting worktree, run the wrapper against a clean candidate
worktree:

```bash
tests/test537-grok-tui-provenance/run-docker.sh \
  /home/vansin/commniu-grok-candidate-537
```

The wrapper refuses a dirty worktree, derives the full expected SHA from its
HEAD, creates a minimal temporary `git archive`, builds the fixed
`anet-test537-grok-tui-provenance:dev` tag, and runs the gate in a read-only,
network-disabled container. The archive expands test225's `$Format:%H$`
marker, independently binding the copied reports to the candidate commit.
Immediately after the build, the wrapper obtains the immutable image ID from
the built artifact with `docker image inspect --format '{{.Id}}'` and prints
both `image_tag` and `image_id`; saved evidence must copy that emitted value,
not a remembered tag-to-digest mapping.
Temporary extraction is restricted to a `mktemp` directory under `/tmp` and
removed through the repository safe-delete guard.

For issue #537 the expected result is exit code 1, because the three committed
reports identify `501764f83c0428ebc153d132ae049de38d7041f6`.
