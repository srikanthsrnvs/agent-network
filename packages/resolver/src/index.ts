/**
 * resolve(name) → verified address. A library, not a service.
 *
 * Spec §3.3: ENS → agent ID → ERC-8004 → verify. Two backends:
 *  - StaticBackend: a name→address map (dev, tests, and a local contacts file).
 *  - EnsBackend:    real ENS on mainnet, verified against ERC-8004 via ENSIP-25/26
 *                   records (usable once we own the parent domain and issue subnames).
 * Raw 0x addresses always pass through. Results are cached with a TTL, like DNS.
 */
import { createPublicClient, http, isAddress, getAddress, type Address, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';

export interface Resolved {
  name: string;
  address: Address;
  /** ERC-8004 agent id when the backend could verify one. */
  agentId?: bigint;
}

export interface NameBackend {
  resolve(name: string): Promise<Resolved | null>;
  /** address → name, when known (used for member rosters and sender attribution). */
  reverse(address: Address): Promise<string | null>;
}

const normalizeName = (name: string): string => name.trim().toLowerCase();

/** Dev backend: an in-memory / JSON-file map of names to addresses. */
export class StaticBackend implements NameBackend {
  private forward = new Map<string, Address>();
  private backward = new Map<string, string>();

  constructor(entries: Record<string, string> = {}) {
    for (const [name, address] of Object.entries(entries)) this.set(name, address as Address);
  }

  set(name: string, address: Address): void {
    const n = normalizeName(name);
    const a = getAddress(address);
    this.forward.set(n, a);
    this.backward.set(a.toLowerCase(), n);
  }

  async resolve(name: string): Promise<Resolved | null> {
    const n = normalizeName(name);
    const address = this.forward.get(n);
    return address ? { name: n, address } : null;
  }

  async reverse(address: Address): Promise<string | null> {
    return this.backward.get(address.toLowerCase()) ?? null;
  }

  entries(): Record<string, Address> {
    return Object.fromEntries(this.forward);
  }
}

/**
 * Real backend: ENS forward resolution on mainnet. Verification against ERC-8004 reads
 * the ENSIP-26 `agent-context` record for `{ erc8004: { registry, agentId } }` and
 * checks the ENSIP-25 `agent-registration[<registry>][<agentId>]` attestation exists.
 * Ownership cross-check against the registry lands with the onboarding service.
 */
export class EnsBackend implements NameBackend {
  private client: PublicClient;

  constructor(rpcUrl?: string) {
    this.client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  }

  async resolve(name: string): Promise<Resolved | null> {
    const n = normalize(name);
    const address = await this.client.getEnsAddress({ name: n });
    if (!address) return null;
    let agentId: bigint | undefined;
    try {
      const context = await this.client.getEnsText({ name: n, key: 'agent-context' });
      const parsed = context ? (JSON.parse(context) as { erc8004?: { registry?: string; agentId?: string } }) : null;
      if (parsed?.erc8004?.registry && parsed.erc8004.agentId) {
        const attested = await this.client.getEnsText({
          name: n,
          key: `agent-registration[${parsed.erc8004.registry}][${parsed.erc8004.agentId}]`,
        });
        if (attested) agentId = BigInt(parsed.erc8004.agentId);
      }
    } catch {
      // unverifiable context is not fatal: the name still resolves, just unverified
    }
    return { name: n, address, agentId };
  }

  async reverse(address: Address): Promise<string | null> {
    return this.client.getEnsName({ address });
  }
}

export interface ResolverOptions {
  backends: NameBackend[];
  ttlMs?: number;
}

/** Tries backends in order; caches hits with a TTL. */
export class Resolver {
  private cache = new Map<string, { value: Resolved; expires: number }>();
  private reverseCache = new Map<string, { value: string | null; expires: number }>();
  private readonly ttlMs: number;

  constructor(private readonly opts: ResolverOptions) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
  }

  async resolve(target: string): Promise<Resolved | null> {
    const t = target.trim();
    if (isAddress(t)) return { name: t, address: getAddress(t) };
    const key = normalizeName(t);
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    for (const backend of this.opts.backends) {
      const value = await backend.resolve(key);
      if (value) {
        this.cache.set(key, { value, expires: Date.now() + this.ttlMs });
        return value;
      }
    }
    return null;
  }

  async reverse(address: Address): Promise<string | null> {
    const key = address.toLowerCase();
    const hit = this.reverseCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    let value: string | null = null;
    for (const backend of this.opts.backends) {
      value = await backend.reverse(address);
      if (value) break;
    }
    this.reverseCache.set(key, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  /** Invalidate cached addresses after an explicit contact update. */
  clearCache(): void {
    this.cache.clear();
    this.reverseCache.clear();
  }

  /** Name if known, else the address — for attributing inbound messages. */
  async label(address: Address): Promise<string> {
    return (await this.reverse(address)) ?? address;
  }
}
