#!/usr/bin/env python3
"""Drive both real `anet node create` entry points through a PTY.

The menu index is derived from the menu text that the installed bundle draws,
not hard-coded.  That makes this an actual picker test: a missing
`opencode-cli` row fails before any node can be created.
"""

import os
import re
import sys
from pathlib import Path

import pexpect


ANSI_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
RUNTIMES = [
    "claude-agent-sdk",
    "claude-code-cli",
    "codex-sdk",
    "codex-app-server",
    "grok-build-acp",
    "opencode-cli",
]
PRESETS = ["Anthropic 原生 API", "OpenAI"]


def clean(value: str) -> str:
    return ANSI_RE.sub("", value).replace("\r", "")


def menu_index(menu_text: str, labels: list[str], target: str) -> int:
    plain = clean(menu_text)
    missing = [label for label in labels if plain.find(label) < 0]
    duplicates = [label for label in labels if plain.count(label) != 1]
    found = sorted((plain.find(label), label) for label in labels if plain.find(label) >= 0)
    ordered = [label for _, label in found]
    if missing or duplicates or ordered != labels:
        raise AssertionError(
            "rendered menu is not the exact expected choice set/order; "
            f"expected={labels!r}, rendered={ordered!r}, "
            f"missing={missing!r}, non_singletons={duplicates!r}"
        )
    if target not in ordered:
        raise AssertionError(f"target {target!r} absent from exact rendered menu")
    return ordered.index(target)


def choose(child: pexpect.spawn, prompt: str, labels: list[str], target: str) -> None:
    child.expect(prompt)
    child.expect("navigate")
    index = menu_index(child.before, labels, target)
    for _ in range(index):
        child.send("\x1b[B")
        child.delaybeforesend = 0.04
    child.send("\r")


def finish(child: pexpect.spawn, alias: str) -> None:
    child.expect(rf'Created node "{re.escape(alias)}" \(opencode-cli\)')
    child.expect(pexpect.EOF)
    child.close()
    if child.exitstatus != 0:
        raise AssertionError(
            f"anet node create for {alias} exited {child.exitstatus}, signal={child.signalstatus}"
        )


def spawn_create(args: list[str], env: dict[str, str], trace_path: Path) -> pexpect.spawn:
    trace = trace_path.open("w", encoding="utf-8")
    child = pexpect.spawn(
        "anet",
        args,
        cwd=os.environ["TEST384_WORK_DIR"],
        env=env,
        encoding="utf-8",
        codec_errors="replace",
        timeout=90,
        dimensions=(40, 180),
    )
    child.logfile = trace
    # Keep the trace descriptor alive for the child's lifetime.
    child._test384_trace = trace  # type: ignore[attr-defined]
    return child


def main() -> None:
    base = os.environ.copy()
    base.pop("ANTHROPIC_API_KEY", None)
    base.pop("OPENAI_API_KEY", None)
    trace_dir = Path(os.environ.get("TEST384_TRACE_DIR", "/tmp/test384"))
    trace_dir.mkdir(parents=True, exist_ok=True)

    # No-name entry: readline node-name prompt, then real runtime + preset
    # select widgets. Only the synthetic Anthropic key is visible to this
    # subprocess.
    anthropic_env = base.copy()
    anthropic_env["ANTHROPIC_API_KEY"] = os.environ["TEST384_ANTHROPIC_DUMMY"]
    unnamed = spawn_create(
        ["node", "create"], anthropic_env, trace_dir / "unnamed-anthropic.pty.log"
    )
    unnamed.expect("Node name")
    unnamed.sendline("wizard-anthropic")
    choose(unnamed, "选择 runtime:", RUNTIMES, "opencode-cli")
    choose(unnamed, "选择 opencode vendor preset:", PRESETS, "Anthropic 原生 API")
    unnamed.expect("Add Telegram channel")
    unnamed.sendline("n")
    finish(unnamed, "wizard-anthropic")

    # Named entry: this is the historically divergent createCommand path.
    # Do not leak ANTHROPIC_API_KEY into it: older logic treated that env as a
    # reason to skip the runtime picker. Only the synthetic OpenAI key is set.
    openai_env = base.copy()
    openai_env["OPENAI_API_KEY"] = os.environ["TEST384_OPENAI_DUMMY"]
    named = spawn_create(
        ["node", "create", "wizard-openai"],
        openai_env,
        trace_dir / "named-openai.pty.log",
    )
    choose(named, "选择 runtime:", RUNTIMES, "opencode-cli")
    choose(named, "选择 opencode vendor preset:", PRESETS, "OpenAI")
    finish(named, "wizard-openai")

    print(
        "PEXPECT_PASS runtime_choices=6 exact_order=yes "
        "unnamed=opencode-cli/anthropic named=opencode-cli/openai"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"PEXPECT_FAIL {type(exc).__name__}: {exc}", file=sys.stderr)
        raise
