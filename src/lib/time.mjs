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
