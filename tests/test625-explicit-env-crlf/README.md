# test625 — explicit `--env` CRLF rejection

Runs a built CLI against a real isolated Hub and verifies that `anet node
create --env` rejects CR/LF before writing a node profile or dotenv file.

The mutation removes the validation, rebuilds the CLI, and witnesses a second
dotenv assignment being injected. All state stays inside the Docker container.
