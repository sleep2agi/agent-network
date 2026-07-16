#!/usr/bin/python3
"""Assert the effective OpenCode child environment without printing secrets."""

from __future__ import annotations

import json
import sys
from pathlib import Path


dump_path = Path(sys.argv[1])
node_dir = Path(sys.argv[2]).resolve()
requested_project = Path(sys.argv[3]).resolve()
hostile_root = Path(sys.argv[4]).resolve()
safe_base = Path(sys.argv[5]).resolve()
expected_binary = Path(sys.argv[6]).resolve()
dump = json.loads(dump_path.read_text(encoding="utf-8"))
keys = set(dump["keys"])
selected = dump["selected"]

if Path(dump.get("executable", "")).resolve() != expected_binary:
    raise AssertionError("fake ACP did not run from the canonical package entrypoint")

for forbidden in (
    "COMMHUB_TOKEN",
    "COMMHUB_AUTH_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NODE_OPTIONS",
    "NPM_TOKEN",
    "SLACK_BOT_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANET_OPENCODE_BIN",
    "ANET_OPENCODE_VERSION",
    "ANET_OPENCODE_SAFE_BASE",
):
    if forbidden in keys:
        raise AssertionError(f"forbidden child env key survived: {forbidden}")

for inherited_override in ("OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"):
    if inherited_override in keys:
        raise AssertionError(f"inherited OpenCode override survived: {inherited_override}")

home_raw = selected.get("HOME", "")
if not home_raw:
    raise AssertionError("controlled child env key missing: HOME")
home = Path(home_raw).resolve()
launch_root = home.parent
if home != launch_root / "home" or not launch_root.name.startswith(".anet-opencode-launch-"):
    raise AssertionError("OpenCode HOME is not below a fresh external launch root")
if launch_root.parent != safe_base:
    raise AssertionError("fresh launch root is not a direct child of ANET_OPENCODE_SAFE_BASE")

def overlaps(left: Path, right: Path) -> bool:
    return left.is_relative_to(right) or right.is_relative_to(left)


for label, boundary in (
    ("node directory", node_dir),
    ("requested project", requested_project),
    ("hostile inherited root", hostile_root),
):
    if overlaps(launch_root, boundary):
        raise AssertionError(f"external launch root overlaps {label}")

expected_cwd = launch_root / "workspace"
expected_cwd_text = str(expected_cwd)
if dump.get("cwd") != expected_cwd_text or selected.get("PWD") != expected_cwd_text:
    raise AssertionError("process cwd and PWD are not byte-for-byte launchRoot/workspace")

expected_fresh = {
    "HOME": launch_root / "home",
    "USERPROFILE": launch_root / "home",
    "APPDATA": launch_root / "config",
    "LOCALAPPDATA": launch_root / "data",
    "PWD": expected_cwd,
    "TMPDIR": launch_root / "tmp",
    "TMP": launch_root / "tmp",
    "TEMP": launch_root / "tmp",
    "XDG_CONFIG_HOME": launch_root / "config",
    "XDG_DATA_HOME": launch_root / "data",
    "XDG_CACHE_HOME": launch_root / "cache",
    "XDG_STATE_HOME": launch_root / "state",
    "XDG_RUNTIME_DIR": launch_root / "runtime",
    "OPENCODE_TEST_MANAGED_CONFIG_DIR": launch_root / "managed-config",
}
for name, expected in expected_fresh.items():
    if selected.get(name) != str(expected):
        raise AssertionError(f"{name} is not the exact expected launch-root sibling")

for label, private_dir in {
    "safe base": safe_base,
    "launch root": launch_root,
    "workspace": expected_cwd,
    **{name: path for name, path in expected_fresh.items() if name != "PWD"},
}.items():
    if not private_dir.is_dir() or (private_dir.stat().st_mode & 0o777) != 0o700:
        raise AssertionError(f"{label} is not a real mode-0700 directory")

session_requests = dump.get("session_requests")
if not isinstance(session_requests, list) or not session_requests:
    raise AssertionError("fake ACP child recorded no session/new or session/load request")
if not any(entry.get("method") == "session/new" for entry in session_requests):
    raise AssertionError("fresh fake ACP run did not receive session/new")
for entry in session_requests:
    if entry.get("cwd") != expected_cwd_text:
        raise AssertionError(f"{entry.get('method')} cwd diverged from process cwd/PWD")

config_root = launch_root / "config"

raw_policy = selected.get("OPENCODE_CONFIG_CONTENT")
if not raw_policy:
    raise AssertionError("authoritative OPENCODE_CONFIG_CONTENT policy missing")
policy = json.loads(raw_policy)
if policy.get("plugin") != []:
    raise AssertionError("safe inline OpenCode policy did not force plugin=[]")
tools = policy.get("tools", {})
required_disabled = (
    "bash", "read", "glob", "grep", "edit", "write", "list", "task", "skill",
    "webfetch", "websearch",
    "question",
)
enabled = [name for name in required_disabled if tools.get(name) is not False]
if enabled:
    raise AssertionError(f"default OpenCode policy did not disable: {enabled}")
permission = policy.get("permission", {})
not_denied = [name for name in required_disabled if permission.get(name) != "deny"]
if (not_denied or permission.get("*") != "deny"
        or permission.get("external_directory") != "deny"
        or permission.get("doom_loop") != "deny"):
    raise AssertionError(f"default OpenCode permission policy is not deny: {not_denied}")
if "hostile/provider-model" in raw_policy:
    raise AssertionError("hostile OPENCODE_CONFIG_CONTENT reached the child")
if json.loads(selected.get("OPENCODE_PERMISSION", "null")) != permission:
    raise AssertionError("late OPENCODE_PERMISSION override diverged from safe inline policy")
runtime_config_path = config_root / "opencode" / "opencode.json"
runtime_config = json.loads(runtime_config_path.read_text(encoding="utf-8"))
if runtime_config.get("plugin") != [] or runtime_config.get("mcp") != {}:
    raise AssertionError("fresh safe global config retained plugin or MCP entries")
expected_controls = {
    "OPENCODE_DISABLE_AUTOUPDATE": "true",
    "OPENCODE_DISABLE_PROJECT_CONFIG": "true",
    "OPENCODE_PURE": "1",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1",
    "OPENCODE_DISABLE_CLAUDE_CODE": "1",
    "OPENCODE_DISABLE_LSP_DOWNLOAD": "1",
}
for name, expected in expected_controls.items():
    if selected.get(name) != expected:
        raise AssertionError(f"OpenCode isolation control has wrong value: {name}")

print(
    "SECURITY_ENV_PASS forbidden keys absent; external 0700 cwd/HOME/XDG; "
    "process PWD and ACP session cwd identical; "
    "project/plugin/skill/Claude/LSP discovery disabled"
)
