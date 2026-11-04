#!/usr/bin/env python3
"""Capture the complete Pi release in a disposable Linux container with no network.

Uses the reviewed Rosetta farm's loopback model and scenario definitions. Mount the
release and Rosetta checkout read-only; give this process only a fresh output volume.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile


def sha(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rosetta", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    revision = subprocess.check_output(["git", "-C", str(args.rosetta), "rev-parse", "HEAD"], text=True).strip()
    if revision != "4282c44276d070958fbc442ca7a5b7021354aa5e":
        raise RuntimeError("Rosetta farm revision differs from the reviewed pin")
    if subprocess.check_output(["git", "-C", str(args.rosetta), "status", "--porcelain", "--", "tools/groundtruth"], text=True).strip():
        raise RuntimeError("Rosetta farm has uncommitted changes")
    if sys.platform != "linux" or not Path("/.dockerenv").exists():
        raise RuntimeError("release census requires a disposable Linux Docker container")
    routes = Path("/proc/net/route").read_text().splitlines()[1:]
    if any(line.split()[0] != "lo" for line in routes):
        raise RuntimeError("release census requires Docker --network none")
    for line in Path("/proc/net/ipv6_route").read_text().splitlines():
        if line.split()[-1] != "lo" and int(line.split()[8], 16) & 1:
            raise RuntimeError("release census has a non-loopback IPv6 route")
    try:
        with socket.create_connection(("1.1.1.1", 443), timeout=1):
            raise RuntimeError("public destination is reachable")
    except OSError as error:
        network_error = error.errno
    os.environ.clear()
    os.environ.update(PATH="/usr/local/bin:/usr/bin:/bin", HOME="/tmp/pi-census-home", LANG="C.UTF-8")
    Path(os.environ["HOME"]).mkdir(exist_ok=True)
    sys.path.insert(0, str(args.rosetta))
    from tools.groundtruth import farm
    manifest_path = args.bundle / "release-bundle.json"
    manifest = json.loads(manifest_path.read_text())
    if (manifest["vendor"], manifest["version"], manifest["platform"]) != ("pi", "1.5.0", "linux-x64"):
        raise RuntimeError("release identity differs")
    binary = args.bundle / "release" / manifest["tree"]["entry"]
    if sha(binary) != manifest["tree"]["entrySha256"]:
        raise RuntimeError("release executable digest differs")
    version = subprocess.check_output([str(binary), "--version"], text=True).strip()
    if version != "1.5.0":
        raise RuntimeError("release version differs")
    args.output.mkdir(parents=True, exist_ok=False)
    started = datetime.now(timezone.utc).isoformat()
    with tempfile.TemporaryDirectory(prefix="pi-release-census-") as temporary:
        work = Path(temporary)
        server, thread = farm.start_server(log_path=work / "mock.jsonl")
        host, port = server.server_address
        scenarios = []
        try:
            for scenario in farm.SCENARIOS["pi"]:
                name = scenario["name"]
                directory = work / name
                home = directory / "home"
                agent_home = directory / "pi-home"
                project = directory / "project"
                home.mkdir(parents=True)
                project.mkdir()
                farm._write_pi_config(agent_home, f"http://{host}:{port}", context_window=1024 if name == "compaction" else 128000, compact=name == "compaction")
                for step, prompt in enumerate(scenario["prompts"]):
                    extra = list(scenario["extra_args"])
                    if name == "fork" and step:
                        sessions = sorted((agent_home / "agent/sessions").rglob("*.jsonl"))
                        if not sessions:
                            raise RuntimeError("fork has no native session")
                        extra = ["--fork", str(sessions[0]), *extra]
                    command, environment, _ = farm._scenario_invocation("pi", binary, prompt, step, extra, home, agent_home, f"http://{host}:{port}", project, directory)
                    farm._scenario_step(command, directory, name, step, environment, project, allow_failure=scenario.get("allow_failure", False))
                journals = sorted((agent_home / "agent/sessions").rglob("*.jsonl"))
                if not journals:
                    raise RuntimeError(f"{name} produced no native journal")
                if name == "compaction" and not any(json.loads(line).get("type") == "compaction" for journal in journals for line in journal.read_text().splitlines() if line.strip()):
                    raise RuntimeError("compaction produced no native compaction entry")
                target = args.output / name
                target.mkdir()
                for index, journal in enumerate(journals):
                    shutil.copyfile(journal, target / ("events.jsonl" if len(journals) == 1 else f"events-{index + 1:02}.jsonl"))
                scenarios.append(name)
                print(f"captured {name}: {len(journals)} journal(s)", flush=True)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    receipt = {"schemaVersion": 1, "vendor": "pi", "version": version, "platform": "linux-x64", "startedAt": started, "capturedAt": datetime.now(timezone.utc).isoformat(), "harness": "pi/census/release.py with pinned Rosetta mock-provider scenarios", "rosettaRevision": revision, "artifactSha256": sha(manifest_path), "entrySha256": sha(binary), "scenarios": scenarios, "sandbox": {"kind": "docker-network-none", "nonLoopbackRoutes": 0, "publicDestinationErrno": network_error}}
    (args.output / "release-capture.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    main()
