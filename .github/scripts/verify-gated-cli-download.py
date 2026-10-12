#!/usr/bin/env python3
"""Reuse a main release.yml tarball; never build or republish npm here."""
import argparse
import hashlib
import json
import re
import tarfile
from pathlib import Path

GATES = (
    "build tarball",
    "gate 1 — install-path smoke (real TTY)",
    "gate 2 — PINNED_* version pin audit",
    "gate 3 — release notes shape (Install + Upgrade)",
    "gate 4 — 上手指南里的版本断言",
)


def validate_checkout_source(run, build, commit, run_id, build_log):
    """Bind a differing workflow head to its authenticated original build log.
    A caller-supplied SHA or matching package bytes alone is not source proof.
    """
    if (not build_log or build.get("run_id") != int(run_id)
            or build.get("head_sha") != run.get("head_sha")
            or not isinstance(build.get("id"), int) or build["id"] <= 0):
        raise ValueError("original build source evidence missing")
    steps = [s for s in build.get("steps", []) if s.get("name") == "Verify and bind release source"]
    if len(steps) != 1 or steps[0].get("conclusion") != "success":
        raise ValueError("original build source guard not successful")
    # GitHub job logs carry an ISO timestamp per line. Accept only this
    # format, not arbitrary grep hits from build output or caller metadata.
    lines = []
    for line in build_log.splitlines():
        match = re.match(r"^\d{4}-\d{2}-\d{2}T[0-9:.]+Z (.*)$", line.lstrip("\ufeff"))
        if match:
            lines.append(match[1])
    checkouts = [i for i, line in enumerate(lines) if line == "[command]/usr/bin/git log -1 --format=%H"]
    groups = [i for i, line in enumerate(lines) if line ==
              '##[group]Run if [[ "$PUBLISH" == true ]]; then bash .github/scripts/verify-release-main.sh; fi']
    if len(checkouts) != 1 or len(groups) != 1 or checkouts[0] >= groups[0]:
        raise ValueError("original build checkout evidence ambiguous")
    if checkouts[0] + 1 >= len(lines) or lines[checkouts[0] + 1] != commit:
        raise ValueError("actual build checkout differs from requested source")
    end = next((i for i in range(groups[0] + 1, len(lines)) if lines[i] == "##[endgroup]"), None)
    if end is None:
        raise ValueError("original source guard log incomplete")
    env = lines[groups[0] + 1:end]
    if ([line.strip() for line in env if line.strip().startswith("RELEASE_COMMIT:")]
            != ["RELEASE_COMMIT: " + commit]
            or [line.strip() for line in env if line.strip().startswith("PUBLISH:")] != ["PUBLISH: true"]):
        raise ValueError("original source guard input differs")


def validate_run(run, jobs, commit, run_id, build_log=None):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("full40 main source required")
    if (run.get("id") != int(run_id)
            or run.get("head_branch") != "main"
            or run.get("event") != "workflow_dispatch"
            or run.get("path") != ".github/workflows/release.yml"):
        raise ValueError("not the requested official main release run")
    for name in GATES:
        matches = [j for j in jobs["jobs"] if j.get("name") == name]
        if len(matches) != 1 or matches[0].get("conclusion") != "success":
            raise ValueError("required package gate not successful: " + name)
    if run.get("head_sha") != commit:
        build = next(j for j in jobs["jobs"] if j.get("name") == "build tarball")
        validate_checkout_source(run, build, commit, run_id, build_log)


def validate_tarball(path, version, expected_sha):
    if not re.fullmatch(r"2\.3\.0-preview\.\d+", version):
        raise ValueError("explicit CLI preview version required")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        raise ValueError("explicit inner tarball SHA256 required")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected_sha:
        raise ValueError("inner tarball byte mismatch")
    with tarfile.open(path, "r:gz") as archive:
        manifest = json.load(archive.extractfile("package/package.json"))
    if manifest.get("name") != "@sleep2agi/agent-network" or manifest.get("version") != version:
        raise ValueError("wrong CLI package identity/version")
    return digest


def main():
    parser = argparse.ArgumentParser()
    for key in ("commit", "run-id", "version", "sha256", "directory"):
        parser.add_argument("--" + key, required=True)
    parser.add_argument("--build-log")
    args = parser.parse_args()
    validate_run(json.loads(Path("release-run.json").read_text()),
                 json.loads(Path("release-jobs.json").read_text()), args.commit, args.run_id,
                 Path(args.build_log).read_text() if args.build_log else None)
    packages = list(Path(args.directory).glob("*.tgz"))
    if len(packages) != 1:
        raise ValueError("exactly one gated tarball required")
    validate_tarball(packages[0], args.version, args.sha256)
    if json.loads(Path("agent-network/package.json").read_text())["version"] != args.version:
        raise ValueError("checked-out main CLI version differs")
    runtime = json.loads(Path("agent-node/package.json").read_text())["version"]
    url = ("https://github.com/sleep2agi/agent-network/releases/download/cli-v"
           + args.version + "/" + packages[0].name)
    print("# Official gated CLI download\n")
    print(f"Main source `{args.commit}`, release.yml run `{args.run_id}`; build and all four gates SUCCESS.")
    print(f"Inner tarball SHA256 `{args.sha256}`. No npm publish or dist-tag change in this workflow.")
    print("\n## Install\n")
    print(f"Install the CLI `{args.version}` tarball from {url} with npm into a chosen private prefix;")
    print(f"install the exact paired `@sleep2agi/agent-node@{runtime}` there as well.")
    print("\n## Upgrade\n")
    print("Follow docs-site/docs/deploy/daemon.md: retain the old private pair/config, wait for idle,")
    print("switch only the requested Daemon, verify actual processes and fresh Hub heartbeat, or roll back.")
    print("No business node/account/session is automatically switched. Not a native installer or live OAuth proof.")


if __name__ == "__main__":
    main()
