# Codex as a swarm agent — what to set up in the Codex UI

Codex runs in OpenAI's cloud, so it cannot see the LAN. Its path to the Threadripper is:
`codex/bin/sc` → `ssh swarmbox` → a Cloudflare tunnel → the box's sshd → the locked-down user
`codex` whose forced command drops every session into the Docker sandbox `swarm-codex`
(both GPUs, its own RAM/CPU caps, only its own identity). It cannot reach the host or other sandboxes.

1. **Repository access.** In the "Create a cloud environment" dialog, click *Missing a repository?
   Configure access* and grant the Codex GitHub app access to `srikanthsrnvs/agent-network`
   (private). Refresh, tick it, *Get started*.
2. **Environment settings.**
   - Setup script: `bash codex/setup.sh`
   - Secrets: `CODEX_SSH_KEY` = the whole contents of `~/Downloads/codex-swarm-ssh-key.txt` on the
     Mac (the private key of the `codex` ssh user; paste including the BEGIN/END lines).
   - Environment variable: `SWARM_TUNNEL_HOST` = the hostname in
     `~/.config/agent-network/codex_tunnel_host` on the Mac (`something.trycloudflare.com`).
   - Internet access for the agent: **on / full** (it needs ssh through the tunnel while working;
     at minimum allow `*.trycloudflare.com` and `github.com`).
   - Agent permissions: full access (it only ever acts inside its sandbox on the box).
3. **Start the task.** Project = agent-network, Cloud, that environment. Paste the text of
   `codex/BEGIN.md` as the task. Codex reads `AGENTS.md` on its own, which points it to
   `codex/PROMPT.md` (the same contract every swarm agent has: mission, conventions, owner
   protocol, rules, plus its lane).
4. **If the tunnel hostname changes** (quick tunnels get a new name when restarted on the box:
   `tmux attach -t infra`, window `tunnel`; current value in `~/swarm/codex/TUNNEL`), update
   `SWARM_TUNNEL_HOST` in the environment and re-run setup. For a permanent address switch the box to
   a named Cloudflare tunnel or Tailscale and set `SWARM_TUNNEL_HOST` (and the `ProxyCommand` in
   `codex/setup.sh`) accordingly.

Check from any machine with the key and cloudflared: `ssh swarmbox 'hostname; nvidia-smi -L'`
should print `codex` and two RTX A6000s.
