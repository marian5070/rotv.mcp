// Rate limiting pentru REST (/api/v1) — separat de limiterul global MCP.
// Token bucket per identitate, trei niveluri:
//  - anonim:   60 cereri/ORĂ per IP originar (search + concierge)
//  - cu cheie: 300 cereri/MINUT per cheie
//  - emitere chei: 5/oră per IP
function makeLimiter({ capacity, refillPerMinute }) {
  const buckets = new Map();
  const refillPerMs = refillPerMinute / 60_000;

  setInterval(() => {
    const now = Date.now();
    // șterge bucket-urile pline de mult (nu mai codifică nicio penalizare)
    const idleMs = Math.max(10 * 60_000, (capacity / refillPerMinute) * 60_000 * 2);
    for (const [k, b] of buckets) {
      if (now - b.touched > idleMs) buckets.delete(k);
    }
  }, 5 * 60_000).unref();

  return {
    capacity,
    take(id) {
      const now = Date.now();
      let b = buckets.get(id);
      if (!b) {
        b = { tokens: capacity, filled: now, touched: now };
        buckets.set(id, b);
      } else {
        b.tokens = Math.min(capacity, b.tokens + (now - b.filled) * refillPerMs);
        b.filled = now;
        b.touched = now;
      }
      if (b.tokens < 1) {
        const retryAfterSeconds = Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
        return { ok: false, remaining: 0, retryAfterSeconds };
      }
      b.tokens -= 1;
      return { ok: true, remaining: Math.floor(b.tokens) };
    },
  };
}

export const anonLimiter = makeLimiter({ capacity: 60, refillPerMinute: 1 });        // 60/h
export const keyedLimiter = makeLimiter({ capacity: 300, refillPerMinute: 300 });    // 300/min
export const issuanceLimiter = makeLimiter({ capacity: 5, refillPerMinute: 5 / 60 }); // 5/h
