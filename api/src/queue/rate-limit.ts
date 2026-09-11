/**
 * Token buckets, keyed by PROVIDER rather than by queue.
 *
 * This is the whole point of the module. BullMQ's own limiter is per queue,
 * and Gemini quota is shared across every queue that calls it -- ingest
 * (vision extraction), adjudicate, enrich and generate all spend from one
 * free-tier budget. Four per-queue limiters of N/min permit 4N/min to the
 * provider and the account is throttled or billed regardless of how neatly
 * each queue stayed inside its own allowance.
 *
 * The bucket lives in Redis so it is shared across every worker process too,
 * and refills lazily: there is no sweeper, the elapsed time since the last
 * take is converted into tokens when the next take happens.
 */
import type IORedis from 'ioredis';
import { redis } from './index.js';
import type { ProviderName } from '../types.js';

export interface ProviderLimits {
  /** Bucket size: the largest burst allowed after an idle period. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
}

/**
 * Free-tier defaults, deliberately conservative. GEMINI_API_KEY and
 * GROQ_API_KEY are empty in this environment, so nothing here is exercised
 * against a live provider yet.
 */
export const PROVIDER_LIMITS: Record<ProviderName, ProviderLimits> = {
  gemini: { capacity: 15, refillPerSecond: 0.25 }, // ~15 rpm
  groq: { capacity: 30, refillPerSecond: 0.5 }, // ~30 rpm
};

/**
 * Atomic because it is read-modify-write on shared state: two workers running
 * the check-then-decrement in application code would both see the last token.
 * Returns [allowed, waitMs] so a caller that is refused knows how long to
 * sleep instead of spinning.
 */
const TAKE_SCRIPT = `
local key        = KEYS[1]
local capacity   = tonumber(ARGV[1])
local refill     = tonumber(ARGV[2])
local now        = tonumber(ARGV[3])
local cost       = tonumber(ARGV[4])

local state   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens  = tonumber(state[1])
local ts      = tonumber(state[2])
if tokens == nil then tokens = capacity; ts = now end

tokens = math.min(capacity, tokens + (now - ts) * refill)

local allowed = 0
local wait    = 0
if tokens >= cost then
  tokens  = tokens - cost
  allowed = 1
else
  wait = math.ceil(((cost - tokens) / refill) * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- Expire an idle bucket: a full bucket is indistinguishable from a fresh one.
redis.call('EXPIRE', key, math.ceil(capacity / refill) + 60)
return { allowed, wait }
`;

export class ProviderRateLimiter {
  constructor(
    private readonly client: IORedis = redis(),
    private readonly limits: Record<ProviderName, ProviderLimits> = PROVIDER_LIMITS,
  ) {}

  private key(provider: ProviderName): string {
    return `ratelimit:provider:${provider}`;
  }

  /** Non-blocking. Reports whether a call may proceed and, if not, when to retry. */
  async tryTake(provider: ProviderName, cost = 1): Promise<{ allowed: boolean; waitMs: number }> {
    const limit = this.limits[provider];
    const [allowed, wait] = (await this.client.eval(
      TAKE_SCRIPT,
      1,
      this.key(provider),
      String(limit.capacity),
      String(limit.refillPerSecond),
      String(Date.now() / 1000),
      String(cost),
    )) as [number, number];
    return { allowed: allowed === 1, waitMs: wait };
  }

  /**
   * Waits for capacity, up to timeoutMs. Returns false on timeout so the
   * caller can defer the job rather than fail the paper -- when Gemini is
   * exhausted, vision extraction defers; it does not lose the upload.
   */
  async acquire(provider: ProviderName, cost = 1, timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { allowed, waitMs } = await this.tryTake(provider, cost);
      if (allowed) return true;
      if (Date.now() + waitMs > deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 1000)));
    }
  }
}
