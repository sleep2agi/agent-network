#!/usr/bin/env python3
"""Assemble SHA256SUMS + anet-bin-manifest.json from cli-binary artifacts.

Each artifact directory contains the binary, `<name>.sha256`, and
`<name>.build.json` produced by scripts/build-anet-bin.mjs. Every leg must
agree on the three package versions and the bundle version.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_sha_line(text: str, filename: str) -> str:
    line = text.strip()
    parts = line.split()
    if len(parts) != 2 or parts[1] != filename:
        raise SystemExit(f"sha256 line must be '<digest>  {filename}', got {line!r}")
    digest = parts[0].lower()
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise SystemExit(f"bad sha256 digest for {filename}")
    return digest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    if len(args.commit) != 40 or any(c not in "0123456789abcdef" for c in args.commit):
        raise SystemExit("commit must be 40 hex characters")
    if not args.version or any(c in args.version for c in " \t\r\n/\\"):
        raise SystemExit("version must be a single path-safe token")

    dirs = sorted(p for p in args.artifacts.iterdir() if p.is_dir())
    if not dirs:
        raise SystemExit(f"no artifact directories under {args.artifacts}")

    packages: dict[str, str] | None = None
    targets: list[dict[str, object]] = []
    sums: list[str] = []

    for directory in dirs:
        metas = list(directory.glob("*.build.json"))
        shas = list(directory.glob("*.sha256"))
        if len(metas) != 1 or len(shas) != 1:
            raise SystemExit(f"{directory.name}: expected one .build.json and one .sha256")
        meta = json.loads(metas[0].read_text(encoding="utf-8"))
        filename = metas[0].name[: -len(".build.json")]
        binary = directory / filename
        if not binary.is_file():
            raise SystemExit(f"missing binary {binary}")
        recorded = parse_sha_line(shas[0].read_text(encoding="utf-8"), filename)
        actual = sha256_file(binary)
        if recorded != actual:
            raise SystemExit(f"{filename}: sha256 file {recorded} != bytes {actual}")
        size = binary.stat().st_size
        if int(meta["bytes"]) != size:
            raise SystemExit(f"{filename}: build.json bytes {meta['bytes']} != {size}")
        if meta["bundle"] != args.version:
            raise SystemExit(f"{filename}: bundle {meta['bundle']} != {args.version}")
        leg = {
            "agent-network": meta["anet"],
            "agent-node": meta["agentNode"],
            "commhub-server": meta["commhubServer"],
        }
        if packages is None:
            packages = leg
        elif packages != leg:
            raise SystemExit(f"{filename}: package versions {leg} != {packages}")
        targets.append({
            "target": meta["target"],
            "file": filename,
            "sha256": actual,
            "bytes": size,
        })
        sums.append(f"{actual}  {filename}")

    assert packages is not None
    targets.sort(key=lambda item: str(item["file"]))
    sums.sort()
    manifest = {
        "version": args.version,
        "commit": args.commit,
        "packages": packages,
        "targets": targets,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    (args.out / "anet-bin-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )
    for item in targets:
        src = next(args.artifacts.glob(f"*/{item['file']}"))
        dest = args.out / str(item["file"])
        dest.write_bytes(src.read_bytes())
        sha_src = src.with_name(src.name + ".sha256")
        (args.out / f"{item['file']}.sha256").write_text(sha_src.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"assembled {len(targets)} target(s) -> {args.out}")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
