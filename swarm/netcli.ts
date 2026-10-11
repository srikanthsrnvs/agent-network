// netcli: kept for every wrapper that runs `npx tsx swarm/netcli.ts <verb> ...`. The implementation is
// swarm/netc.mjs (talks to the resident daemon swarm/netd.ts; falls back to swarm/netcli-legacy.ts,
// the former per-call client, when the daemon cannot start). Same argv, same stdout, same exit codes.
await import('./netc.mjs');
