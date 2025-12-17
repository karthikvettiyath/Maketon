import http from "http";
import express from "express";
import cors from "cors";
import { Server as SocketIOServer } from "socket.io";

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
  res.json({ ok: true, name: "Upside-Down Survivor Network", time: new Date().toISOString() });
});

app.get("/api/zones", (req, res) => {
  res.json({ zones: state.zones });
});

app.get("/api/camps", (req, res) => {
  res.json({ camps: state.camps });
});

app.get("/api/sos", (req, res) => {
  res.json({ sos: state.sosAlerts.slice(-200).reverse() });
});

app.get("/api/threats", (req, res) => {
  res.json({ threats: state.threats.slice(-200).reverse() });
});

app.get("/api/danger-zones", (req, res) => {
  res.json({ dangerZones: dangerZones(state) });
});

app.get("/api/map", (req, res) => {
  res.json({
    camps: state.camps,
    dangerZones: dangerZones(state),
    threats: state.threats.slice(-200).reverse()
  });
});

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
  const { userId, name, message, location } = req.body || {};
  const alert = {
    id: state.makeId(),
    type: "sos",
    userId: String(userId || "").trim() || null,
    name: String(name || "Unknown Survivor").slice(0, 60),
    message: String(message || "").slice(0, 400),
    location: location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))
      ? { lat: Number(location.lat), lng: Number(location.lng) }
      : null,
    createdAt: new Date().toISOString()
  };

  state.sosAlerts.push(alert);
  io.emit("sos_alert", alert);
  res.json({ sos: alert });
});

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

  socket.on("disconnect", () => {
    for (const z of socket.data.joinedZones || []) {
      removePresence(z, socket);
      io.to(`zone:${z}`).emit("zone_presence", presenceSnapshot(z));
    }
  });

  socket.on("sos_alert", (payload) => {
    const { userId, name, message, location } = payload || {};
    const alert = {
      id: state.makeId(),
      type: "sos",
      userId: String(userId || "").trim() || null,
      name: String(name || "Unknown Survivor").slice(0, 60),
      message: String(message || "").slice(0, 400),
      location: location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))
        ? { lat: Number(location.lat), lng: Number(location.lng) }
        : null,
      createdAt: new Date().toISOString()
    };

    state.sosAlerts.push(alert);
    io.emit("sos_alert", alert);
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
    io.emit("threat_report", threat);
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
