# test537 — Grok TUI saved-report provenance

This gate compares the source commit declared by saved Grok TUI reports with
the exact candidate commit being reviewed. It must run before test219,
test224, or test225; a mismatch is a hard stop, not an instruction to relabel
old reports.

From the reporting worktree, build with the candidate clean checkout supplied
as a read-only named context:

```bash
sg docker -c 'docker build \
  --build-context candidate=/home/vansin/commniu-grok-candidate-537 \
  -t anet-grok-tui-537:dev \
  -f tests/test537-grok-tui-provenance/Dockerfile .'
```

Then run:

```bash
sg docker -c 'docker run --rm \
  -e EXPECTED_SOURCE_COMMIT=4854928b35c14abaaae788aba7ec043cea10643b \
  anet-grok-tui-537:dev'
```

For issue #537 the expected result is exit code 1, because the three committed
reports identify `501764f83c0428ebc153d132ae049de38d7041f6`.
