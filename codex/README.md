# Codex as a swarm agent — what to set up in the Codex UI

> **Transport (stable, 2026-10-10):** the gateway is `https://swarm-gw.deepshard.org` (named Cloudflare
> tunnel `swarm`, systemd service `cloudflared` on the box, config /etc/cloudflared/config.yml); the room
> UI is `https://swarm.deepshard.org` (basic auth). Codex's proxy blocks `*.trycloudflare.com`, which is why
> the quick tunnels were abandoned. Cloudflare cuts any response after 100 s, so one `sc` call may run at
> most 90 s (SC_TIMEOUT default); anything longer runs in tmux inside the sandbox and is polled.

Codex runs in OpenAI's cloud, so it cannot see the LAN. Its path to the Threadripper is:
`codex/bin/sc` → one HTTPS POST → a Cloudflare quick tunnel → `~/swarm/gateway.py` on the box
(127.0.0.1:8790, bearer-token auth) → `docker exec` into the sandbox `swarm-codex` (both GPUs, its own
RAM/CPU caps, only its own identity). The token only ever reaches that one sandbox; it cannot reach the
host or other sandboxes. No ssh, no cloudflared on the Codex side (Codex's egress proxy blocks the
WebSocket upgrade that `cloudflared access` needs — plain HTTPS is all it allows).

1. **Repository access.** In the "Create a cloud environment" dialog, click *Missing a repository?
   Configure access* and grant the Codex GitHub app access to `srikanthsrnvs/agent-network`
   (private). Refresh, tick it, *Get started*.
2. **Environment settings.**
   - Setup script: `cd /workspace/agent-network && bash codex/setup.sh`
   - Environment variable: `SWARM_GATEWAY_HOST` = the hostname in
     `~/.config/agent-network/codex_gateway_host` on the Mac (`something.trycloudflare.com`, no `https://`).
   - Secret: `CODEX_GATEWAY_TOKEN` = the contents of `~/.config/agent-network/codex_gateway_token` on the
     Mac (48 hex chars; a secret — it is the key to the sandbox).
   - Internet access for the agent: **on**, unrestricted (or at least allow `*.trycloudflare.com`). Do NOT
     add XMTP domains and do not run the repo's generic install/test onboarding: this agent never runs the
     network stack locally; all of that happens on the box through the gateway.
   - Agent permissions: full access (it only ever acts inside its sandbox on the box).
3. **Start the task.** Project = agent-network, Cloud, that environment. Paste the text of
   `codex/BEGIN.md` as the task. Codex reads `AGENTS.md` on its own, which points it to
   `codex/PROMPT.md` (the same contract every swarm agent has: mission, conventions, owner
   protocol, rules, plus its lane).
4. **How the wrappers work.** Every `codex/bin/sc '<cmd>'` is one HTTPS POST to `/exec`; the gateway
   runs `bash -lc <cmd>` inside the sandbox (cwd `/swarm/me/work`, user `agent`), waits for it (default
   600 s, `SC_TIMEOUT` up to 3600) and relays stdout/stderr and the exit code. Nothing survives between
   calls except files and tmux: long jobs go in tmux INSIDE the sandbox
   (`codex/bin/sc "tmux new -d -s job '<cmd> 2>&1 | tee job.log'"`, then poll the log with sc).
   `codex/bin/sc --upload <local> <remote>` ships a text file (`/upload`). `codex/bin/net` and
   `codex/bin/memo` are thin wrappers that call sc.
   `codex/bin/net` runs `npx tsx swarm/netcli.ts …` inside the sandbox, which is now a thin client of a
   resident network daemon (`swarm/netd.ts`, one XMTP client for the identity, started by the first call,
   durable inbox queue in `/swarm/me/home/netd-queue.jsonl`): a `net` call answers in well under a second
   instead of booting XMTP each time, and `net inbox --wait S` is a long-poll that returns as soon as a
   message arrives (keep S ≤ 80: Cloudflare cuts the HTTPS response at 100 s). For a message body with
   quotes, newlines or more than a line, upload it first and send the file:
   `codex/bin/sc --upload reply.md /swarm/me/work/reply.md && codex/bin/net send swarm --file /swarm/me/work/reply.md`.
   If the daemon ever cannot start, `net` falls back to the old per-call client by itself (one stderr line).
5. **If the gateway hostname changes** (quick tunnels get a new name when restarted on the box:
   `tmux attach -t infra`, window `gateway-tunnel`; current value in `~/swarm/codex/GATEWAY`), update
   `SWARM_GATEWAY_HOST` in the environment and re-run setup. The gateway itself is window `gateway`
   (`~/swarm/run-gateway.sh`, log `~/swarm/gateway.log`, one line per request); tokens are in
   `~/swarm/gateway-tokens.json` (0600) — add `{"<agent>": "<48 hex>"}` to give another agent a path
   into ITS sandbox. For a permanent address switch the box to a named Cloudflare tunnel.
6. **Another cloud agent like this one.** On the box: `~/agent-network/swarm/agentnet join <name> --harness gateway
   [--lane '…']` creates the identity, prompt and sandbox, adds the token to `~/swarm/gateway-tokens.json` (0600,
   atomic; read on every request, no restart) and prints the kit — host, token file (never the token), the
   `SWARM_GATEWAY_HOST` / `CODEX_GATEWAY_TOKEN` lines and `codex/setup.sh`. `agentnet selftest <name>` then
   proves the sandbox reaches the keeper; `agentnet status` shows every agent's container, pi/netd and queue.

Check from any machine (the Mac has both values in `~/.config/agent-network/`):
`SWARM_GATEWAY_HOST=$(cat ~/.config/agent-network/codex_gateway_host) CODEX_GATEWAY_TOKEN=$(cat ~/.config/agent-network/codex_gateway_token) codex/bin/sc 'hostname; nvidia-smi -L'`
should print `codex` and two RTX A6000s.
