# #894 attach pre-exec window — TEST ONLY

The actual attach-record renderer publishes PID/start ticks before `exec`.
An exited launcher is therefore not sufficient to prove TUI argv readiness.
This deterministic real-process test holds that boundary, observes the original
guard reject `TUI session mismatch`, then lets the SAME PID exec and verifies the
new bounded wait accepts only the fully matching identity. The TUI/serve here are
process fixtures, not a real OpenCode runtime or native client acceptance.
The final negative bypasses the wait to model the original one-shot check. It
must first witness the pre-exec mismatch then exit1 at the exact post-exec
readiness assertion; generic fixture errors do not count as successful negatives.

```sh
sg docker -c 'docker build -t anet-launch-window:fixed -f tests/test894-launch-window/Dockerfile .'
sg docker -c 'docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges anet-launch-window:fixed'
```

Unit guards additionally pin no deadline extension, timer overshoot, foreign
sessions, reused PID, nonzero exit and correct daemon call-site wiring. The helper
does not change token authentication, runtime selection, lifecycle state or
successful-launch acknowledgment requirements. It uses the original 35-second
creation deadline, not a new timeout starting after launcher exit. Nonzero or
unknown launcher exits do not enter this retry path.

Recovery: startup entry is this Dockerfile and run.sh; inputs are repository
source and the digest-pinned Bun image. No ports, reverse proxies, tunnels,
credentials, databases or host profile mounts. Pin the tested Git commit to
rebuild; /tmp/art contains the text result. Containers are disposable (--rm),
so rollback is simply returning to the earlier source/image; production data
and keyrings remain separate and are not reconstructed by this suite.

Product integration remains required: package from an authorized exact main SHA
only after merge, then rerun the native fixed-package creation/cancellation gate.
Do not install this branch globally, publish a preview from it, or mark #895 done
on the basis of this atomic fixture.
