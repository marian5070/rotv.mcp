import crypto from 'node:crypto';

// IP hash salt: a per-process random secret combined with the CURRENT UTC day
// at hash time. Within one process-day the hash is stable (distinct clients
// are countable); it never links a client across days, and it changes on
// restart (the usage rollup labels weeks with restarts as upper bounds).
const PROC_SALT = crypto.randomBytes(8).toString('hex');
function ipHash(ip) {
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(String(ip) + PROC_SALT + ':' + day).digest('hex').slice(0, 12);
}

export function accessLog(req, res, next) {
  const start = process.hrtime.bigint();

  const ip = (req.headers['cf-connecting-ip'] || req.ip || req.socket?.remoteAddress || '0.0.0.0');

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    const line = {
      t: new Date().toISOString(),
      evt: 'http',
      m: req.method,
      p: req.path,
      s: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      ip_h: ipHash(ip),
      ua: (req.headers['user-agent'] || '').slice(0, 80),
    };
    process.stdout.write(JSON.stringify(line) + '\n');
  });

  next();
}
