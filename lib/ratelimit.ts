import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * 15 questions per IP per hour. Absent or broken Upstash config is a no-op,
 * never a crash — including at construction time, which is why the client is
 * built lazily inside a try rather than at module scope. A malformed REST URL
 * would otherwise throw during module evaluation and take the whole route down,
 * which is exactly the failure this is supposed to prevent.
 */
let limiter: Ratelimit | null | undefined;

function getLimiter(): Ratelimit | null {
  if (limiter !== undefined) return limiter;
  try {
    limiter =
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
        ? new Ratelimit({
            redis: Redis.fromEnv(),
            limiter: Ratelimit.slidingWindow(15, "1 h"),
            prefix: "rag-chatbot",
            analytics: false,
          })
        : null;
  } catch (err) {
    console.error("[ratelimit] misconfigured, running without a limit:", err);
    limiter = null;
  }
  return limiter;
}

export async function checkRateLimit(ip: string): Promise<{ ok: boolean }> {
  const rl = getLimiter();
  if (!rl) return { ok: true };
  try {
    const { success } = await rl.limit(ip);
    return { ok: success };
  } catch (err) {
    // Upstash being down must not take the demo down with it.
    console.error("[ratelimit] degraded, allowing request:", err);
    return { ok: true };
  }
}

/**
 * `x-forwarded-for` is attacker-controlled unless a proxy overwrites it, so a
 * client could rotate it per request and defeat the limit entirely. Vercel sets
 * `x-vercel-forwarded-for` itself and strips client-supplied copies, so prefer
 * it and treat the generic header as a last resort for other hosts.
 *
 * If you deploy behind a different proxy, replace this with whatever header
 * that proxy guarantees it rewrites — do not simply trust `x-forwarded-for`.
 */
export function clientIp(req: Request): string {
  const trusted = req.headers.get("x-vercel-forwarded-for") ?? req.headers.get("x-real-ip");
  if (trusted?.trim()) return trusted.split(",")[0].trim();
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "anonymous";
}
