# test365 — non-image attachments for Read-capable runtimes

This suite starts the real Hub, uploads deterministic PDF bytes, sends a real
task carrying the returned `file_id`, and observes the real Claude channel
notification. The receiver must download the PDF through authenticated Hub
HTTP, cache it as an alias-local mode-0600 file, and surface its path as
untrusted data.

Structured multimodal runtimes remain image-only. The suite does not claim
that PDF/docx files are valid image blocks or that every runtime can read
arbitrary files.
