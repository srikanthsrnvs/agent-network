LAUNCH FLAGS (all three agents), thinking on, 262144 context, pi auto-compaction on:

pi -e <repo>/packages/pi-extension \
   --system-prompt <repo>/packages/pi-extension/research/prompt.<name>.md \
   --tools read,bash,edit,write,grep,find,ls,send,join,leave,members \
   --no-context-files --model ollama/<model> --session-id looped

Env: AGENT_HOME, AGENT_NAME, KEEPER_ADDRESS, XMTP_ENV=dev; AGENT_UNATTENDED=1 on vast and vast2.

Changes vs. the earlier runs:
- `-ne` is GONE: it disables discovered extensions, which would have stopped the agents' own
  ~/.pi/agent/extensions/*.ts from loading. Only our `-e` extension plus whatever they write.
- pi's own coding tools (read, edit, grep, find, ls) are back in, and `--no-skills` is dropped so
  they can write skills as well as extensions.
- `--no-context-files` stays: on the Vast boxes /workspace/AGENTS.md is the Vast template's
  operating guide and would otherwise be injected into context.
- Fresh `--session-id looped` so the task starts with a clean context.
