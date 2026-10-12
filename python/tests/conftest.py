"""A relay of our own for the tests: the compiled relay (packages/relay/dist/relay.js) on a random localhost port
with a temp RELAY_HOME holding two identities (alice, bob) made by `anet relay add-identity`, and a keeper
(packages/keeper/dist/main.js) in a temp KEEPER_HOME — on the real XMTP dev network, as tests/relay.test.ts does.
Everything is skipped when node or the dist is missing (run `npm run build` at the repo root first)."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
RELAY_JS = REPO / "packages" / "relay" / "dist" / "relay.js"
KEEPER_JS = REPO / "packages" / "keeper" / "dist" / "main.js"
ANET_MJS = REPO / "packages" / "cli" / "bin" / "anet.mjs"
sys.path.insert(0, str(REPO / "python"))  # the package under test, without an install


def _wait_for(log: Path, pattern: str, proc: subprocess.Popen, seconds: float) -> re.Match:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        m = re.search(pattern, log.read_text(errors="replace")) if log.exists() else None
        if m:
            return m
        if proc.poll() is not None:
            raise RuntimeError(f"{proc.args[1]} exited {proc.returncode}:\n{log.read_text(errors='replace')[-2000:]}")
        time.sleep(0.2)
    raise TimeoutError(f"no /{pattern}/ in {log} after {seconds}s:\n{log.read_text(errors='replace')[-2000:]}")


@pytest.fixture(scope="session")
def relay(tmp_path_factory):
    if shutil.which("node") is None or not RELAY_JS.exists() or not KEEPER_JS.exists():
        pytest.skip("node and the built relay/keeper (npm run build) are needed for the relay tests")
    tmp = tmp_path_factory.mktemp("anet")
    env = {**os.environ, "XMTP_ENV": "dev"}
    procs: list[subprocess.Popen] = []
    try:
        keeper_log = tmp / "keeper.log"
        keeper = subprocess.Popen(["node", str(KEEPER_JS)], env={**env, "KEEPER_HOME": str(tmp / "keeper")},
                                  stdout=keeper_log.open("w"), stderr=subprocess.STDOUT)
        procs.append(keeper)
        keeper_address = _wait_for(keeper_log, r"KEEPER_ADDRESS=(0x[0-9a-fA-F]{40})", keeper, 120).group(1)

        home = tmp / "relay-home"
        tokens = {}
        for name in ("alice", "bob"):
            subprocess.run(["node", str(ANET_MJS), "relay", "add-identity", name, "--home", str(home)], check=True, capture_output=True, env=env)
            tokens[name] = (home / "tokens" / f"{name}.token").read_text().strip()

        relay_log = tmp / "relay.log"
        proc = subprocess.Popen(["node", str(RELAY_JS), "--home", str(home), "--listen", "127.0.0.1:0"],
                                env={**env, "KEEPER_ADDRESS": keeper_address}, stdout=relay_log.open("w"), stderr=subprocess.STDOUT)
        procs.append(proc)
        port = _wait_for(relay_log, r"listening on http://127\.0\.0\.1:(\d+)", proc, 60).group(1)
        _wait_for(relay_log, r"2 identities booted", proc, 120)
        yield {"url": f"http://127.0.0.1:{port}", "tokens": tokens, "keeper": keeper_address, "logs": (keeper_log, relay_log)}
    finally:
        for p in reversed(procs):
            p.terminate()
        for p in procs:
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
