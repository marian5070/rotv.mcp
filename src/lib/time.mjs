const TZ = 'Europe/Bucharest';

function pad(n) { return String(n).padStart(2, '0'); }

function getLocalParts(dateUtc) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(dateUtc).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '00' : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function utcOffsetMinutes(dateUtc) {
  const local = getLocalParts(dateUtc);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return Math.round((asUtc - dateUtc.getTime()) / 60_000);
}

export function localFromUtc(dateUtc) {
  const p = getLocalParts(dateUtc);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${TZ})`;
}

export function utcFromLocalParts({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let i = 0; i < 3; i++) {
    const offset = utcOffsetMinutes(candidate);
    candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60_000);
  }
  return candidate;
}

function addDays(p, n) {
  const u = new Date(Date.UTC(p.year, p.month - 1, p.day) + n * 86_400_000);
  const lp = getLocalParts(u);
  return { year: lp.year, month: lp.month, day: lp.day };
}

function dayOfWeekLocal(p) {
  const u = new Date(Date.UTC(p.year, p.month - 1, p.day));
  return u.getUTCDay();
}

function nextWeekend(now = new Date()) {
  const p = getLocalParts(now);
  const dow = dayOfWeekLocal(p);
  const daysToSaturday = dow === 6 ? 0 : (dow === 0 ? 6 : 6 - dow);
  const sat = addDays(p, daysToSaturday);
  const sun = addDays(sat, 1);
  return {
    from: utcFromLocalParts({ ...sat, hour: 0, minute: 0 }),
    to:   utcFromLocalParts({ ...sun, hour: 23, minute: 59, second: 59 }),
  };
}

export function resolveTimeRef(refRaw, now = new Date()) {
  const ref = String(refRaw || 'now').trim().toLowerCase();
  const today = getLocalParts(now);

  switch (ref) {
    case 'now':
      return { from: now, to: new Date(now.getTime() + 30 * 60_000), label: 'now' };
    case 'tonight':
      return {
        from: utcFromLocalParts({ ...today, hour: 20, minute: 0 }),
        to:   utcFromLocalParts({ ...today, hour: 23, minute: 59, second: 59 }),
        label: 'tonight',
      };
    case 'primetime':
      return {
        from: utcFromLocalParts({ ...today, hour: 20, minute: 0 }),
        to:   utcFromLocalParts({ ...today, hour: 23, minute: 0 }),
        label: 'primetime',
      };
    case 'today':
      return {
        from: utcFromLocalParts({ ...today, hour: 0, minute: 0 }),
        to:   utcFromLocalParts({ ...today, hour: 23, minute: 59, second: 59 }),
        label: 'today',
      };
    case 'tomorrow': {
      const t = addDays(today, 1);
      return {
        from: utcFromLocalParts({ ...t, hour: 0, minute: 0 }),
        to:   utcFromLocalParts({ ...t, hour: 23, minute: 59, second: 59 }),
        label: 'tomorrow',
      };
    }
    case 'weekend': {
      const w = nextWeekend(now);
      return { ...w, label: 'weekend' };
    }
  }

  if (ref.includes('/')) {
    const [a, b] = refRaw.split('/');
    const from = new Date(a);
    const to = new Date(b);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      return { from, to, label: 'range' };
    }
  }

  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(refRaw);
  if (ymd) {
    const date = { year: Number(ymd[1]), month: Number(ymd[2]), day: Number(ymd[3]) };
    return {
      from: utcFromLocalParts({ ...date, hour: 0, minute: 0 }),
      to:   utcFromLocalParts({ ...date, hour: 23, minute: 59, second: 59 }),
      label: refRaw,
    };
  }

  const instant = new Date(refRaw);
  if (!Number.isNaN(instant.getTime())) {
    return { from: instant, to: new Date(instant.getTime() + 60 * 60_000), label: 'instant' };
  }

  return { from: now, to: new Date(now.getTime() + 30 * 60_000), label: 'now (fallback)' };
}

// Admiterea în fereastră pentru uneltele de recomandare. programOverlaps
// acceptă ORICE suprapunere, deci o cerere 20:00–24:00 primea „La bloc" început
// la 18:15 și, la cereri târzii, programe deja terminate. Reguli (filtru, nu
// scor — scorurile rămân reproductibile în explain/compare):
//  - 'now'/'instant' sunt orizonturi de „ce e acum": neschimbat;
//  - începutul efectiv = max(începutul ferestrei, acum) cât fereastra e în curs;
//  - respins dacă s-a terminat deja sau dacă partea pierdută depășește
//    max(10 min, 25% din durată);
//  - doar pentru intervale explicite ('range'), unde sfârșitul e o constrângere
//    a utilizatorului: respins dacă mai puțin de jumătate încape în fereastră.
//    Sfârșitul de 23:59 al lui 'tonight'/'today' e un artefact, nu o constrângere.
export function effectiveWindowStart({ from, to }, now = new Date()) {
  const n = now.getTime();
  return n > from.getTime() && n < to.getTime() ? n : from.getTime();
}

// Fereastră „de seară": interval mărginit de cel mult 6 h, altul decât
// 'now'/'instant'. Doar pentru ele are sens ancorarea pe începutul ferestrei
// și penalizarea startului târziu; pentru 'today'/'tomorrow'/'weekend'/dată,
// ancora pe miezul nopții ar favoriza programele de la 00:00.
export function isEveningWindow(window, now = new Date()) {
  if (!window?.from || !window?.to) return false;
  if (/^(now|instant)/.test(String(window.label || ''))) return false;
  if (now.getTime() >= window.to.getTime()) return false; // fereastră deja încheiată: nimic de ancorat
  const span = window.to.getTime() - effectiveWindowStart(window, now);
  return span > 0 && span <= 6 * 3600_000;
}

export function windowAdmits(program, window, now = new Date()) {
  const label = String(window.label || '');
  if (/^(now|instant)/.test(label)) return true;
  const ps = new Date(program.start).getTime();
  const pe = new Date(program.stop).getTime();
  const wf = effectiveWindowStart(window, now);
  const wt = window.to.getTime();
  if (pe <= wf) return false;
  const durMin = Math.max(1, (pe - ps) / 60_000);
  const missedMin = Math.max(0, wf - ps) / 60_000;
  if (missedMin > Math.max(10, 0.25 * durMin)) return false;
  if (label === 'range') {
    const usableMin = (Math.min(pe, wt) - Math.max(ps, wf)) / 60_000;
    const windowMin = Math.max(1, (wt - wf) / 60_000);
    if (usableMin < 0.5 * Math.min(durMin, windowMin)) return false;
  }
  return true;
}

// Departajare la scor EGAL în ferestre de seară (≤ 6 h): programele care încep
// în a doua jumătate a ferestrei rămase vin după cele din prima jumătate.
// Întoarce 0/1; ordinea existentă se păstrează în interiorul fiecărei grupe.
export function lateStartBucket(startUtc, window, now = new Date()) {
  const label = String(window.label || '');
  if (/^(now|instant)/.test(label)) return 0;
  const wf = effectiveWindowStart(window, now);
  const wt = window.to.getTime();
  if (wt - wf > 6 * 3600_000) return 0;
  return new Date(startUtc).getTime() > wf + (wt - wf) / 2 ? 1 : 0;
}

export function programOverlaps(program, { from, to }) {
  const ps = new Date(program.start).getTime();
  const pe = new Date(program.stop).getTime();
  return ps < to.getTime() && pe > from.getTime();
}

export function programDurationMin(program) {
  return Math.max(0, Math.round((new Date(program.stop).getTime() - new Date(program.start).getTime()) / 60_000));
}

export function shapeProgram(channel, program) {
  const start = new Date(program.start);
  const stop = new Date(program.stop);
  return {
    channel_id: channel.id,
    channel_name: channel.displayName,
    channel_category: channel.category,
    program: {
      title: program.title,
      start_local: localFromUtc(start),
      start_utc: start.toISOString(),
      stop_local: localFromUtc(stop),
      stop_utc: stop.toISOString(),
      duration_min: programDurationMin(program),
      category: program.category,
      description: program.description || '',
    },
  };
}

export { TZ };
