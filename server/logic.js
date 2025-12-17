import { utcDayKey, utcYesterdayDayKey, isOlderThanYesterdayDayKey } from "./time.js";

function asLocation(input) {
  if (!input) return null;
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function markMissing(state, user, now, reason) {
  if (user.status === "missing") return;

  user.status = "missing";
  user.missingSince = user.lastCheckInAt || now;

  const location = user.lastKnownLocation;
  if (location) {
    user.dangerZone = {
      id: state.makeId(),
      type: "danger-zone",
      reason,
      userId: user.id,
      name: user.name,
      location,
      lastSeenAt: (user.lastCheckInAt || now).toISOString()
    };
  } else {
    user.dangerZone = {
      id: state.makeId(),
      type: "danger-zone",
      reason,
      userId: user.id,
      name: user.name,
      location: null,
      lastSeenAt: (user.lastCheckInAt || now).toISOString()
    };
  }
}

export function getOrCreateUser(state, { userId, name }) {
  const id = String(userId || "").trim();
  if (!id) throw new Error("userId is required");

  let user = state.users.get(id);
  if (!user) {
    user = {
      id,
      name: String(name || "Unknown Survivor").slice(0, 60),
      streak: 0,
      lastCheckInAt: null,
      lastCheckInDayKey: null,
      lastKnownLocation: null,
      checkInHistory: [],
      status: "unknown",
      missingSince: null,
      dangerZone: null
    };
    state.users.set(id, user);
  } else if (name) {
    user.name = String(name).slice(0, 60);
  }

  return user;
}

function normalizeCheckInNote(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  return s.slice(0, 180);
}

function pushCheckInHistory(user, { dayKey, at, location, note }) {
  if (!user.checkInHistory) user.checkInHistory = [];
  const entry = {
    dayKey,
    at: at.toISOString(),
    location,
    note
  };

  // Replace existing entry for same day (if user checks in multiple times in a day)
  const idx = user.checkInHistory.findIndex((x) => x?.dayKey === dayKey);
  if (idx >= 0) user.checkInHistory[idx] = entry;
  else user.checkInHistory.push(entry);

  // Keep only last 21 days for demo
  if (user.checkInHistory.length > 21) {
    user.checkInHistory.splice(0, user.checkInHistory.length - 21);
  }
}

export function checkIn(state, { userId, name, location, note }, now = new Date()) {
  const user = getOrCreateUser(state, { userId, name });

  const todayKey = utcDayKey(now);
  const yesterdayKey = utcYesterdayDayKey(now);

  const newLocation = asLocation(location);
  if (newLocation) user.lastKnownLocation = newLocation;

  const cleanNote = normalizeCheckInNote(note);
  pushCheckInHistory(user, {
    dayKey: todayKey,
    at: now,
    location: newLocation,
    note: cleanNote
  });

  if (user.lastCheckInDayKey === todayKey) {
    // no-op: already checked in today
  } else if (user.lastCheckInDayKey === yesterdayKey) {
    user.streak = Math.max(1, (user.streak || 0) + 1);
  } else {
    // streak broke (missed days): reset streak, but do not mark missing here.
    // Missing/danger zone state is computed when a survivor *fails* to check in.
    user.streak = 1;
  }

  user.lastCheckInAt = now;
  user.lastCheckInDayKey = todayKey;
  user.status = "ok";
  user.missingSince = null;
  user.dangerZone = null;

  return user;
}

export function sweepForBrokenStreaks(state, now = new Date()) {
  for (const user of state.users.values()) {
    if (user.status === "missing") continue;
    if (isOlderThanYesterdayDayKey(user.lastCheckInDayKey, now)) {
      markMissing(state, user, now, "streak-broken");
    }
  }
}

export function dangerZones(state, now = new Date()) {
  sweepForBrokenStreaks(state, now);
  const zones = [];
  for (const user of state.users.values()) {
    if (user.status !== "missing") continue;
    if (!user.dangerZone) continue;
    zones.push(user.dangerZone);
  }
  return zones;
}
