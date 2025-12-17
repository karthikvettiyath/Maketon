function pad2(n) {
  return String(n).padStart(2, "0");
}

export function utcDayKey(date) {
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  return `${y}-${m}-${d}`;
}

export function utcYesterdayDayKey(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDayKey(d);
}

export function isOlderThanYesterdayDayKey(lastDayKey, now) {
  if (!lastDayKey) return false;
  const yesterdayKey = utcYesterdayDayKey(now);
  const todayKey = utcDayKey(now);

  // Any day key that is not today or yesterday counts as broken streak.
  return lastDayKey !== todayKey && lastDayKey !== yesterdayKey;
}
