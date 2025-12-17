import http from "http";
import express from "express";
import cors from "cors";
import { Server as SocketIOServer } from "socket.io";

import "./config.js";

import {
  supabaseEnabled,
  dbPing,
  dbInsertSos,
  dbInsertThreat,
  dbInsertZoneMarker,
  dbListSos,
  dbListThreats,
  dbListZoneMarkers,
  dbToggleSosActor,
  dbToggleSosResolved
} from "./db.js";

import { createInitialState } from "./state.js";
import { checkIn, dangerZones, getOrCreateUser, sweepForBrokenStreaks } from "./logic.js";

const PORT = Number(process.env.PORT || 61234);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

const state = createInitialState();

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(
  cors({
    origin: [CLIENT_ORIGIN],
    credentials: false
  })
);

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "Upside-Down Survivor Network",
    time: new Date().toISOString(),
    supabase: { enabled: supabaseEnabled() }
  });
});

app.get("/api/db-health", (req, res) => {
  (async () => {
    try {
      const info = await dbPing();
      res.json({ ok: true, ...info });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || "DB Error" });
    }
  })();
});

app.get("/api/zones", (req, res) => {
  res.json({ zones: state.zones });
});

app.get("/api/camps", (req, res) => {
  res.json({ camps: state.camps });
});

app.get("/api/sos", (req, res) => {
  (async () => {
    try {
      if (supabaseEnabled()) {
        const sos = await dbListSos(200);
        res.json({ sos });
        return;
      }
      res.json({ sos: state.sosAlerts.slice(-200).reverse() });
    } catch (e) {
      res.status(500).json({ error: e.message || "Server Error" });
    }
  })();
});

app.get("/api/threats", (req, res) => {
  (async () => {
    try {
      if (supabaseEnabled()) {
        const threats = await dbListThreats(200);
        res.json({ threats });
        return;
      }
      res.json({ threats: state.threats.slice(-200).reverse() });
    } catch (e) {
      res.status(500).json({ error: e.message || "Server Error" });
    }
  })();
});

app.get("/api/danger-zones", (req, res) => {
  res.json({ dangerZones: dangerZones(state) });
});

app.get("/api/map", (req, res) => {
  (async () => {
    try {
      if (supabaseEnabled()) {
        const [threats, zoneMarkers] = await Promise.all([dbListThreats(200), dbListZoneMarkers(200)]);
        res.json({
          camps: state.camps,
          dangerZones: dangerZones(state),
          threats,
          zoneMarkers
        });
        return;
      }
      res.json({
        camps: state.camps,
        dangerZones: dangerZones(state),
        threats: state.threats.slice(-200).reverse(),
        zoneMarkers: state.zoneMarkers.slice(-200).reverse()
      });
    } catch (e) {
      res.status(500).json({ error: e.message || "Server Error" });
    }
  })();
});

app.get("/api/zone-markers", (req, res) => {
  (async () => {
    try {
      if (supabaseEnabled()) {
        const zoneMarkers = await dbListZoneMarkers(200);
        res.json({ zoneMarkers });
        return;
      }
      res.json({ zoneMarkers: state.zoneMarkers.slice(-200).reverse() });
    } catch (e) {
      res.status(500).json({ error: e.message || "Server Error" });
    }
  })();
});

app.post("/api/zone-markers", (req, res) => {
  (async () => {
    try {
      const marker = createZoneMarker(req.body);
      state.zoneMarkers.push(marker);
      if (supabaseEnabled()) {
        await dbInsertZoneMarker(marker);
      }
      io.emit("zone_marker_add", marker);
      res.json({ zoneMarker: marker });
    } catch (e) {
      res.status(400).json({ error: e.message || "Bad Request" });
    }
  })();
});

function normalizeZoneMarkerKind(value) {
  const v = String(value || "").toLowerCase();
  if (["safe", "danger", "resource", "rally", "blocked"].includes(v)) return v;
  return "rally";
}

function normalizeRadiusM(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 250;
  return Math.max(30, Math.min(2000, Math.round(n)));
}

function normalizeLocation(location) {
  if (!location) return null;
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function createZoneMarker(payload) {
  const { userId, name, label, kind, radiusM, location } = payload || {};
  const loc = normalizeLocation(location);
  if (!loc) throw new Error("Missing location");
  const safeLabel = String(label || "").trim().slice(0, 80);
  const marker = {
    id: state.makeId(),
    type: "zoneMarker",
    kind: normalizeZoneMarkerKind(kind),
    label: safeLabel || "Marked Zone",
    radiusM: normalizeRadiusM(radiusM),
    userId: String(userId || "").trim() || null,
    name: String(name || "Unknown Survivor").slice(0, 60),
    location: loc,
    createdAt: new Date().toISOString()
  };
  return marker;
}

app.get("/api/users/:userId", (req, res) => {
  try {
    const user = getOrCreateUser(state, { userId: req.params.userId, name: null });
    res.json({ user });
  } catch (e) {
    res.status(400).json({ error: e.message || "Bad Request" });
  }
});

app.post("/api/checkin", (req, res) => {
  try {
    const user = checkIn(state, req.body);
    io.emit("checkin_update", { user });
    io.emit("danger_zones_update", { dangerZones: dangerZones(state) });
    res.json({ user });
  } catch (e) {
    res.status(400).json({ error: e.message || "Bad Request" });
  }
});

app.post("/api/sos", (req, res) => {
  const { userId, name, message, location, severity, category, zoneId } = req.body || {};
  const alert = {
    id: state.makeId(),
    type: "sos",
    userId: String(userId || "").trim() || null,
    name: String(name || "Unknown Survivor").slice(0, 60),
    message: String(message || "").slice(0, 400),
    severity: normalizeSosSeverity(severity),
    category: normalizeSosCategory(category),
    zoneId: String(zoneId || "").trim() || null,
    status: "open",
    acknowledgements: [],
    responders: [],
    resolvedAt: null,
    resolvedBy: null,
    location: location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))
      ? { lat: Number(location.lat), lng: Number(location.lng) }
      : null,
    createdAt: new Date().toISOString()
  };

  state.sosAlerts.push(alert);
  (async () => {
    try {
      if (supabaseEnabled()) await dbInsertSos(alert);
    } catch {
      // Non-fatal for demo; keeps in-memory behavior even if DB fails.
    }
  })();
  io.emit("sos_alert", alert);
  res.json({ sos: alert });
});

function normalizeSosSeverity(value) {
  const v = String(value || "").toLowerCase();
  if (["low", "medium", "high", "critical"].includes(v)) return v;
  return "high";
}

function normalizeSosCategory(value) {
  const v = String(value || "").toLowerCase();
  if (["medical", "evac", "supplies", "threat", "lost", "general"].includes(v)) return v;
  return "general";
}

function findSosAlert(sosId) {
  const id = String(sosId || "").trim();
  if (!id) return null;
  const list = state.sosAlerts;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.id === id) return list[i];
  }
  return null;
}

function toggleActor(list, { userId, name }) {
  const uid = String(userId || "").trim();
  if (!uid) return { next: list, on: false };
  const next = Array.isArray(list) ? [...list] : [];
  const idx = next.findIndex((x) => x?.userId === uid);
  if (idx >= 0) {
    next.splice(idx, 1);
    return { next, on: false };
  }
  next.unshift({
    userId: uid,
    name: String(name || "Unknown Survivor").slice(0, 60),
    at: new Date().toISOString()
  });
  if (next.length > 12) next.splice(12);
  return { next, on: true };
}

app.post("/api/threats", (req, res) => {
  const { userId, name, label, severity, location, confidence, source, amplitude, baseline } = req.body || {};
  const threat = {
    id: state.makeId(),
    type: "threat",
    userId: String(userId || "").trim() || null,
    name: String(name || "Unknown Survivor").slice(0, 60),
    label: String(label || "Threat").slice(0, 120),
    severity: ["low", "medium", "high"].includes(severity) ? severity : "medium",
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : undefined,
    source: source ? String(source).slice(0, 40) : undefined,
    amplitude: Number.isFinite(Number(amplitude)) ? Number(amplitude) : undefined,
    baseline: Number.isFinite(Number(baseline)) ? Number(baseline) : undefined,
    location: location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))
      ? { lat: Number(location.lat), lng: Number(location.lng) }
      : null,
    createdAt: new Date().toISOString()
  };

  state.threats.push(threat);
  (async () => {
    try {
      if (supabaseEnabled()) await dbInsertThreat(threat);
    } catch {
      // Non-fatal for demo; keeps in-memory behavior even if DB fails.
    }
  })();
  io.emit("threat_report", threat);
  res.json({ threat });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: [CLIENT_ORIGIN],
    methods: ["GET", "POST"]
  }
});

function addChatMessage(zoneId, msg) {
  const z = String(zoneId || "").trim();
  if (!z) return null;
  if (!state.zoneMessages.has(z)) state.zoneMessages.set(z, []);
  const list = state.zoneMessages.get(z);
  list.push(msg);
  if (list.length > 300) list.splice(0, list.length - 300);
  return msg;
}

function findMessage(zoneId, messageId) {
  const z = normalizeZoneId(zoneId);
  const id = String(messageId || "").trim();
  if (!z || !id) return null;
  const list = state.zoneMessages.get(z) || [];
  // scan from the end (recent messages more likely)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.id === id) return list[i];
  }
  return null;
}

function getZoneReactionEntry(zoneId, messageId) {
  const z = normalizeZoneId(zoneId);
  const id = String(messageId || "").trim();
  if (!z || !id) return null;
  if (!state.zoneReactions.has(z)) state.zoneReactions.set(z, new Map());
  const zoneMap = state.zoneReactions.get(z);
  if (!zoneMap.has(id)) {
    zoneMap.set(id, { confirm: new Set(), dispute: new Set() });
  }
  return zoneMap.get(id);
}

function reactionSnapshot(zoneId, messageId) {
  const z = normalizeZoneId(zoneId);
  const id = String(messageId || "").trim();
  const zoneMap = state.zoneReactions.get(z);
  const entry = zoneMap?.get(id);
  return {
    zoneId: z,
    messageId: id,
    confirmCount: entry ? entry.confirm.size : 0,
    disputeCount: entry ? entry.dispute.size : 0
  };
}

function normalizeZoneId(zoneId) {
  return String(zoneId || "").trim();
}

function upsertPresence(zoneId, socket, { userId, name }) {
  const z = normalizeZoneId(zoneId);
  if (!z) return;
  if (!state.zonePresence.has(z)) state.zonePresence.set(z, new Map());
  const zoneMap = state.zonePresence.get(z);
  zoneMap.set(socket.id, {
    socketId: socket.id,
    userId: String(userId || "").trim() || null,
    name: String(name || "Unknown Survivor").slice(0, 60),
    joinedAt: new Date().toISOString()
  });
}

function removePresence(zoneId, socket) {
  const z = normalizeZoneId(zoneId);
  if (!z) return;
  const zoneMap = state.zonePresence.get(z);
  if (!zoneMap) return;
  zoneMap.delete(socket.id);
  if (zoneMap.size === 0) state.zonePresence.delete(z);
}

function presenceSnapshot(zoneId) {
  const z = normalizeZoneId(zoneId);
  const zoneMap = state.zonePresence.get(z);
  const users = zoneMap ? Array.from(zoneMap.values()) : [];
  // keep deterministic order for UI
  users.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return { zoneId: z, users, count: users.length };
}

io.on("connection", (socket) => {
  socket.data.joinedZones = new Set();

  socket.emit("hello", {
    name: "Upside-Down Survivor Network",
    zones: state.zones,
    camps: state.camps
  });

  socket.on("join_zone", ({ zoneId, userId, name }) => {
    const z = normalizeZoneId(zoneId);
    if (!z) return;
    socket.join(`zone:${z}`);
    socket.data.joinedZones.add(z);

    upsertPresence(z, socket, { userId, name });
    io.to(`zone:${z}`).emit("zone_presence", presenceSnapshot(z));

    const history = (state.zoneMessages.get(z) || []).slice(-80);
    socket.emit("zone_history", { zoneId: z, messages: history });

    // Send current pinned commander broadcast (if any)
    socket.emit("zone_pinned_update", { zoneId: z, pinned: state.zonePinned.get(z) || null });
  });

  socket.on("leave_zone", ({ zoneId }) => {
    const z = normalizeZoneId(zoneId);
    if (!z) return;
    socket.leave(`zone:${z}`);
    socket.data.joinedZones.delete(z);
    removePresence(z, socket);
    io.to(`zone:${z}`).emit("zone_presence", presenceSnapshot(z));
  });

  socket.on("typing", ({ zoneId, userId, name, isTyping }) => {
    const z = normalizeZoneId(zoneId);
    if (!z) return;
    io.to(`zone:${z}`).emit("typing", {
      zoneId: z,
      userId: String(userId || "").trim() || null,
      name: String(name || "Unknown Survivor").slice(0, 60),
      isTyping: Boolean(isTyping),
      at: new Date().toISOString()
    });
  });

  socket.on("chat_message", ({ zoneId, userId, name, text, kind }) => {
    const z = normalizeZoneId(zoneId);
    if (!z) return;
    const allowedKinds = new Set(["info", "threat", "resource", "route"]);
    const k = allowedKinds.has(kind) ? kind : "info";
    const msg = {
      id: state.makeId(),
      type: "chat",
      zoneId: z,
      userId: String(userId || "").trim() || null,
      name: String(name || "Unknown Survivor").slice(0, 60),
      kind: k,
      text: String(text || "").slice(0, 600),
      createdAt: new Date().toISOString()
    };

    addChatMessage(z, msg);
    io.to(`zone:${z}`).emit("chat_message", msg);
  });

  socket.on("pin_message", ({ zoneId, messageId, userId, name }, ack) => {
    const z = normalizeZoneId(zoneId);
    if (!z) return;
    const msg = findMessage(z, messageId);
    if (!msg) {
      if (typeof ack === "function") ack({ ok: false, error: "Message not found" });
      return;
    }

    const pinned = {
      id: state.makeId(),
      zoneId: z,
      messageId: msg.id,
      kind: msg.kind,
      text: msg.text,
      from: { userId: msg.userId || null, name: msg.name },
      pinnedBy: { userId: String(userId || "").trim() || null, name: String(name || "Unknown Survivor").slice(0, 60) },
      createdAt: msg.createdAt,
      pinnedAt: new Date().toISOString()
    };

    state.zonePinned.set(z, pinned);
    io.to(`zone:${z}`).emit("zone_pinned_update", { zoneId: z, pinned });
    if (typeof ack === "function") ack({ ok: true, pinned });
  });

  socket.on("unpin_message", ({ zoneId }, ack) => {
    const z = normalizeZoneId(zoneId);
    if (!z) return;
    state.zonePinned.delete(z);
    io.to(`zone:${z}`).emit("zone_pinned_update", { zoneId: z, pinned: null });
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("react_message", ({ zoneId, messageId, userId, reaction }, ack) => {
    const z = normalizeZoneId(zoneId);
    const id = String(messageId || "").trim();
    const uid = String(userId || "").trim();
    if (!z || !id || !uid) {
      if (typeof ack === "function") ack({ ok: false, error: "Bad Request" });
      return;
    }

    // Ensure the message exists in this zone
    if (!findMessage(z, id)) {
      if (typeof ack === "function") ack({ ok: false, error: "Message not found" });
      return;
    }

    const r = reaction === "dispute" ? "dispute" : "confirm";
    const entry = getZoneReactionEntry(z, id);

    // Toggle + enforce mutual exclusivity
    if (r === "confirm") {
      if (entry.confirm.has(uid)) entry.confirm.delete(uid);
      else entry.confirm.add(uid);
      entry.dispute.delete(uid);
    } else {
      if (entry.dispute.has(uid)) entry.dispute.delete(uid);
      else entry.dispute.add(uid);
      entry.confirm.delete(uid);
    }

    const snap = reactionSnapshot(z, id);
    io.to(`zone:${z}`).emit("message_reaction_update", snap);
    if (typeof ack === "function") {
      ack({
        ok: true,
        my: { confirm: entry.confirm.has(uid), dispute: entry.dispute.has(uid) },
        ...snap
      });
    }
  });

  socket.on("disconnect", () => {
    for (const z of socket.data.joinedZones || []) {
      removePresence(z, socket);
      io.to(`zone:${z}`).emit("zone_presence", presenceSnapshot(z));
    }
  });

  socket.on("sos_alert", (payload) => {
    const { userId, name, message, location, severity, category, zoneId } = payload || {};
    const alert = {
      id: state.makeId(),
      type: "sos",
      userId: String(userId || "").trim() || null,
      name: String(name || "Unknown Survivor").slice(0, 60),
      message: String(message || "").slice(0, 400),
      severity: normalizeSosSeverity(severity),
      category: normalizeSosCategory(category),
      zoneId: String(zoneId || "").trim() || null,
      status: "open",
      acknowledgements: [],
      responders: [],
      resolvedAt: null,
      resolvedBy: null,
      location: location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))
        ? { lat: Number(location.lat), lng: Number(location.lng) }
        : null,
      createdAt: new Date().toISOString()
    };

    state.sosAlerts.push(alert);
    (async () => {
      try {
        if (supabaseEnabled()) await dbInsertSos(alert);
      } catch {
        // Non-fatal for demo
      }
    })();
    io.emit("sos_alert", alert);
  });

  socket.on("sos_ack", ({ sosId, userId, name }, ack) => {
    const alert = findSosAlert(sosId);
    if (!alert) {
      if (typeof ack === "function") ack({ ok: false, error: "SOS not found" });
      return;
    }

    const { next, on } = toggleActor(alert.acknowledgements, { userId, name });
    alert.acknowledgements = next;
    (async () => {
      try {
        if (supabaseEnabled()) await dbToggleSosActor(alert.id, "ack", { userId, name });
      } catch {
        // Non-fatal for demo
      }
    })();
    io.emit("sos_update", { sos: alert });
    if (typeof ack === "function") ack({ ok: true, on, sos: alert });
  });

  socket.on("sos_take", ({ sosId, userId, name }, ack) => {
    const alert = findSosAlert(sosId);
    if (!alert) {
      if (typeof ack === "function") ack({ ok: false, error: "SOS not found" });
      return;
    }

    const { next, on } = toggleActor(alert.responders, { userId, name });
    alert.responders = next;
    (async () => {
      try {
        if (supabaseEnabled()) await dbToggleSosActor(alert.id, "responder", { userId, name });
      } catch {
        // Non-fatal for demo
      }
    })();
    io.emit("sos_update", { sos: alert });
    if (typeof ack === "function") ack({ ok: true, on, sos: alert });
  });

  socket.on("sos_resolve", ({ sosId, userId, name }, ack) => {
    const alert = findSosAlert(sosId);
    if (!alert) {
      if (typeof ack === "function") ack({ ok: false, error: "SOS not found" });
      return;
    }

    const uid = String(userId || "").trim() || null;
    const nm = String(name || "Unknown Survivor").slice(0, 60);

    if (alert.resolvedAt) {
      alert.status = "open";
      alert.resolvedAt = null;
      alert.resolvedBy = null;
    } else {
      alert.status = "resolved";
      alert.resolvedAt = new Date().toISOString();
      alert.resolvedBy = { userId: uid, name: nm };
    }

    (async () => {
      try {
        if (supabaseEnabled()) await dbToggleSosResolved(alert.id, { userId, name });
      } catch {
        // Non-fatal for demo
      }
    })();

    io.emit("sos_update", { sos: alert });
    if (typeof ack === "function") ack({ ok: true, sos: alert });
  });

  socket.on("threat_report", (payload) => {
    const { userId, name, label, severity, location, confidence, source, amplitude, baseline } = payload || {};
    const threat = {
      id: state.makeId(),
      type: "threat",
      userId: String(userId || "").trim() || null,
      name: String(name || "Unknown Survivor").slice(0, 60),
      label: String(label || "Threat").slice(0, 120),
      severity: ["low", "medium", "high"].includes(severity) ? severity : "medium",
      confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : undefined,
      source: source ? String(source).slice(0, 40) : undefined,
      amplitude: Number.isFinite(Number(amplitude)) ? Number(amplitude) : undefined,
      baseline: Number.isFinite(Number(baseline)) ? Number(baseline) : undefined,
      location: location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))
        ? { lat: Number(location.lat), lng: Number(location.lng) }
        : null,
      createdAt: new Date().toISOString()
    };

    state.threats.push(threat);
    (async () => {
      try {
        if (supabaseEnabled()) await dbInsertThreat(threat);
      } catch {
        // Non-fatal for demo
      }
    })();
    io.emit("threat_report", threat);
  });

  socket.on("zone_marker_add", (payload, ack) => {
    try {
      const marker = createZoneMarker(payload);
      state.zoneMarkers.push(marker);
      (async () => {
        try {
          if (supabaseEnabled()) await dbInsertZoneMarker(marker);
        } catch {
          // Non-fatal for demo
        }
      })();
      io.emit("zone_marker_add", marker);
      if (typeof ack === "function") ack({ ok: true, zoneMarker: marker });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: e.message || "Bad Request" });
    }
  });

  socket.on("checkin", (payload, ack) => {
    try {
      const user = checkIn(state, payload);
      io.emit("checkin_update", { user });
      io.emit("danger_zones_update", { dangerZones: dangerZones(state) });
      if (typeof ack === "function") ack({ ok: true, user });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: e.message || "Bad Request" });
    }
  });
});

setInterval(() => {
  sweepForBrokenStreaks(state);
  io.emit("danger_zones_update", { dangerZones: dangerZones(state) });
}, 30_000);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});
