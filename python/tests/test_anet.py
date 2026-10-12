"""anet against a relay of our own (conftest): connect, the verbs, the inbox, the error classes, the SDK tools."""
from __future__ import annotations

import asyncio
import json
import time

import pytest

import anet
from anet import AnetError, Message, RelayUnavailable, Unauthorized

from conftest import REPO

ROOM = f"py-test-{int(time.time()):x}"


def receive(net: anet.Net, match, seconds: float = 90) -> Message:
    """Read the inbox until a message matches (the keeper's confirmations and other traffic are drained too)."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for m in net.poll(wait=max(1, min(20, int(deadline - time.monotonic())))):
            if match(m): return m
    raise TimeoutError("no matching message")


# --- no relay needed -----------------------------------------------------------------------------------------
def test_message_as_input_matches_the_pi_adapter():
    dm = Message.from_json({"ts": "2026-10-11T12:00:00.000Z", "from": "bob", "room": None, "text": "48 threads", "missed": False})
    assert dm.as_input() == "[network] bob in a direct message: 48 threads"
    room = Message.from_json({"ts": "2026-10-11T12:00:00.000Z", "from": "alice", "room": "lab", "text": "hi all", "missed": True})
    assert room.as_input() == '[network] alice in room "lab" (arrived 2026-10-11T12:00:00.000Z while you were away): hi all'
    assert room.from_ == "alice" and room.missed is True


def test_skill_texts():
    assert anet.SKILL == (REPO / "skills" / "agent-network" / "SKILL.md").read_text(encoding="utf-8"), "python/anet/SKILL.md is a copy; re-copy it"
    assert "## 2. The three rules that failed live" in anet.SKILL
    lines = anet.SKILL_SHORT.strip().splitlines()
    assert 30 <= len(lines) <= 60
    for needle in ("Only `send` delivers", "No acknowledgements", "You ARE the machine", "@owner", "0x address"):
        assert needle in anet.SKILL_SHORT


def test_connect_without_token_and_unreachable_relay(monkeypatch):
    monkeypatch.delenv("AGENTNET_TOKEN", raising=False)
    with pytest.raises(Unauthorized):
        anet.connect(url="http://127.0.0.1:9")
    with pytest.raises(RelayUnavailable):
        anet.connect(url="http://127.0.0.1:9", token="x" * 48, timeout=2)


# --- against the relay ---------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def alice(relay):
    with anet.connect("alice", relay["url"], relay["tokens"]["alice"]) as net:
        yield net


@pytest.fixture(scope="module")
def bob(relay):
    with anet.connect(url=relay["url"], token=relay["tokens"]["bob"]) as net:
        yield net


def test_connect_whoami_names_keeper(relay, alice, bob):
    assert (alice.name, bob.name) == ("alice", "bob")
    assert alice.address.startswith("0x") and len(alice.address) == 42
    me = bob.whoami()
    assert me["name"] == "bob" and me["env"] == "dev"
    assert sorted(alice.names()) == ["alice", "bob", "keeper"]
    assert alice.keeper() == {"name": "keeper", "address": relay["keeper"]}
    with pytest.raises(Unauthorized) as e:
        anet.connect(url=relay["url"], token="z" * 48)
    assert e.value.status == 401
    with pytest.raises(AnetError, match='belongs to "bob", not "alice"'):
        anet.connect("alice", relay["url"], relay["tokens"]["bob"])
    assert anet.Net(relay["url"], relay["tokens"]["alice"])._http.headers["user-agent"] == f"anet-py/{anet.__version__}"


def test_dm_and_inbox(alice, bob):
    assert alice.send("bob", "are you free thursday?") == {"ok": True, "to": "bob"}
    got = receive(bob, lambda m: m.text == "are you free thursday?")
    assert got.from_ == "alice" and got.room is None and got.missed is False
    assert got.as_input() == "[network] alice in a direct message: are you free thursday?"
    with pytest.raises(AnetError) as e:
        alice.send("nobody", "hi")
    assert e.value.status == 404 and "neither a room you are in nor a known agent name" in str(e.value)
    with pytest.raises(AnetError, match="text \\(string\\) required"):
        alice.send("bob", "")


def test_room_join_members_send(alice, bob):
    assert alice.join(ROOM, wait=60)["ok"] is True
    assert bob.join(ROOM, wait=60)["ok"] is True
    assert ROOM in bob.rooms()
    members = bob.members(ROOM)
    assert sorted(m["name"] for m in members) == ["alice", "bob", "keeper"]
    assert next(m for m in members if m["name"] == "bob")["you"] is True
    assert alice.send(ROOM, "hi all, alice here") == {"ok": True, "to": f"room:{ROOM}"}
    got = receive(bob, lambda m: m.room == ROOM and m.text == "hi all, alice here")
    assert got.from_ == "alice"
    assert got.as_input() == f'[network] alice in room "{ROOM}": hi all, alice here'
    with pytest.raises(AnetError, match="you are not in no-such-room") as e:
        alice.members("no-such-room")
    assert e.value.status == 404


def test_tools_schemas_and_invocation(alice):
    pytest.importorskip("agents")
    from agents import FunctionTool

    tools = alice.tools()
    assert [t.name for t in tools] == ["send", "join", "leave", "members"]
    for t in tools:
        assert isinstance(t, FunctionTool) and t.strict_json_schema
        s = t.params_json_schema
        assert s["type"] == "object" and s["additionalProperties"] is False and sorted(s["properties"]) == sorted(s["required"])
    assert sorted(tools[0].params_json_schema["properties"]) == ["target", "text"]
    assert tools[1].params_json_schema["properties"] == {"room": {"type": "string", "description": "room name"}}

    run = lambda tool, args: json.loads(asyncio.run(tool.on_invoke_tool(None, json.dumps(args))))
    members = run(tools[3], {"room": ROOM})
    assert members["ok"] is True and sorted(m["name"] for m in members["members"]) == ["alice", "bob", "keeper"]
    assert run(tools[0], {"target": "nobody", "text": "hi"})["ok"] is False
    assert run(tools[0], {"target": ROOM, "text": "posted through the tool"}) == {"ok": True, "to": f"room:{ROOM}"}
    assert run(tools[2], {"room": "no-such-room"}) == {"ok": False, "error": "you are not in no-such-room"}
