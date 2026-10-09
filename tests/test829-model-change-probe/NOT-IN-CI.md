# Exploratory V2 model-change probe

Verified: 2026-10-09
Revisit-when: Converting the model-change exploration into a maintained suite; replace the local dependency image with a clean reproducible build, add negative controls and register workflow/path coverage before claiming CI acceptance.

Owned by the Hub #539 / #829 delivery owner. This test-only probe inherits the
local full-build candidate image anet-test539:release-f4bf and its separately
pinned Web export/native harness. It does not rebuild product code. The rendered
Web client now exercises real-Hub model and stop/start buttons and checks the
provider's requested model, but this is not native-client package acceptance.
Record base/source/client/probe digests,
initial harness failures, and container exit status in docs/tests/.

No publication, production deployment, global installation, or existing CI
gate exemption follows from this exploratory suite. It is not intended to be
added to a CI matrix while its local dependency image is unavailable there.
