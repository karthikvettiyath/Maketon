import { createClient } from "@supabase/supabase-js";
import { utcDayKey, utcYesterdayDayKey, isOlderThanYesterdayDayKey } from "./time.js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  // Prefer the Service Role Key for server-side operations.
  // Fall back to the anon key for demos where RLS is configured accordingly.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) return null;

  // Cache client for the process lifetime.
  const cacheKey = `${url}::${key.slice(0, 8)}`;
  if (!globalThis.__maketon_supabase || globalThis.__maketon_supabase_key !== cacheKey) {
    globalThis.__maketon_supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    globalThis.__maketon_supabase_key = cacheKey;
  }
  return globalThis.__maketon_supabase;
}

export function supabaseEnabled() {
  return Boolean(getSupabase());
}

export async function dbPing() {
  const sb = getSupabase();
  if (!sb) return { enabled: false };

  // Lightweight read to confirm credentials + network + schema.
  const { error } = await sb.from("zones").select("id").limit(1);
  if (error) throw error;
  return { enabled: true };
}

function normalizeUserId(value) {
  const id = String(value || "").trim();
  if (!id) throw new Error("userId is required");
  return id;
}

function normalizeName(value) {
  return String(value || "Unknown Survivor").slice(0, 60);
}

function normalizeCheckInNote(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  return s.slice(0, 180);
}

async function dbUpsertUserBase(sb, { userId, name }) {
  const id = normalizeUserId(userId);
  const nm = name ? normalizeName(name) : null;

  // Ensure a row exists.
  const { error: upsertErr } = await sb
    .from("users")
    .upsert(
      {
        id,
        ...(nm ? { name: nm } : {})
      },
      { onConflict: "id" }
    );
  if (upsertErr) throw upsertErr;

  const { data: row, error } = await sb
    .from("users")
    .select("id,name,streak,last_check_in_at,last_check_in_day_key,last_lat,last_lng,status,missing_since")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return row;
}

function rowToUser(row, now = new Date()) {
  if (!row) return null;
  const lastDayKey = row.last_check_in_day_key || null;
  const lastAt = row.last_check_in_at ? new Date(row.last_check_in_at) : null;

  let status = row.status || "unknown";
  let missingSince = row.missing_since || null;
  if (lastDayKey && isOlderThanYesterdayDayKey(lastDayKey, now)) {
    status = "missing";
    missingSince = missingSince || (lastAt ? lastAt.toISOString() : null);
  } else if (lastDayKey) {
    status = "ok";
    missingSince = null;
  }

  const loc = toLocation(row.last_lat, row.last_lng);
  return {
    id: row.id,
    name: row.name,
    streak: row.streak ?? 0,
    lastCheckInAt: lastAt,
    lastCheckInDayKey: lastDayKey,
    lastKnownLocation: loc,
    checkInHistory: [],
    status,
    missingSince,
    dangerZone: null
  };
}

export async function dbGetUserWithHistory(userId, now = new Date()) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const row = await dbUpsertUserBase(sb, { userId, name: null });
  const user = rowToUser(row, now);

  const { data: checkins, error } = await sb
    .from("checkins")
    .select("day_key,checked_in_at,lat,lng,note")
    .eq("user_id", user.id)
    .order("day_key", { ascending: true })
    .limit(21);
  if (error) throw error;

  user.checkInHistory = (checkins || []).map((c) => ({
    dayKey: c.day_key,
    at: c.checked_in_at,
    location: toLocation(c.lat, c.lng),
    note: c.note
  }));

  return user;
}

export async function dbCheckIn(payload, now = new Date()) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const { userId, name, location, note } = payload || {};
  const id = normalizeUserId(userId);
  const nm = normalizeName(name);
  const loc = location ? toLocation(location.lat, location.lng) : null;
  const cleanNote = normalizeCheckInNote(note);

  const row = await dbUpsertUserBase(sb, { userId: id, name: nm });

  const todayKey = utcDayKey(now);
  const yesterdayKey = utcYesterdayDayKey(now);
  const prevKey = row?.last_check_in_day_key || null;
  const prevStreak = Number.isFinite(Number(row?.streak)) ? Number(row.streak) : 0;

  let nextStreak = prevStreak;
  if (prevKey === todayKey) {
    nextStreak = Math.max(1, prevStreak || 1);
  } else if (prevKey === yesterdayKey) {
    nextStreak = Math.max(1, (prevStreak || 0) + 1);
  } else {
    nextStreak = 1;
  }

  const upd = {
    id,
    name: nm,
    streak: nextStreak,
    last_check_in_at: now.toISOString(),
    last_check_in_day_key: todayKey,
    status: "ok",
    missing_since: null,
    ...(loc ? { last_lat: loc.lat, last_lng: loc.lng } : {})
  };

  const { error: updErr } = await sb.from("users").upsert(upd, { onConflict: "id" });
  if (updErr) throw updErr;

  const { error: checkErr } = await sb
    .from("checkins")
    .upsert(
      {
        user_id: id,
        day_key: todayKey,
        checked_in_at: now.toISOString(),
        lat: loc?.lat ?? null,
        lng: loc?.lng ?? null,
        note: cleanNote
      },
      { onConflict: "user_id,day_key" }
    );
  if (checkErr) throw checkErr;

  return dbGetUserWithHistory(id, now);
}

export async function dbListDangerZones(limit = 200, now = new Date()) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const { data: rows, error } = await sb
    .from("users")
    .select("id,name,last_check_in_at,last_check_in_day_key,last_lat,last_lng")
    .not("last_check_in_day_key", "is", null)
    .order("last_check_in_at", { ascending: false })
    .limit(Math.max(1, Math.min(500, limit * 4)));
  if (error) throw error;

  const zones = [];
  for (const r of rows || []) {
    if (!isOlderThanYesterdayDayKey(r.last_check_in_day_key, now)) continue;
    const loc = toLocation(r.last_lat, r.last_lng);
    zones.push({
      id: `dz_${r.id}_${r.last_check_in_day_key}`,
      type: "danger-zone",
      reason: "streak-broken",
      userId: r.id,
      name: r.name,
      location: loc,
      lastSeenAt: r.last_check_in_at
    });
    if (zones.length >= limit) break;
  }
  return zones;
}

function toLocation(lat, lng) {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  return { lat: Number(lat), lng: Number(lng) };
}

// -------- SOS --------
export async function dbListSos(limit = 200) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const { data: alerts, error } = await sb
    .from("sos_alerts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const ids = (alerts || []).map((a) => a.id).filter(Boolean);
  let actorsById = new Map();
  if (ids.length) {
    const { data: actors, error: aErr } = await sb
      .from("sos_actors")
      .select("sos_id, role, user_id, name, at")
      .in("sos_id", ids);
    if (aErr) throw aErr;

    actorsById = new Map();
    for (const row of actors || []) {
      const list = actorsById.get(row.sos_id) || { ack: [], responder: [] };
      const entry = { userId: row.user_id, name: row.name, at: row.at };
      if (row.role === "ack") list.ack.push(entry);
      else list.responder.push(entry);
      actorsById.set(row.sos_id, list);
    }
  }

  return (alerts || []).map((a) => {
    const actors = actorsById.get(a.id) || { ack: [], responder: [] };
    return {
      id: a.id,
      type: "sos",
      userId: a.user_id,
      name: a.name,
      message: a.message,
      severity: a.severity,
      category: a.category,
      zoneId: a.zone_id,
      status: a.status,
      acknowledgements: actors.ack,
      responders: actors.responder,
      resolvedAt: a.resolved_at,
      resolvedBy: a.resolved_by_user_id
        ? { userId: a.resolved_by_user_id, name: a.resolved_by_name || "Unknown Survivor" }
        : null,
      location: toLocation(a.lat, a.lng),
      createdAt: a.created_at
    };
  });
}

export async function dbInsertSos(alert) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const payload = {
    id: alert.id,
    user_id: alert.userId,
    name: alert.name,
    message: alert.message,
    severity: alert.severity,
    category: alert.category,
    zone_id: alert.zoneId,
    status: alert.status,
    lat: alert.location?.lat ?? null,
    lng: alert.location?.lng ?? null,
    resolved_at: alert.resolvedAt ?? null,
    resolved_by_user_id: alert.resolvedBy?.userId ?? null,
    resolved_by_name: alert.resolvedBy?.name ?? null,
    created_at: alert.createdAt
  };

  const { error } = await sb.from("sos_alerts").insert(payload);
  if (error) throw error;
  return alert;
}

export async function dbToggleSosActor(sosId, role, { userId, name }) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const sos_id = String(sosId || "").trim();
  const user_id = String(userId || "").trim();
  if (!sos_id || !user_id) throw new Error("Bad Request");

  const { data: existing, error: selErr } = await sb
    .from("sos_actors")
    .select("id")
    .eq("sos_id", sos_id)
    .eq("role", role)
    .eq("user_id", user_id)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing?.id) {
    const { error: delErr } = await sb.from("sos_actors").delete().eq("id", existing.id);
    if (delErr) throw delErr;
    return { on: false };
  }

  const { error: insErr } = await sb.from("sos_actors").insert({
    sos_id,
    role,
    user_id,
    name: String(name || "Unknown Survivor").slice(0, 60)
  });
  if (insErr) throw insErr;
  return { on: true };
}

export async function dbToggleSosResolved(sosId, { userId, name }) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const id = String(sosId || "").trim();
  if (!id) throw new Error("Bad Request");

  const { data: row, error: selErr } = await sb
    .from("sos_alerts")
    .select("resolved_at")
    .eq("id", id)
    .maybeSingle();
  if (selErr) throw selErr;

  const isResolved = Boolean(row?.resolved_at);
  const next = isResolved
    ? {
      status: "open",
      resolved_at: null,
      resolved_by_user_id: null,
      resolved_by_name: null
    }
    : {
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by_user_id: String(userId || "").trim() || null,
      resolved_by_name: String(name || "Unknown Survivor").slice(0, 60)
    };

  const { error: updErr } = await sb.from("sos_alerts").update(next).eq("id", id);
  if (updErr) throw updErr;
  return { resolved: !isResolved };
}

// -------- Threats --------
export async function dbListThreats(limit = 200) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const { data, error } = await sb
    .from("threats")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data || []).map((t) => ({
    id: t.id,
    type: "threat",
    userId: t.user_id,
    name: t.name,
    label: t.label,
    severity: t.severity,
    confidence: t.confidence ?? undefined,
    source: t.source ?? undefined,
    amplitude: t.amplitude ?? undefined,
    baseline: t.baseline ?? undefined,
    location: toLocation(t.lat, t.lng),
    createdAt: t.created_at
  }));
}

export async function dbInsertThreat(threat) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const payload = {
    id: threat.id,
    user_id: threat.userId,
    name: threat.name,
    label: threat.label,
    severity: threat.severity,
    confidence: threat.confidence ?? null,
    source: threat.source ?? null,
    amplitude: threat.amplitude ?? null,
    baseline: threat.baseline ?? null,
    lat: threat.location?.lat ?? null,
    lng: threat.location?.lng ?? null,
    created_at: threat.createdAt
  };

  const { error } = await sb.from("threats").insert(payload);
  if (error) throw error;
  return threat;
}

// -------- Zone markers --------
export async function dbListZoneMarkers(limit = 200) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const { data, error } = await sb
    .from("zone_markers")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data || []).map((m) => ({
    id: m.id,
    type: "zoneMarker",
    kind: m.kind,
    label: m.label,
    radiusM: m.radius_m,
    userId: m.user_id,
    name: m.name,
    location: { lat: m.lat, lng: m.lng },
    createdAt: m.created_at
  }));
}

export async function dbInsertZoneMarker(marker) {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase not configured");

  const payload = {
    id: marker.id,
    kind: marker.kind,
    label: marker.label,
    radius_m: marker.radiusM,
    user_id: marker.userId,
    name: marker.name,
    lat: marker.location.lat,
    lng: marker.location.lng,
    created_at: marker.createdAt
  };

  const { error } = await sb.from("zone_markers").insert(payload);
  if (error) throw error;
  return marker;
}
