const RATE = Number(process.env.RATE_LIMIT_RPM || 60);
const BURST = Math.max(5, Math.floor(RATE / 3));

const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.lastTouched > 10 * 60_000) buckets.delete(k);
  }
}, 60_000).unref();

function getBucket(key) {
  let b = buckets.get(key);
  const now = Date.now();
  if (!b) {
    b = { tokens: BURST, lastFill: now, lastTouched: now };
    buckets.set(key, b);
    return b;
  }
  const elapsedMin = (now - b.lastFill) / 60_000;
  b.tokens = Math.min(BURST, b.tokens + elapsedMin * RATE);
  b.lastFill = now;
  b.lastTouched = now;
  return b;
}

export function rateLimit({ rpm } = {}) {
  return function (req, res, next) {
    if (req.path === '/mcp/health' || req.path === '/mcp/help') return next();
    const ip = req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || 'unknown';
    const b = getBucket(String(ip));
    if (b.tokens < 1) {
      res.status(429).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32029, message: 'Rate limit exceeded — wait and retry' },
      });
      return;
    }
    b.tokens -= 1;
    next();
  };
}
