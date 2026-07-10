import crypto from 'node:crypto';

const DAILY_SALT = (() => {
  const d = new Date().toISOString().slice(0, 10);
  return crypto.randomBytes(8).toString('hex') + ':' + d;
})();

export function accessLog(req, res, next) {
  const t0 = Date.now();
  const start = process.hrtime.bigint();

  const ip = (req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || '0.0.0.0');
  const ipHash = crypto.createHash('sha256').update(String(ip) + DAILY_SALT).digest('hex').slice(0, 12);

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    const line = {
      t: new Date().toISOString(),
      evt: 'http',
      m: req.method,
      p: req.path,
      s: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      ip_h: ipHash,
      ua: (req.headers['user-agent'] || '').slice(0, 80),
    };
    process.stdout.write(JSON.stringify(line) + '\n');
  });

  next();
}
