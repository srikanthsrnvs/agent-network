# Agent Network — Design Context & Handoff

**Purpose of this file:** Everything an implementing agent needs to know that is *not* in the spec: why decisions were made, what was rejected, what prior art exists, and where the open edges are. Read this alongside `agent-network-spec-v1.md`. The spec is authoritative where they differ.

**Date:** 2026-09-29

---

## 1. The product in one paragraph

We are building personal hardware devices where the entire computer is an AI agent. We need a way for these agents to find each other, verify each other, and talk, both 1:1 and in open group rooms anyone can join or leave. Think "DNS + email + Slack" for agents. Ethereum provides naming and identity. XMTP provides messaging. The user never sees any of it; they pick a handle and talk to their own agent.

---

## 2. Design philosophy (in priority order)

1. **Maximize agent collaboration.** This is the goal. Everything else serves it. We explicitly decided *not* to design around rogue-swarm or misalignment concerns in v1.
2. **Primitive tools, emergent structure.** Taken directly from how OpenAI built their multi-agent system (Noam Brown, Dwarkesh Podcast, Sept 2026). Give agents a `send` primitive whose output lands in the recipient's context, and let coordination emerge. Do not ship workflow tools (delegate, vote, request, accept, escrow). Do not ship typed message schemas. Free text only.
3. **Wrap, don't build.** If XMTP, Cloudflare, ENS, or an existing standard already does it, use it. Custom infrastructure needs a written justification.
4. **Zero friction.** No wallets, seed phrases, gas, balances, or crypto vocabulary anywhere in the user experience.
5. **Simple v1.** Several richer designs were proposed and cut. Ship the minimum that passes the definition-of-done, then iterate.

---

## 3. How we got here (decision history)

### Starting point
Original idea: build a DNS-like discovery registry on Ethereum, plus a custom relay network, plus escrow payments, plus a typed request/response message protocol.

### Iteration 1 — Reachability is non-negotiable
Home devices are behind NAT and often asleep. A name that resolves to an unreachable URL is worthless. Reachability moved into v1 as a hard requirement, satisfied by a store-and-forward layer.

### Iteration 2 — Learn from OpenAI's multi-agent work
Key lessons applied from the Brown transcript:
- Their agents get a single "message another agent" tool; the message is inserted into the recipient's context. Structure emerges from training and priors, not scaffolding.
- Scaffolded coordinator/worker patterns limit agents (siblings can't talk, clarification questions are awkward).
- Agents broadcast changes of mind, converge through discussion, and self-organize.
- Agents behave differently when talking to agents vs. humans and can run 10-15x faster among themselves.
- Context forking is powerful (out of scope for us across owners, noted for v2).

We initially proposed a richer design (sessions, shared workspaces, room summaries, forking, principal/pace fields, tabs). **All of it was cut as too complex for v1.** What survived: free-text `send`, open rooms, four primitive tools.

### Iteration 3 — Replace custom relay with Cloudflare, then with XMTP
First we mapped the relay onto Cloudflare Durable Objects + PartyKit (one object per agent mailbox, one per room, WebSocket Hibernation for idle devices). Then we checked whether the remaining custom code could be replaced too, and found XMTP does the entire transport layer: Ethereum-address identity, MLS group encryption, offline delivery, DMs and groups, an Agent SDK. XMTP became the transport; the Cloudflare relay is kept as a documented fallback.

### Iteration 4 — Mainnet, not L2
We only write to chain once per device (the ERC-8004 mint). At that frequency, mainnet's simplicity and neutrality beat L2 cost savings. ENS subnames are issued off-chain via CCIP-Read so they cost nothing. Revisit if per-device gas becomes visible at volume.

### Iteration 5 — Subname domain
The parent ENS domain must be an open good, not a company brand (the `www` model). Candidates considered: `agents.eth`, `agent.eth`, `aaa.eth`, `a2a.eth`, `mesh.eth`, `agora.eth`, `link.eth`, `hail.eth`. **Not yet decided.** All the short/common ones are almost certainly already registered; owner needs to check at app.ens.domains and likely buy on secondary. `a2a` conflicts with Google's A2A protocol name. Examples in the spec use `alice.agent.eth` as a placeholder.

---

## 4. Things we explicitly rejected

| Rejected | Why |
|---|---|
| Typed message schema (hello/request/response/etc.) | Scaffolding; limits emergent coordination |
| Coordinator/worker hierarchy | Same |
| Escrow / payments in v1 | Collaboration should never start with a payment prompt; ship free messaging first |
| Custom relay servers | XMTP does it; Cloudflare does it if XMTP fails |
| Custom envelope + encryption | XMTP does it |
| Capability fields in the agent card | Agents say what they can do in messages |
| Room purpose, summaries, pinned workspaces | v2; newcomers ask the room |
| Forking / instance suffixes | v2 |
| Room visibility settings, invites | All rooms open by name in v1 |
| L2 deployment | Mainnet; one write per device |
| On-chain room registry | Rooms are XMTP groups; not on-chain |
| Designing against rogue swarms | Not a v1 concern; owner's explicit call |
| No resident per-agent network process for non-pi harnesses (ssh or MCP straight into the sandbox instead) | Reversed 2026-10-11: cloud harnesses (Codex, hosted Claude Code) sit behind proxies that block ssh and WebSocket, so HTTPS plus a local resident client on the box (`swarm/netd.ts`, driven by `swarm/netc.mjs`) is the universal carrier; it serves the same four verbs plus `inbox` and nothing else, and it replaced a 2–47 s XMTP boot per call and an argv-quoting bug class (`send --file`) |

---

## 5. Prior art and standards to use (verified as of Sept 2026)

- **ERC-8004 "Trustless Agents."** Identity Registry (ERC-721, mint gives an agent ID + tokenURI) and Reputation Registry are final and deployed on mainnet (contracts live Jan 29, 2026; mainnet registry named `8004.eth`). Validation Registry still in revision. Payments out of scope for the standard. SDKs: `erc-8004-js` (TS, ethers/viem), `@chaoschain/sdk` (JS + Python), Agent0 SDK.
- **ENS agent standards.** ENSIP-25 defines an `agent-registration[registry][agentId]` text record binding a name to an ERC-8004 entry; the ENS app shows an "AI Agents" section for names that have one. ENSIP-26 defines `agent-context` and `agent-endpoint[protocol]` text records. **Recommendation not yet folded into spec:** use these instead of a custom agent-card JSON, so our names are standard agent names readable by any ENS-aware client.
- **Off-chain ENS subnames.** ENSIP-10 wildcard resolver + EIP-3668 CCIP-Read. Proven pattern (Coinbase `cb.id`, several hackathon projects). Zero gas per name.
- **ERC-8128.** Signed HTTP requests so an agent proves it controls its address. Use for any HTTP endpoints we add.
- **XMTP.** Agent SDK: `@xmtp/agent-sdk` with `createDmWithAddress`, `createGroupWithAddresses`, `on('text')`, `canMessage`. Groups are MLS-encrypted, max 250 members, admin-managed. Consent states (allowed/denied/unknown) built in. Network is migrating from XMTP-operated V3 to a fee-paying mainnet with a curated set of ~7 node operators approved by a security council. Fees paid by apps via a USDC payer wallet; agents/Node apps can sign directly, browser/mobile apps use a gateway. **Mainnet live status not confirmed; verify before building.**
- **Cloudflare (fallback + gateway host).** Durable Objects with WebSocket Hibernation API, SQL Storage, Alarms. `durable-chat-template` and PartyKit/PartyServer are the starting points if we ever build our own relay.

---

## 6. Key clarifications made during design (likely questions an implementer will have)

- **Messages are not on-chain transactions.** They go through XMTP nodes off-chain. XMTP fees are prepaid in bulk by our payer wallet and settled in aggregate. The chain is touched once per device (mint) and occasionally by us (top-ups).
- **"Relay" in early drafts = XMTP nodes now.** We do not run relays.
- **Rooms are XMTP groups plus a room-keeper agent.** XMTP groups require an admin to add members. The keeper is admin of every room and adds anyone who DMs it "join". This is how we get open join/leave on top of an admin-only primitive.
- **Room history lives only on members' devices.** The network holds undelivered messages temporarily. A new joiner sees nothing from before they joined.
- **Spam** is handled by XMTP consent + "does this address resolve to one of our names?" + the receiving agent's own judgment and owner-set plain-language policies. One identity per attested device prevents sybil flooding of sponsored mints.
- **Subnames are tenancies.** We own the parent domain. Users can later point their own `.eth` name at the same ERC-8004 ID (v2: bring your own name).
- **Lost device = lost key = lost name** in v1. Recovery is the thinnest point in the abstraction and is deferred.

---

## 7. What to build first (suggested order)

1. Confirm XMTP mainnet status and fee model. Decide V3 vs mainnet target.
2. Pick and acquire the parent ENS domain. Deploy a CCIP-Read wildcard resolver for subnames.
3. Onboarding service: keygen on device → sponsored ERC-8004 mint on mainnet → issue subname → set ENSIP-25 record → create XMTP inbox.
4. Device client: XMTP client + the four tools (`send`, `join`, `leave`, `members`) exposed to the agent model, incoming messages pushed into context.
5. Room-keeper agent.
6. Gateway (Cloudflare Worker) holding the payer wallet if devices shouldn't hold it.
7. Run the three definition-of-done tests in the spec.

---

## 8. Open items requiring a human decision

- Parent ENS domain (see §3, Iteration 5).
- Whether to adopt ENSIP-25/26 records in place of the custom card (recommended yes).
- Token ownership: does the user's own wallet own the ERC-8004 token, or a device-held key with a recovery scheme?
- Does the device run the XMTP client directly or does the gateway proxy the whole connection?
- Which ERC-8004 SDK.

---

## 9. Source material

- Dwarkesh Podcast, "Noam Brown – Agent swarms, alignment, & recursive self-improvement," Sept 2026. Relevant sections: multi-agent tool design (~00:00–00:22), agent-vs-human speed and behavior, the "local minimum of working independently" observation.
- ERC-8004 spec and deployment announcements (Jan 2026).
- ENSIP-25, ENSIP-26 (docs.ens.domains).
- XMTP docs: Agent SDK, network decentralization, messaging fees.
- Cloudflare docs: Durable Objects, WebSocket Hibernation, `durable-chat-template`.
