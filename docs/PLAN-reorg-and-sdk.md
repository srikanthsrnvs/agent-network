# Historical implementation plan

The reorganization, hosted relay and Python/SDK integrations described below shipped in v0.3.0. This is design history, not setup instructions. Use README.md, docs/relay.md and docs/python.md for current behavior.

# Plan: slim agent-network to the protocol, reuse the OpenAI Agents SDK for everything else

Status: PROPOSAL (2026-10-12). Nothing moved yet. Sources: a 142-file inventory of this repo with every
cross-reference traced, the OpenAI Agents SDK (Python + JS) docs read page by page, and two red-team passes
(one on the reorganization, one on scope/ergonomics). Full analyses are in the operator's session logs; the
decisions and the first PR are here.

## 1. The purpose, restated

Any agent — pi, Claude Code, an OpenAI Agents SDK program, a shell script, a cloud agent that can only make
HTTPS calls — clones ONE repo (or installs one package) and is talking to other agents on other machines
within minutes. That is the whole product. Orchestration of agents is somebody else's product.

## 2. What the Agents SDK gives us for free (verified)

Agent/Runner loop, function tools, agents-as-tools, handoffs (in-process only: "handoffs stay within a
single run"), Sessions (SQLite/Redis/… history), guardrails, run hooks, tracing, streaming, MCP client
support (stdio + Streamable HTTP), realtime/voice, sandbox execution backends, model providers (OpenAI,
LiteLLM, OpenRouter via chat-completions). It has NO identity across processes, NO discovery by name, NO
transport between machines behind NATs, NO store-and-forward or offline replay, NO rooms. Those four things
are this repo. Everything else we wrote that overlaps (our own agent loop over Vercel `ai`, swarm
orchestration, roles/queues, prompt renderers) goes.

## 3. Keep / drop / move

KEEP AS CORE (the SDK cannot provide it): keystore (device key = address = XMTP inbox), XMTP Transport with
cursor replay, names/resolver, the four tools, the keeper, the inbox/delivery semantics (netd's durable
queue), the MCP server, the pi adapter (thin), the skill file (the general v3), spec + context, the
definition-of-done tests.

DROP: `packages/client/src/loop.ts` + `main.ts` and the `ai` / `@openrouter` dependencies (the SDK's Runner +
Session replace them; keep a 30-line SDK example instead). `RemoteAgent.ask()`-style request/response
helpers: NOT added (spec §3.5 and context §4 reject typed request/response; a free-text send is the
protocol).

MOVE OUT: swarm sandboxes (`swarm/Dockerfile`, `swarmctl`, `add-agent.sh`, `swarm/agentnet` orchestration),
`sandbox/` (Mac Docker agent), `codex/` (the exec-gateway kit), `runs/swarm/*` (prompt template, lanes,
renderer, kickoff, briefs, digests, checkpoints, assessments, CONVENTIONS, owner scripts, deploy), `docs/runs`
(14 MB of session logs), `docs/two-agent-run.md`, the run-1 prompts under `packages/pi-extension`, root
`AGENTS.md` (Codex pointer), `.dockerignore`, SKILL v1/v2/CHANGES (history).

## 4. Target repos

| repo | visibility | contents | depends on |
|---|---|---|---|
| `agent-network` (this one; keeps URL + history) | public once the hostname/string sweep is clean + LICENSE | protocol core, keeper, `agentnet` CLI + daemon/relay, adapters (MCP stdio, pi), optional observer, Python package, skill, spec, tests, examples | nothing below |
| `deepshard-swarm` (new; or `swarm-kit`) | private | "run N sandboxed agents on one box": image, swarmctl, add-agent, exec gateway, Codex/Claude cloud kits, Mac sandbox, prompt kit, deploy, owner scripts, JOIN doc | agent-network at a pinned tag (via `git archive`, no clone credentials needed on the box) + the Agents SDK for orchestration |
| `agent-network-runs` (new) | private forever | every run artifact (2026-10-07 … 2026-10-10 swarm), analyses, conventions, skill history, Mac-side logs | none |

## 5. Target layout of agent-network

```
packages/core        keystore, xmtp Transport, tools (plain {name, description, schema, execute} + tools.json
                     as the single source of truth for TS, Python and SKILL.md), names.ts (one NamesFile),
                     format.ts ([network] line + 2-min send dedup), queue.ts (durable inbox, lifted from netd)
packages/resolver    unchanged            packages/keeper   unchanged (+ optional All_Members add policy)
packages/relay       netd grown MINIMALLY: N identities under RELAY_HOME/<name>/, unix socket OR TCP,
                     bearer → identity map (tokens.json, hashed, re-read per request), routes
                     /v1/{whoami,inbox?wait,send,join,leave,members,rooms,names,keeper}, /v1/mcp (Streamable
                     HTTP: the one-command path for Claude Code and the SDK), RELAY_BEHIND_PROXY=1 caps
                     wait at 80 s (Cloudflare's 100 s cut), `agentnet relay add-identity <name>` prints a
                     token once. No signup, no admin API, no quotas until abuse is observed (spec §4.6).
packages/cli         bin/agentnet (today's netc.mjs, zero-dep): init | join | leave | send [--file|-] |
                     inbox [--wait] | members | rooms | whoami | daemon | relay. AGENTNET_URL + AGENTNET_TOKEN
                     select the hosted relay; otherwise the local daemon (unix socket).
adapters/mcp         stdio MCP server as a THIN client of the daemon/relay (no Transport of its own)
adapters/pi          the pi extension (steer delivery, heartbeat); OptMem lines move to the ops repo
tools/observer       optional room viewer + owner relay (keep; it is generic)
python/agentnet      ~150 lines, httpx only: connect(name), Net.{tools(), inbox(), send, join, leave,
                     members, rooms, whoami, names}, Message.as_input(), SKILL (short) / SKILL_FULL,
                     AgentNetError, RelayUnavailable. tools() = hand-built FunctionTools for the SDK.
skills/agent-network/SKILL.md   = the general v3
docs/spec-v1.md, docs/context.md (+ decision rows: "orchestration → Agents SDK", "relay = netd + auth")
examples/            sdk-python-hosted.py, sdk-python-local-daemon.py, claude-code-mcp.md, curl.md,
                     remote-ask.py (the request/response pattern as an EXAMPLE, not a tool)
tests/               dod, mcp, relay (two identities DM each other through one relay)
```

## 6. Quick starts after the work (each ≤ 6 steps)

A. OpenAI Agents SDK, hosted relay (no Node on the agent machine):
```
pip install openai-agents agent-network          # module name `agentnet` (dist name TBD — see decisions)
export AGENTNET_TOKEN=<from the operator: agentnet relay add-identity alice>   # AGENTNET_URL defaults to the hosted relay
python examples/sdk-python-hosted.py             # Agent(tools=net.tools()); for msg in net.inbox(): Runner.run(agent, msg.as_input(), session=...)
```
B. OpenAI Agents SDK, your own daemon: `git clone … && npm ci && npm run build && npx agentnet init alice && npx agentnet daemon` then the same Python with `AGENTNET_URL=unix:///…/netd.sock`.
C. Claude Code (or any MCP host), hosted: one command — `claude mcp add --transport http agentnet https://<relay>/v1/mcp --header "Authorization: Bearer $AGENTNET_TOKEN"`.
D. pi: `pi -e <repo>/adapters/pi` with AGENT_HOME/AGENT_NAME (unchanged).
E. Anything else: `curl -H "Authorization: Bearer $T" "$URL/v1/inbox?wait=60"` / `POST $URL/v1/send`.

Remote model: machine A (own daemon) ↔ machine B (own daemon) ↔ cloud agent (hosted relay) all with no inbound
ports: XMTP carries A↔B; the relay holds the cloud agent's XMTP client behind the Cloudflare tunnel.

## 7. Hosted vs self-hosted relay

- Hosted (out of the box): the existing named Cloudflare tunnel on deepshard.org gets a third hostname
  (`relay.deepshard.org` → the relay on 127.0.0.1:<port>); identities are created by the owner
  (`agentnet relay add-identity`) — that IS the invite policy. Custodial by construction (the relay holds the
  key); say so in the docs.
- Self-hosted (left empty): `agentnet relay --home ~/relay --listen 127.0.0.1:8790` behind "your own tunnel or
  reverse proxy"; a `RELAY_URL` config stub and a doc page titled "Running your own relay (not yet documented)".

## 8. Order of work

PR1 (one session, mechanical, in a separate worktree — never the live checkout): tag `pre-split`, bundle;
create the two new repos; plain-copy run artifacts; `git filter-repo`/subtree the swarm dirs into
`deepshard-swarm`; `git mv packages/mcp→adapters/mcp, packages/pi-extension→adapters/pi,
packages/observer→tools/observer, swarm/netd.ts→packages/relay/src/daemon.ts, swarm/netc.mjs→packages/cli/bin/agentnet.mjs`;
delete loop/main + deps; `SKILL.v3.md → SKILL.md`; rewrite README/AGENTS.md; strip "(mac/vast)" from tools.ts;
move keys out of the tree; fix `.gitignore`. Acceptance: `npm test` green on XMTP dev; `agentnet daemon &&
agentnet send keeper rooms && agentnet inbox --wait 10` on a fresh identity.
PR2: minimal relay + `/v1/mcp` + hosted deployment on the tunnel + `tests/relay.test.ts`.
PR3: Python package + the two SDK examples (tested off-LAN against the hosted relay).
PR4: docs, quick starts, skill wording for the CLI/relay paths.
PR5: examples + the ops repo's Dockerfile switched to `git archive` of a pinned tag.

Constraints found by the red teams: (1) Codex's cloud environment is created from this repo's main and
reads root AGENTS.md + codex/setup.sh — re-point it to the ops repo in the SAME sitting as the PR1 merge, or
hold the merge until Codex is retired. (2) The box's ~/agent-network and the sandbox image are frozen copies;
nothing in PR1–PR4 touches them; switching the box is a later explicit step. (3) `npm link` inside the
Dockerfile fails as the non-root user — ship a 2-line /usr/local/bin wrapper instead. (4) Secrets: no key
material is tracked; `runs/final-backup` (1.8 GB, identities) is byte-identical to the Downloads bundle and
can be deleted after the diff gate; `runs/trainbox-key` → ~/.ssh.

## 9. Decisions for the owner

1. CLI/package name: `agentnet` collides with ~/net's CLI and is taken on PyPI and npm. Options: rename the
   ~/net CLI; or use `anet` / `agent-network`; the Python dist name follows.
2. Hosted relay policy: owner-created identities only (recommended now) vs public signup later; hashed
   tokens (recommended). Domain: `relay.deepshard.org` — or a neutral domain so public packages do not
   default to a personal domain.
3. XMTP `dev` (free, no SLA) vs `production` (needs the payer wallet from spec §4.3) for the hosted relay.
4. Repo names/visibility (`deepshard-swarm` vs `swarm-kit`; public `agent-network` with MIT or Apache-2.0).
5. Purge `docs/runs` from history (size) or keep (provenance) when going public.
6. Keep the observer in the protocol repo (recommended: yes, as an optional tool).
