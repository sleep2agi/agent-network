README visual alignment with anet.sh — 2026-10-09

Base: main 90589fe7 (isolated docs/readme-site-visuals worktree).
Scope: Chinese/English README screenshots and captions; no application changes,
no website deployment, no new/re-encoded binary images or deleted old assets.

Visual inspection: old README chat/task shots show a sparse v0.2.149 demo.
Website chat/features show v0.2.209 showcase content. Reuse the tracked website
assets by relative path; label people/tasks/metrics as sample data. English
README explicitly notes the screenshots show Chinese UI. Chat retains the
existing picture/media dark-theme mechanism; feature shots use the website's
light images. Task detail/schedule are expandable to keep setup accessible.

Docker validation:
sg docker -c 'docker build -f tests/test-readme-site-visuals/Dockerfile -t anet-readme-site-visuals:test .'
sg docker -c 'docker run --network none anet-readme-site-visuals:test'
Container anet-readme-site-visuals-test: exit 0.
Image ID sha256:4d73b217ee949240fea3a0663d341a868d5dd4de63f0704dc4957efbc5900134
Base resolved to python:3.12-slim at
sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f.
Dependencies Pillow 11.3.0 / Markdown 3.8.2 installed only inside Docker.

PASS decode 5 source images: two chat PNGs 2240x1440, three feature WebPs 2560x1600.
PASS all 5 sources are used by the repository's website homepage/component.
PASS both README files: screenshot order, shared paths, nonempty alt text,
880px widths, dark media source, expandable section and existing local images.
PASS explicit sample-data notices; old chat/task source references removed.
PASS git diff --check.

Limits: offline Markdown/HTML source gate, not GitHub browser UAT or pixel-level
responsive verification. Source images were visually inspected. No functional
runtime claim, release claim, or benchmark claim follows from these screenshots.
Rollback: revert the README change; existing site assets are unchanged.
