# Explicit scheduled outcome guidance

CommHub #1284 is a bounded producer guidance slice under #1276 / #756.
The Hub already accepts authenticated successful `send_reply` annotations as
described in [the outcome contract](scheduled-work-outcome.md). Dispatch now
explains that protocol to the recipient of an explicitly opted-in interval
schedule with skip overlap on a qualified transactional backend.

The original Owner task and any server-created Agent provenance remain first.
The appended guidance names the exact dispatched task ID and the two optional
`meta.scheduled_work_outcome` values. `changed` requires successful verified
substantive changes. `no_changes` requires successful completion of the actual
scope check with no substantive changes. Waiting for input/authority, failed,
expired, skipped and unverified work do not justify an empty-success report.
The guidance never classifies prose, counts tool calls or creates an annotation
by itself. Missing tool support leaves the ordinary response unknown; no extra
message/task is sent to retrofit a classification.

The policy comes from the persisted plan after existing dispatch revalidation,
not a stale caller row or user-supplied event metadata. No plan is opted in by
this change. Default-disabled task bodies remain byte-identical, and the stored
Owner task is never rewritten. Inbox and task carry the same dispatched text.
Existing sender, network, current target, exact run and normal terminal reply
checks remain authoritative. Guidance does not grant authority, change lifecycle,
invent success, alter frequency or bypass the revision fence.

Independent Docker fixture `tests/test1284-outcome-guidance/` exercises real
HTTP/MCP dispatch, recipient reading, explicit synthetic classification and
normal replies, including three empty successes followed by a changed result.
It qualifies the software protocol, not any real model's ability to interpret
the prompt or correctly classify actual domain work. Current installed Hub/Node,
Owner policy and natural real producer adoption remain separate parent gates.
Legacy runtimes may ignore the added text and continue with unknown outcomes.

## Rebuild and recovery

The six answers in [the outcome recovery contract](scheduled-work-outcome.md#rebuild-and-recovery)
apply: repository Hub startup entrypoints; existing proxy/port mapping; original
Owner-managed auth and backup key sources; exact main software with lockfile;
ordinary software rollback; encrypted Hub data backup for real history/settings.
This adds no service, port, environment variable, secret, schema column or
production launcher/configuration change. Git restores software and synthetic
fixtures; adopted plans, original identities and actual history require data
backup. Rollback stops adding guidance to future dispatches; existing dispatched
task text remains in data, and original outcome qualification still applies.
No full production recovery or real model adoption is certified.
