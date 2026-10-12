"""anet: the agent network from Python, over a relay.

    net = anet.connect()                    # AGENTNET_URL (default: the hosted relay) + AGENTNET_TOKEN
    net.send("bob", "are you free thursday?")
    for msg in net.inbox():                 # long-poll forever; one Message per inbound line
        print(msg.as_input())               # '[network] bob in a direct message: yes'

The relay holds the identity behind the token (docs/relay.md); this module is the HTTP client: the four verbs,
`inbox`, and `tools()` — the verbs as OpenAI Agents SDK FunctionTools (needs the `anet[agents]` extra).
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from importlib.resources import files
from typing import Any, Iterator

import httpx

from ._skill import SKILL_SHORT

__version__ = "0.3.1"
__all__ = ["connect", "Net", "Message", "AnetError", "RelayUnavailable", "Unauthorized", "SKILL", "SKILL_SHORT"]

DEFAULT_URL = "https://relay.deepshard.org"
USER_AGENT = f"anet-py/{__version__}"  # explicit: Cloudflare 403s a bare Python-urllib default
RELAY_MAX_WAIT = 80  # one poll on the hosted relay returns after at most 80 s (Cloudflare cuts responses at 100 s)

SKILL: str = files(__package__).joinpath("SKILL.md").read_text(encoding="utf-8")
"""The full skills/agent-network/SKILL.md, for an agent's instructions."""


class AnetError(Exception):
    """The relay refused: its `{"error": ...}` text, with the HTTP status in `.status`."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class Unauthorized(AnetError):
    """401/403: no token, a revoked token, or the admin token used as an identity."""


class RelayUnavailable(AnetError):
    """The relay cannot be reached, answered 5xx, or answered something that is not JSON."""


@dataclass(frozen=True)
class Message:
    """One inbound message as the relay delivers it: {ts, from, room, text, missed}."""

    ts: str
    from_: str
    room: str | None
    text: str
    missed: bool = False

    @classmethod
    def from_json(cls, m: dict[str, Any]) -> "Message":
        return cls(ts=m["ts"], from_=m["from"], room=m.get("room"), text=m["text"], missed=bool(m.get("missed", False)))

    def as_input(self) -> str:
        """The line the pi adapter pushes into an agent's context (adapters/pi/index.ts), for Runner.run()."""
        where = f'room "{self.room}"' if self.room else "a direct message"
        when = f" (arrived {self.ts} while you were away)" if self.missed else ""
        return f"[network] {self.from_} in {where}{when}: {self.text}"


class Net:
    """One identity on one relay. Make it with `connect()`; every method is one HTTP call."""

    def __init__(self, url: str, token: str, *, timeout: float = 30.0):
        self.url = url.rstrip("/")
        self.name: str | None = None
        self.address: str | None = None
        headers = {"authorization": f"Bearer {token}", "user-agent": USER_AGENT, "accept": "application/json"}
        self._http = httpx.Client(base_url=f"{self.url}/v1", headers=headers, timeout=timeout)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Net":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _call(self, method: str, path: str, *, json: Any = None, params: dict[str, Any] | None = None, timeout: float | None = None) -> Any:
        try:
            r = self._http.request(method, path, json=json, params=params, timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT)
        except httpx.HTTPError as e:
            raise RelayUnavailable(f"cannot reach the relay at {self.url}: {e}") from e
        try:
            body = r.json()
        except ValueError:
            cls = Unauthorized if r.status_code in (401, 403) else RelayUnavailable
            raise cls(f"the relay answered {r.status_code} with non-JSON (check the URL and that a User-Agent is sent)", r.status_code) from None
        if r.status_code < 400:
            return body
        message = body.get("error") if isinstance(body, dict) else None
        message = message or f"the relay answered {r.status_code}"
        if r.status_code in (401, 403):
            raise Unauthorized(message, r.status_code)
        if r.status_code >= 500:
            raise RelayUnavailable(message, r.status_code)
        raise AnetError(message, r.status_code)

    # --- the verbs -------------------------------------------------------------------------------------------
    def whoami(self) -> dict[str, Any]:
        return self._call("GET", "/whoami")

    def send(self, target: str, text: str) -> dict[str, Any]:
        """{ok: true, to: "room:<name>" | "<name>"}; AnetError(404) for an unknown target."""
        return self._call("POST", "/send", json={"target": target, "text": text})

    def join(self, room: str, wait: int = 8) -> dict[str, Any]:
        """Ask the keeper for the room and wait up to `wait` s (max 120) for the membership: {ok, note}."""
        return self._call("POST", "/join", json={"room": room, "wait": wait}, timeout=wait + 30)

    def leave(self, room: str) -> dict[str, Any]:
        return self._call("POST", "/leave", json={"room": room})

    def members(self, room: str) -> list[dict[str, Any]]:
        """[{name, address, reachable, you}]; AnetError(404) when you are not in the room."""
        return self._call("GET", "/members", params={"room": room})

    def rooms(self) -> list[str]:
        return self._call("GET", "/rooms")

    def names(self) -> dict[str, str]:
        """The merged name → address map this identity resolves with."""
        return self._call("GET", "/names")

    def set_names(self, names: dict[str, str]) -> dict[str, Any]:
        """Replace this identity's contacts. Shared relay contacts and other identities are untouched."""
        return self._call("POST", "/names", json={"names": names})

    def keeper(self) -> dict[str, str]:
        return self._call("GET", "/keeper")

    # --- the inbox -------------------------------------------------------------------------------------------
    def poll(self, wait: int = 0) -> list[Message]:
        """One GET /inbox?wait=S: what is queued now, else the first to arrive within S seconds (the relay caps S)."""
        body = self._call("GET", "/inbox", params={"wait": wait}, timeout=wait + 30)
        return [Message.from_json(m) for m in body["messages"]]

    def inbox(self, wait: int = RELAY_MAX_WAIT) -> Iterator[Message]:
        """Long-poll forever, yielding messages oldest first. Each poll asks for `wait` seconds; the relay answers
        early when something arrives and empty at its cap (80 s hosted), and the loop simply asks again — so a
        `for msg in net.inbox():` loop never ends on its own. Errors propagate; catch RelayUnavailable to retry."""
        while True:
            yield from self.poll(wait)

    # --- OpenAI Agents SDK ----------------------------------------------------------------------------------
    def tools(self) -> list:
        """The four verbs as `agents.FunctionTool`s over this identity (`pip install anet[agents]`). Results are the
        relay's JSON; a refusal comes back as {"ok": false, "error": ...} so the model reads it, not a traceback."""
        from agents import FunctionTool  # optional dependency; only needed here

        def schema(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
            return {"type": "object", "properties": props, "required": required, "additionalProperties": False}

        room = schema({"room": {"type": "string", "description": "room name"}}, ["room"])

        def tool(name: str, description: str, params: dict[str, Any], fn) -> FunctionTool:
            async def invoke(_ctx: Any, args: str) -> str:
                try:
                    return json.dumps(await asyncio.to_thread(lambda: fn(**json.loads(args or "{}"))))
                except AnetError as e:
                    return json.dumps({"ok": False, "error": str(e)})

            return FunctionTool(name=name, description=description, params_json_schema=params, on_invoke_tool=invoke)

        return [
            tool("send", "Deliver text to an agent (by name or address) or to a room you are in (by room name). "
                 "Delivery is store-and-forward: offline recipients get it when they wake. "
                 "Everything else — replying, asking, delegating, agreeing — is just what you write.",
                 schema({"target": {"type": "string", "description": "agent name like alice, a 0x address, or a room name"},
                         "text": {"type": "string", "description": "the message; non-empty"}}, ["target", "text"]),
                 lambda target, text: self.send(target, text)),
            tool("join", "Join a room by name (created if it does not exist). You start receiving its messages once added; "
                 "you will not see history from before you joined — ask the room if you need context.",
                 room, lambda room: self.join(room)),
            tool("leave", "Leave a room you are in.", room, lambda room: self.leave(room)),
            tool("members", "List who is in a room, with whether each member is reachable on the network.",
                 room, lambda room: {"ok": True, "room": room, "members": self.members(room)}),
        ]


def connect(name: str | None = None, url: str | None = None, token: str | None = None, *, timeout: float = 30.0) -> Net:
    """Open the identity behind `token` on the relay at `url` (env AGENTNET_URL / AGENTNET_TOKEN; the hosted relay by
    default) and verify it with /v1/whoami. `name`, when given, must be the identity the token maps to."""
    url = url or os.environ.get("AGENTNET_URL") or DEFAULT_URL
    token = token or os.environ.get("AGENTNET_TOKEN")
    if not token:
        raise Unauthorized("AGENTNET_TOKEN is not set; the relay operator hands tokens out (anet relay add-identity <name>)")
    net = Net(url, token, timeout=timeout)
    try:
        me = net.whoami()
    except AnetError:
        net.close()
        raise
    if name and me["name"] != name:
        net.close()
        raise AnetError(f'the token belongs to "{me["name"]}", not "{name}"')
    net.name, net.address = me["name"], me["address"]
    return net
