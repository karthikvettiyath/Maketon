import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { Intel } from "./Intel";
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  Circle,
  CircleMarker,
  Tooltip,
  useMap,
  useMapEvents
} from "react-leaflet";
import L from "leaflet";

import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

import "./App.css";

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow
});

const SERVER_ORIGIN = import.meta.env.VITE_SERVER_ORIGIN || "http://localhost:61234";

const MAX_HEART_RATE = 140;

function safeParseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatTime(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

function useIdentity() {
  const [identity, setIdentity] = useState(() => {
    const raw = localStorage.getItem("udsn.identity");
    const existing = safeParseJson(raw, null);
    if (existing?.userId) return existing;
    return {
      userId: crypto.randomUUID(),
      name: "Anonymous Survivor"
    };
  });

  useEffect(() => {
    localStorage.setItem("udsn.identity", JSON.stringify(identity));
  }, [identity]);

  return [identity, setIdentity];
}

async function getCurrentLocation({ timeoutMs = 6000 } = {}) {
  if (!navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs }
    );
  });
}

function TabButton({ active, onClick, children, badge }) {
  return (
    <button className={active ? "tab tabActive" : "tab"} onClick={onClick}>
      {children}
      {badge ? <span className="tabBadge">{badge}</span> : null}
    </button>
  );
}

function Badge({ tone, children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function MapController({ focus }) {
  const map = useMap();
  useEffect(() => {
    if (focus?.center) {
      map.flyTo(focus.center, focus.zoom || 14, { duration: 1.5 });
    }
  }, [focus, map]);
  return null;
}

function MapZoneMarkerPlacer({ enabled, onPick }) {
  useMapEvents({
    click(e) {
      if (!enabled) return;
      const lat = e?.latlng?.lat;
      const lng = e?.latlng?.lng;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      onPick?.({ lat, lng });
    }
  });
  return null;
}

function HawkinsProtocol({
  identity,
  mode,
  setMode,
  autoReportThreat
}) {
  const [heartRate, setHeartRate] = useState(92);
  const [stressStatus, setStressStatus] = useState("STABLE");
  const [strobe, setStrobe] = useState(false);
  const [totemEnabled, setTotemEnabled] = useState(true);
  const [totemFileName, setTotemFileName] = useState(null);

  const [micStatus, setMicStatus] = useState("OFF");
  const [envStatus, setEnvStatus] = useState("CLEAR");
  const [amplitude, setAmplitude] = useState(0);
  const [baseline, setBaseline] = useState(0);
  const [micError, setMicError] = useState(null);

  const audioRef = useRef(null);
  const audioUrlRef = useRef(null);
  const vibCooldownRef = useRef(0);

  const baselineRef = useRef(0);
  const envStatusRef = useRef("CLEAR");
  const spikeWindowRef = useRef([]);
  const autoReportCooldownRef = useRef(0);

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const micIntervalRef = useRef(null);

  const [audioLogs, setAudioLogs] = useState([]);

  function stopTotem() {
    const a = audioRef.current;
    if (!a) return;
    try {
      a.pause();
      a.currentTime = 0;
    } catch {
      // ignore
    }
  }

  function startTotem() {
    const a = audioRef.current;
    if (!a) return;
    a.volume = 1;
    try {
      // Note: browsers may block autoplay until a user gesture.
      a.play();
    } catch {
      // ignore
    }
  }

  function cleanupAudioUrl() {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  function onPickTotemFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    cleanupAudioUrl();
    const url = URL.createObjectURL(file);
    audioUrlRef.current = url;
    if (audioRef.current) {
      audioRef.current.src = url;
    }
    setTotemFileName(file.name);
  }

  function stopMic() {
    if (micIntervalRef.current) {
      clearInterval(micIntervalRef.current);
      micIntervalRef.current = null;
    }
    if (mediaStreamRef.current) {
      for (const t of mediaStreamRef.current.getTracks()) t.stop();
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => { });
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    setMicStatus("OFF");
    baselineRef.current = 0;
    envStatusRef.current = "CLEAR";
    spikeWindowRef.current = [];
  }

  async function startMic() {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
      mediaStreamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = audioCtx;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      analyserRef.current = analyser;

      const src = audioCtx.createMediaStreamSource(stream);
      src.connect(analyser);

      const buf = new Uint8Array(analyser.fftSize);
      setMicStatus("LISTENING");

      if (micIntervalRef.current) clearInterval(micIntervalRef.current);
      micIntervalRef.current = setInterval(() => {
        const a = analyserRef.current;
        if (!a) return;
        a.getByteTimeDomainData(buf);

        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        const amp = Math.round(rms * 32768);

        // "Silence" algorithm: track an ambient baseline and look for sudden spikes.
        // Use the *previous* baseline for spike detection so spikes don't self-cancel.
        const prevBase = baselineRef.current || amp;
        const dangerThreshold = 500;
        const spike = amp > Math.max(dangerThreshold, prevBase * 2.6);

        // Update baseline slowly during spikes so it doesn't learn the spike.
        const alpha = spike ? 0.02 : 0.08;
        baselineRef.current = prevBase ? prevBase * (1 - alpha) + amp * alpha : amp;

        const nextEnv = spike ? "RUN" : "CLEAR";
        const prevEnv = envStatusRef.current;
        envStatusRef.current = nextEnv;

        setAmplitude(amp);
        setBaseline(baselineRef.current);
        setEnvStatus(nextEnv);

        if (spike) {
          const now = Date.now();
          // Build a confidence score from magnitude + repeated spikes in a short window.
          const threshold = Math.max(dangerThreshold, prevBase * 2.6);
          const magnitude = Math.max(0, amp - threshold);
          const raw = threshold ? magnitude / threshold : 0;
          const baseConfidence = clamp(raw, 0, 1);

          const windowMs = 10_000;
          spikeWindowRef.current = spikeWindowRef.current
            .filter((t) => now - t < windowMs)
            .concat(now);

          const repeats = spikeWindowRef.current.length;
          const confidence = clamp(baseConfidence + Math.min(0.45, (repeats - 1) * 0.15), 0, 1);

          // Auto-broadcast: only on edge transition CLEAR -> RUN, with a cooldown.
          if (prevEnv !== "RUN" && now - autoReportCooldownRef.current > 3500) {
            autoReportCooldownRef.current = now;
            autoReportThreat?.({
              userId: identity?.userId,
              name: identity?.name,
              confidence,
              amplitude: amp,
              baseline: prevBase
            });
          }

          // Repeating silent alarm behavior (best-effort on web): fire heartbeat vibration.
          if (now - vibCooldownRef.current > 900) {
            vibCooldownRef.current = now;
            if (navigator.vibrate) navigator.vibrate([0, 200, 100, 200]);
          }

          // Add local log entry for audio detection
          if (now - vibCooldownRef.current > 2000) { // throttle logs slightly independent of vibe
            setAudioLogs(prev => [{
              id: now,
              time: new Date().toLocaleTimeString(),
              message: "Demogorgon spotted!"
            }, ...prev].slice(0, 50));
          }
        }
      }, 100);
    } catch (e) {
      setMicStatus("ERROR");
      setMicError(e?.message || "Microphone unavailable");
      stopMic();
    }
  }

  function toggleMode() {
    setMode((prev) => {
      const next = prev === "running" ? "hiding" : "running";
      if (next === "hiding") {
        // Panic Switch to stealth: kill audio immediately, then arm mic.
        stopTotem();
        startMic();
      } else {
        // Return to running: disarm mic and reset sentry readouts.
        stopMic();
        setEnvStatus("CLEAR");
        setAmplitude(0);
        setBaseline(0);
      }
      return next;
    });
  }

  function updateHeartRateFromGesture(next) {
    const nextHr = clamp(Number(next), 60, 200);
    setHeartRate(nextHr);
    if (mode === "running" && totemEnabled && nextHr > MAX_HEART_RATE) {
      startTotem();
    }
  }

  // Core survival loop for the demo (threshold logic).
  useEffect(() => {
    const stressed = heartRate > MAX_HEART_RATE;
    setStressStatus(stressed ? "POSSESSION DETECTED" : "STABLE");

    if (mode !== "running") {
      setStrobe(false);
      return;
    }
    if (!totemEnabled) {
      setStrobe(false);
      return;
    }

    setStrobe(stressed);
  }, [heartRate, mode, totemEnabled]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stopMic();
      stopTotem();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      cleanupAudioUrl();
    };
  }, []);

  const isHiding = mode === "hiding";

  return (
    <section className={isHiding ? "panel hawkins hawkinsHiding" : "panel hawkins"}>
      {strobe ? <div className="strobe" aria-hidden="true" /> : null}

      <div className="panelHeader">
        <div className="panelTitle">H.A.W.K.I.N.S. Protocol</div>
        <div className="panelHint">
          Heuristic Analysis for Warning, Kinetic defense, and Intelligent Navigation Systems — two threat modes, one Panic Switch.
        </div>
      </div>

      <div className="hawkinsTop">
        <div className="half halfRed">
          <div className="halfTitle">Psychic Defense (Anti-Vecna)</div>
          <div className="halfHint">Monitors stress/heart rate. If it spikes, triggers your Totem Audio + red strobe.</div>

          <div className="row">
            <label className="label" style={{ flex: 1 }}>
              Simulated Heart Rate: <span className="mono">{heartRate} bpm</span>
              <input
                className="range"
                type="range"
                min={60}
                max={200}
                value={heartRate}
                onChange={(e) => updateHeartRateFromGesture(e.target.value)}
                disabled={isHiding}
              />
            </label>
            <div style={{ width: 220 }}>
              {stressStatus === "POSSESSION DETECTED" ? (
                <Badge tone="bad">{stressStatus}</Badge>
              ) : (
                <Badge tone="good">{stressStatus}</Badge>
              )}
              <div className="meta">Threshold: {MAX_HEART_RATE} bpm</div>
            </div>
          </div>

          <div className="row">
            <label className="label" style={{ flex: 1 }}>
              Totem Audio (demo-safe)
              <input className="file" type="file" accept="audio/*" onChange={onPickTotemFile} disabled={isHiding} />
              <div className="meta">
                {totemFileName
                  ? `Loaded: ${totemFileName}`
                  : "Load an audio file you have rights to (browsers can’t bundle copyrighted tracks)."}
              </div>
            </label>
            <label className="label" style={{ width: 220 }}>
              Totem Trigger
              <select
                className="select"
                value={totemEnabled ? "on" : "off"}
                onChange={(e) => {
                  const nextEnabled = e.target.value === "on";
                  setTotemEnabled(nextEnabled);
                  // Try to start audio on a user gesture if we are already above threshold.
                  if (!isHiding && nextEnabled && heartRate > MAX_HEART_RATE) startTotem();
                  if (!nextEnabled) stopTotem();
                }}
                disabled={isHiding}
              >
                <option value="on">Enabled</option>
                <option value="off">Disabled</option>
              </select>
            </label>
          </div>

          <audio ref={audioRef} preload="auto" />
        </div>

        <div className="panic">
          <button className={isHiding ? "panicButton panicButtonHiding" : "panicButton"} onClick={toggleMode}>
            {isHiding ? "PANIC SWITCH: HIDING" : "PANIC SWITCH: RUNNING"}
          </button>
          <div className="meta">
            {isHiding
              ? "Stealth Mode: audio killed • screen dim • mic sensitivity up"
              : "Running Mode: totem audio allowed • Vecna defense armed"}
          </div>
        </div>

        <div className="half halfBlue">
          <div className="halfTitle">Physical Defense (Anti-Demogorgon)</div>
          <div className="halfHint">Listens for sudden sound spikes. Silent alarm: RUN + vibration (no audio).</div>

          <div className="row">
            <div style={{ flex: 1 }}>
              {envStatus === "RUN" ? <Badge tone="bad">RUN</Badge> : <Badge tone="good">CLEAR</Badge>}
              <div className="meta">Mic: {micStatus}{micError ? ` — ${micError}` : ""}</div>
            </div>
            <div style={{ width: 220 }}>
              <div className="meta">Amplitude: {amplitude}</div>
              <div className="meta">Baseline: {Math.round(baseline || 0)}</div>
              <div className="meta">Danger threshold: 8000 + spike filter</div>
            </div>
          </div>

          <div className="row">
            {micStatus === "LISTENING" ? (
              <button
                className="button"
                onClick={() => {
                  stopMic();
                  setEnvStatus("CLEAR");
                  setAmplitude(0);
                  setBaseline(0);
                }}
              >
                Disarm Stealth Radar
              </button>
            ) : (
              <button className="button" onClick={() => startMic()} disabled={!isHiding}>
                Arm Stealth Radar (Mic)
              </button>
            )}
            <div className="meta">Mic only runs in HIDING mode.</div>
          </div>

          <div className="meta">
            Tip: switch to HIDING, then clap near the mic to simulate a growl spike.
          </div>
        </div>

      </div>

      <div className="audioLogPanel">
        <div className="panelHeader" style={{ marginTop: 20 }}>
          <div className="panelTitle">Audio Detection Log</div>
        </div>
        <div className="log">
          {(audioLogs || []).length === 0 ? (
            <div className="empty">No detections yet. Silence is golden.</div>
          ) : (
            audioLogs.map((log) => (
              <div key={log.id} className="logItem logItemDetect">
                <div className="logTop">
                  <span className="logName" style={{ color: "var(--c-danger)" }}>
                    ⚠️ {log.message}
                  </span>
                  <span className="logTime">{log.time}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const [identity, setIdentity] = useIdentity();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef(null);

  const [activeTab, setActiveTab] = useState("chat");
  const [hawkinsMode, setHawkinsMode] = useState("running");

  const activeTabRef = useRef(activeTab);
  const hawkinsModeRef = useRef(hawkinsMode);

  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { hawkinsModeRef.current = hawkinsMode; }, [hawkinsMode]);

  const [zones, setZones] = useState([]);
  const [camps, setCamps] = useState([]);

  const [zoneId, setZoneId] = useState("castle-byers");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatKind, setChatKind] = useState("info");
  const [zonePresence, setZonePresence] = useState({ zoneId: null, users: [], count: 0 });
  const [typingNames, setTypingNames] = useState([]);
  const [zonePinned, setZonePinned] = useState(null);
  const [reactionCounts, setReactionCounts] = useState({});
  const [myReactions, setMyReactions] = useState({});
  const typingTimersRef = useRef(new Map());
  const typingDebounceRef = useRef(null);
  const chatLogRef = useRef(null);

  const [sosInput, setSosInput] = useState("");
  const [sosAlerts, setSosAlerts] = useState([]);
  const [sosSeverity, setSosSeverity] = useState("high");
  const [sosCategory, setSosCategory] = useState("general");
  const [sosAttachGps, setSosAttachGps] = useState(true);
  const [sosOnlyOpen, setSosOnlyOpen] = useState(true);
  const [sosCategoryFilter, setSosCategoryFilter] = useState("all");
  const [sosSound, setSosSound] = useState(false);
  const sosSoundRef = useRef(false);
  const sosAudioCtxRef = useRef(null);

  const [threatLabel, setThreatLabel] = useState("");
  const [threatSeverity, setThreatSeverity] = useState("medium");
  const [threats, setThreats] = useState([]);

  const [dangerZones, setDangerZones] = useState([]);
  const [zoneMarkers, setZoneMarkers] = useState([]);
  const [markMode, setMarkMode] = useState(false);
  const [markKind, setMarkKind] = useState("rally");
  const [markRadiusM, setMarkRadiusM] = useState(250);
  const [markLabel, setMarkLabel] = useState("");
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const [unreadCount, setUnreadCount] = useState(0);
  const [mapFocus, setMapFocus] = useState(null);

  const stealthLock = hawkinsMode === "hiding";

  function locateOnMap(loc, zoom = 14) {
    if (!loc?.lat || !loc?.lng) return;
    setActiveTab("map");
    setMapFocus({ center: [loc.lat, loc.lng], zoom });
  }

  const [checkinNote, setCheckinNote] = useState("");
  const [checkinAttachGps, setCheckinAttachGps] = useState(true);

  const mapCenter = useMemo(() => {
    const firstCamp = camps?.[0]?.location;
    return firstCamp?.lat ? [firstCamp.lat, firstCamp.lng] : [40.134, -85.668];
  }, [camps]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [{ sos }, { threats: t }, { camps: campList }, { dangerZones: dz }, { zoneMarkers: zm }] =
          await Promise.all([
            apiGet("/api/sos"),
            apiGet("/api/threats"),
            apiGet("/api/camps"),
            apiGet("/api/danger-zones"),
            apiGet("/api/zone-markers")
          ]);
        if (cancelled) return;
        setSosAlerts(sos);
        setThreats(t);
        setCamps(campList);
        setDangerZones(dz);
        setZoneMarkers((zm || []).slice(0, 200));
      } catch (e) {
        if (!cancelled) setStatusLine(e.message || "Failed to load initial data");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { user } = await apiGet(`/api/users/${identity.userId}`);
        if (!cancelled) setMe(user);
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [identity.userId]);

  const zoneIdRef = useRef(zoneId);
  useEffect(() => { zoneIdRef.current = zoneId; }, [zoneId]);

  useEffect(() => {
    const socket = io(SERVER_ORIGIN, {
      transports: ["websocket"],
      timeout: 8000
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      // Re-join logic is handled by the dedicated useEffect below.
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("hello", (payload) => {
      setZones(payload?.zones || []);
      setCamps(payload?.camps || []);
    });

    socket.on("zone_history", ({ zoneId: z, messages }) => {
      if (z !== zoneIdRef.current) return;
      setChatMessages(messages || []);
    });

    socket.on("zone_presence", (snapshot) => {
      if (snapshot?.zoneId !== zoneIdRef.current) return;
      setZonePresence(snapshot);
    });

    socket.on("zone_pinned_update", ({ zoneId: z, pinned }) => {
      if (z !== zoneIdRef.current) return;
      setZonePinned(pinned || null);
    });

    socket.on("message_reaction_update", ({ zoneId: z, messageId, confirmCount, disputeCount }) => {
      if (z !== zoneIdRef.current) return;
      if (!messageId) return;
      setReactionCounts((prev) => ({
        ...prev,
        [messageId]: {
          confirm: Number.isFinite(confirmCount) ? confirmCount : (prev?.[messageId]?.confirm ?? 0),
          dispute: Number.isFinite(disputeCount) ? disputeCount : (prev?.[messageId]?.dispute ?? 0)
        }
      }));
    });

    socket.on("typing", ({ zoneId: z, userId, name, isTyping }) => {
      if (z !== zoneIdRef.current) return;
      if (!userId || userId === identity.userId) return;

      const key = String(userId);
      const timers = typingTimersRef.current;

      if (isTyping) {
        if (timers.has(key)) clearTimeout(timers.get(key));
        timers.set(
          key,
          setTimeout(() => {
            timers.delete(key);
            setTypingNames((prev) => prev.filter((n) => n.key !== key));
          }, 1400)
        );

        setTypingNames((prev) => {
          const exists = prev.some((n) => n.key === key);
          if (exists) return prev;
          return [...prev, { key, name: name || "Survivor" }].slice(-3);
        });
      } else {
        if (timers.has(key)) {
          clearTimeout(timers.get(key));
          timers.delete(key);
        }
        setTypingNames((prev) => prev.filter((n) => n.key !== key));
      }
    });

    socket.on("chat_message", (msg) => {
      if (msg?.zoneId !== zoneIdRef.current) return;
      setChatMessages((prev) => {
        const next = [...prev, msg];
        return next.slice(-120);
      });

      if (activeTabRef.current !== "chat") {
        setUnreadCount((prev) => prev + 1);
      }
    });

    socket.on("sos_alert", (alert) => {
      setSosAlerts((prev) => [alert, ...prev].slice(0, 200));

      if (sosSoundRef.current) {
        try {
          const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextCtor) return;
          if (!sosAudioCtxRef.current) sosAudioCtxRef.current = new AudioContextCtor();
          const ctx = sosAudioCtxRef.current;
          ctx.resume?.().catch(() => { });
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "square";
          osc.frequency.value = 880;
          gain.gain.value = 0.0001;
          osc.connect(gain);
          gain.connect(ctx.destination);
          const now = ctx.currentTime;
          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
          osc.start(now);
          osc.stop(now + 0.16);
        } catch {
          // ignore
        }
      }
    });

    socket.on("sos_update", ({ sos }) => {
      if (!sos?.id) return;
      setSosAlerts((prev) => {
        const idx = prev.findIndex((x) => x?.id === sos.id);
        if (idx === -1) return [sos, ...prev].slice(0, 200);
        const next = [...prev];
        next[idx] = sos;
        return next;
      });
    });

    socket.on("threat_report", (t) => {
      setThreats((prev) => [t, ...prev].slice(0, 200));
    });

    socket.on("zone_marker_add", (m) => {
      if (!m?.id) return;
      setZoneMarkers((prev) => {
        if (prev.some((x) => x?.id === m.id)) return prev;
        return [m, ...prev].slice(0, 200);
      });
    });

    socket.on("danger_zones_update", ({ dangerZones: dz }) => {
      setDangerZones(dz || []);
    });

    socket.on("checkin_update", ({ user }) => {
      if (user?.id === identity.userId) setMe(user);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [identity.userId]);

  useEffect(() => {
    sosSoundRef.current = sosSound;
  }, [sosSound]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !connected) return;
    socket.emit("join_zone", { zoneId, userId: identity.userId, name: identity.name });
    return () => socket.emit("leave_zone", { zoneId });
  }, [zoneId, identity.userId, identity.name, connected]);

  useEffect(() => {
    // reset per-zone UI state
    setChatMessages([]);
    setTypingNames([]);
    setZonePresence({ zoneId, users: [], count: 0 });
    setZonePinned(null);
    setReactionCounts({});
    setMyReactions({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneId]);

  useEffect(() => {
    if (activeTab === "chat") {
      setUnreadCount(0);
    }
  }, [activeTab]);

  useEffect(() => {
    // auto-scroll chat log
    const el = chatLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages.length]);

  const connectionTone = connected ? "good" : "bad";

  const trustByUser = useMemo(() => {
    const trust = {};
    for (const m of chatMessages) {
      if (!m?.userId) continue;
      const counts = reactionCounts?.[m.id];
      if (!counts) continue;
      const delta = (counts.confirm || 0) - (counts.dispute || 0);
      if (!delta) continue;
      trust[m.userId] = (trust[m.userId] || 0) + delta;
    }
    return trust;
  }, [chatMessages, reactionCounts]);

  const zoneSummary = useMemo(() => {
    const recent = (chatMessages || []).slice(-60);
    const counts = { info: 0, threat: 0, resource: 0, route: 0 };
    const last = { threat: null, resource: null, route: null };
    const seenNames = new Set();

    for (const m of recent) {
      const k = m?.kind || "info";
      if (counts[k] !== undefined) counts[k] += 1;
      if (m?.name) seenNames.add(m.name);
      if ((k === "threat" || k === "resource" || k === "route") && !last[k]) last[k] = m;
    }

    return {
      counts,
      last,
      activeNames: Array.from(seenNames).slice(0, 6),
      total: recent.length
    };
  }, [chatMessages]);

  function pinMessage(messageId) {
    if (stealthLock) {
      setStatusLine("STEALTH MODE: transmissions muted.");
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit(
      "pin_message",
      { zoneId, messageId, userId: identity.userId, name: identity.name },
      (res) => {
        if (!res?.ok) setStatusLine(res?.error || "Failed to pin message");
        else setZonePinned(res.pinned || null);
      }
    );
  }

  function unpinZone() {
    if (stealthLock) {
      setStatusLine("STEALTH MODE: transmissions muted.");
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit("unpin_message", { zoneId }, (res) => {
      if (!res?.ok) setStatusLine(res?.error || "Failed to unpin");
      else setZonePinned(null);
    });
  }

  function reactToMessage(messageId, reaction) {
    if (stealthLock) {
      setStatusLine("STEALTH MODE: transmissions muted.");
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit(
      "react_message",
      { zoneId, messageId, userId: identity.userId, reaction },
      (res) => {
        if (!res?.ok) {
          setStatusLine(res?.error || "Failed to react");
          return;
        }
        setMyReactions((prev) => ({
          ...prev,
          [messageId]: res?.my?.dispute ? "dispute" : res?.my?.confirm ? "confirm" : null
        }));
        if (typeof res.confirmCount === "number" || typeof res.disputeCount === "number") {
          setReactionCounts((prev) => ({
            ...prev,
            [messageId]: {
              confirm: typeof res.confirmCount === "number" ? res.confirmCount : (prev?.[messageId]?.confirm ?? 0),
              dispute: typeof res.disputeCount === "number" ? res.disputeCount : (prev?.[messageId]?.dispute ?? 0)
            }
          }));
        }
      }
    );
  }

  async function sendChat() {
    if (stealthLock) {
      setStatusLine("STEALTH MODE: transmissions muted.");
      return;
    }
    const text = chatInput.trim();
    if (!text) return;
    setChatInput("");
    const kind = chatKind;
    socketRef.current?.emit("chat_message", {
      zoneId,
      userId: identity.userId,
      name: identity.name,
      text,
      kind
    });

    // stop typing indicator for self
    socketRef.current?.emit("typing", { zoneId, userId: identity.userId, name: identity.name, isTyping: false });
  }

  function emitTyping(isTyping) {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit("typing", { zoneId, userId: identity.userId, name: identity.name, isTyping });
  }

  function onChatInputChange(value) {
    setChatInput(value);
    if (stealthLock) return;

    emitTyping(true);
    if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
    typingDebounceRef.current = setTimeout(() => {
      emitTyping(false);
    }, 900);
  }

  async function shareMyLocationToZone() {
    if (stealthLock) {
      setStatusLine("STEALTH MODE: transmissions muted.");
      return;
    }
    try {
      const loc = await getCurrentLocation();
      if (!loc) {
        setStatusLine("Location unavailable (permission denied or unsupported).");
        return;
      }
      setChatKind("route");
      setChatInput(`GPS: ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`);
    } catch {
      setStatusLine("Location unavailable.");
    }
  }

  function startMapFocus(lat, lng) {
    setActiveTab("map");
    setMapFocus({ center: [lat, lng], zoom: 16, ts: Date.now() });
  }

  function applyTemplate({ kind, text }) {
    setChatKind(kind);
    setChatInput(text);
  }

  async function sendSos() {
    if (stealthLock) {
      setStatusLine("STEALTH MODE: SOS transmit muted (use silent sentry markers).");
      return;
    }
    const message = sosInput.trim();
    if (!message) return;
    setBusy(true);
    setStatusLine("");
    try {
      const location = sosAttachGps ? await getCurrentLocation() : null;
      const alert = {
        userId: identity.userId,
        name: identity.name,
        message,
        location,
        severity: sosSeverity,
        category: sosCategory,
        zoneId
      };
      socketRef.current?.emit("sos_alert", alert);
      setSosInput("");
    } catch (e) {
      setStatusLine(e.message || "Failed to send SOS");
    } finally {
      setBusy(false);
    }
  }

  function toggleSosSound() {
    setSosSound((prev) => {
      const next = !prev;
      if (next) {
        try {
          const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
          if (AudioContextCtor && !sosAudioCtxRef.current) sosAudioCtxRef.current = new AudioContextCtor();
          sosAudioCtxRef.current?.resume?.().catch(() => { });
        } catch {
          // ignore
        }
      }
      return next;
    });
  }

  function sosHasActor(list, userId) {
    const uid = String(userId || "").trim();
    if (!uid) return false;
    return Array.isArray(list) && list.some((x) => x?.userId === uid);
  }

  function sosCounts(list) {
    return Array.isArray(list) ? list.length : 0;
  }

  function emitSosAction(event, sosId) {
    if (stealthLock) {
      setStatusLine("STEALTH MODE: transmissions muted.");
      return;
    }
    if (!sosId) return;
    socketRef.current?.emit(event, { sosId, userId: identity.userId, name: identity.name });
  }

  function applySosTemplate({ category, severity, text }) {
    setSosCategory(category);
    setSosSeverity(severity);
    setSosInput(text);
  }

  const filteredSosAlerts = useMemo(() => {
    const list = sosAlerts || [];
    return list.filter((a) => {
      const status = a?.status || (a?.resolvedAt ? "resolved" : "open");
      if (sosOnlyOpen && status !== "open") return false;
      if (sosCategoryFilter !== "all" && String(a?.category || "general") !== sosCategoryFilter) return false;
      return true;
    });
  }, [sosAlerts, sosOnlyOpen, sosCategoryFilter]);

  async function reportThreat() {
    if (stealthLock) {
      setStatusLine("STEALTH MODE: threat markers muted (use silent sentry markers).");
      return;
    }
    const label = threatLabel.trim();
    if (!label) return;
    setBusy(true);
    setStatusLine("");
    try {
      const location = await getCurrentLocation();
      const payload = {
        userId: identity.userId,
        name: identity.name,
        label,
        severity: threatSeverity,
        confidence: 1,
        source: "manual",
        location
      };

      if (socketRef.current?.connected) {
        socketRef.current.emit("threat_report", payload);
      } else {
        await apiPost("/api/threats", payload);
      }
      setThreatLabel("");
    } catch (e) {
      setStatusLine(e.message || "Failed to report threat");
    } finally {
      setBusy(false);
    }
  }

  async function addZoneMarker(location) {
    if (stealthLock) {
      setStatusLine("STEALTH MODE: transmissions muted.");
      return;
    }
    if (!Number.isFinite(Number(location?.lat)) || !Number.isFinite(Number(location?.lng))) return;

    const payload = {
      userId: identity.userId,
      name: identity.name,
      kind: markKind,
      radiusM: markRadiusM,
      label: markLabel.trim(),
      location
    };

    setBusy(true);
    setStatusLine("");
    try {
      if (socketRef.current?.connected) {
        socketRef.current.emit("zone_marker_add", payload, (ack) => {
          if (ack?.ok) {
            setStatusLine("Zone marker deployed.");
          } else {
            setStatusLine(ack?.error || "Failed to deploy marker");
          }
        });
      } else {
        const { zoneMarker } = await apiPost("/api/zone-markers", payload);
        if (zoneMarker?.id) {
          setZoneMarkers((prev) => [zoneMarker, ...prev].slice(0, 200));
        }
        setStatusLine("Zone marker deployed.");
      }
      setMarkMode(false);
      setMarkLabel("");
    } catch (e) {
      setStatusLine(e.message || "Failed to deploy marker");
    } finally {
      setBusy(false);
    }
  }

  async function markMyLocation() {
    if (stealthLock) {
      setStatusLine("STEALTH MODE: transmissions muted.");
      return;
    }
    try {
      const loc = await getCurrentLocation();
      if (!loc) {
        setStatusLine("Location unavailable (permission denied or unsupported).");
        return;
      }
      await addZoneMarker(loc);
    } catch {
      setStatusLine("Location unavailable.");
    }
  }

  const markerStyleByKind = useMemo(
    () => ({
      safe: { color: "#00f0ff", fillColor: "#00f0ff", fillOpacity: 0.12 },
      danger: { color: "#ff1f1f", fillColor: "#ff1f1f", fillOpacity: 0.12 },
      resource: { color: "#00f0ff", fillColor: "#00f0ff", fillOpacity: 0.08 },
      rally: { color: "#ffb800", fillColor: "#ffb800", fillOpacity: 0.10 },
      blocked: { color: "#8b9bb4", fillColor: "#8b9bb4", fillOpacity: 0.10 }
    }),
    []
  );

  async function autoReportThreat({
    label,
    severity = "medium",
    confidence,
    amplitude,
    baseline,
    source = "stealth-radar",
    location
  } = {}) {
    const safeLabel = String(label || "").trim();
    if (!safeLabel) return;

    const payload = {
      userId: identity.userId,
      name: identity.name,
      label: safeLabel,
      severity,
      confidence: typeof confidence === "number" ? confidence : undefined,
      amplitude: typeof amplitude === "number" ? amplitude : undefined,
      baseline: typeof baseline === "number" ? baseline : undefined,
      source,
      location
    };

    if (socketRef.current?.connected) {
      socketRef.current.emit("threat_report", payload);
      return;
    }

    // Fallback if socket is down.
    await apiPost("/api/threats", payload);
  }

  async function doCheckIn() {
    setBusy(true);
    setStatusLine("");
    try {
      const location = checkinAttachGps ? await getCurrentLocation() : null;
      const { user } = await apiPost("/api/checkin", {
        userId: identity.userId,
        name: identity.name,
        location,
        note: checkinNote
      });
      setMe(user);
      setStatusLine("Check-in confirmed. Stay loud, stay alive.");
      setCheckinNote("");
    } catch (e) {
      setStatusLine(e.message || "Check-in failed");
    } finally {
      setBusy(false);
    }
  }

  function applyCheckInTemplate(text) {
    setCheckinNote(text);
  }

  function nextUtcMidnightMs(from = new Date()) {
    const d = new Date(from);
    d.setUTCHours(24, 0, 0, 0);
    return d.getTime();
  }

  function formatCountdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  const checkinCountdown = useMemo(() => {
    const now = Date.now();
    return formatCountdown(nextUtcMidnightMs(new Date(now)) - now);
  }, [me?.lastCheckInAt]);

  const checkInHistory = useMemo(() => {
    const list = Array.isArray(me?.checkInHistory) ? me.checkInHistory : [];
    const byDay = new Map();
    for (const e of list) {
      if (e?.dayKey) byDay.set(e.dayKey, e);
    }

    // Build last 7 UTC day keys
    const days = [];
    const base = new Date();
    base.setUTCHours(0, 0, 0, 0);
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() - i);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const key = `${y}-${m}-${dd}`;
      days.push({ key, entry: byDay.get(key) || null, isToday: i === 0 });
    }
    return { days, recent: list.slice().reverse().slice(0, 8) };
  }, [me?.checkInHistory]);

  const statusBadge = me?.status === "missing" ? <Badge tone="bad">MISSING</Badge> : <Badge tone="good">SAFE</Badge>;

  return (
    <div className={stealthLock ? "app appStealth" : "app"}>
      <header className="header">
        <div className="titleBlock">
          <div className="title">Upside-Down Survivor Network</div>
          <div className="subtitle">
            Real-time zones • Global SOS • Relief Camp Map • Daily Streak Check-In
          </div>
        </div>
        <div className="headerRight">
          <div className="pillRow">
            <span className={`pill pill-${connectionTone}`}>{connected ? "Link: LIVE" : "Link: LOST"}</span>
            <span className="pill">{statusBadge}</span>
            <span className="pill">Streak: {me?.streak ?? 0}</span>
            <span className={stealthLock ? "pill pill-bad" : "pill pill-good"}>
              {stealthLock ? "Stealth: ON" : "Stealth: OFF"}
            </span>
          </div>
          <div className="identityRow">
            <label className="label">
              Callsign
              <input
                className="input"
                value={identity.name}
                onChange={(e) => setIdentity((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Your callsign"
                maxLength={60}
              />
            </label>
          </div>
        </div>
      </header>

      <nav className="tabs">
        <TabButton active={activeTab === "chat"} onClick={() => setActiveTab("chat")} badge={unreadCount > 0 ? unreadCount : null}>
          Zone Chat
        </TabButton>
        <TabButton active={activeTab === "sos"} onClick={() => setActiveTab("sos")}>
          Global SOS
        </TabButton>
        <TabButton active={activeTab === "map"} onClick={() => setActiveTab("map")}>
          Relief Camp Map
        </TabButton>
        <TabButton active={activeTab === "checkin"} onClick={() => setActiveTab("checkin")}>
          Daily Check-In
        </TabButton>
        <TabButton active={activeTab === "hawkins"} onClick={() => setActiveTab("hawkins")}>
          H.A.W.K.I.N.S. Protocol
        </TabButton>
        <TabButton active={activeTab === "intel"} onClick={() => setActiveTab("intel")}>
          CEREBRO AI
        </TabButton>
      </nav>

      {statusLine ? (
        <div className="statusLine">{statusLine}</div>
      ) : stealthLock ? (
        <div className="statusLine">STEALTH MODE ACTIVE — transmissions muted; silent sentry markers still broadcast.</div>
      ) : null}

      <main className="main">
        {activeTab === "chat" ? (
          <section className="panel tabPanel">
            <div className="panelHeader">
              <div className="panelTitle">Zone-Based Chat Rooms</div>
              <div className="panelHint">Coordinate fast. Keep messages short and actionable.</div>
            </div>

            <div className="chatHeaderRow">
              <label className="label" style={{ minWidth: 260 }}>
                Sector
                <select className="select" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                  {(zones.length ? zones : [{ id: "castle-byers", name: "Castle Byers" }]).map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="chatMetaRow">
                <span className="pill">Presence: {zonePresence?.count ?? 0}</span>
                <span className="pill">Mode: {stealthLock ? "HIDING" : "RUNNING"}</span>
              </div>
            </div>

            <div className="chatLayout">
              <div className="chatLeft">
                {zonePinned ? (
                  <div className="pinnedCard">
                    <div className="pinnedTop">
                      <div className="pinnedTitle">
                        <Badge tone={zonePinned.kind === "threat" ? "bad" : zonePinned.kind === "resource" ? "good" : zonePinned.kind === "route" ? "warn" : "mid"}>
                          PINNED
                        </Badge>
                        <span className="spacer" />
                        <span className="pinnedMeta">By {zonePinned?.from?.name || "Unknown"}</span>
                        <span className="spacer" />
                        <span className="pinnedMeta">Pinned by {zonePinned?.pinnedBy?.name || "Unknown"}</span>
                      </div>
                      <button className="msgAction" onClick={unpinZone} disabled={stealthLock}>
                        Unpin
                      </button>
                    </div>
                    <div className="pinnedBody">{zonePinned.text}</div>
                  </div>
                ) : null}

                <div className="log" ref={chatLogRef}>
                  {chatMessages.length === 0 ? (
                    <div className="empty">No chatter yet. Break the silence.</div>
                  ) : (
                    chatMessages.map((m) => {
                      const kind = m.kind || "info";
                      const tone = kind === "threat" ? "bad" : kind === "resource" ? "good" : kind === "route" ? "warn" : "mid";
                      const label = kind.toUpperCase();
                      const counts = reactionCounts?.[m.id] || { confirm: 0, dispute: 0 };
                      const mine = myReactions?.[m.id];
                      const trust = m.userId ? (trustByUser?.[m.userId] || 0) : 0;

                      // Simple parser for "GPS: lat, lng"
                      const parts = [];
                      let lastIndex = 0;
                      const re = /GPS:?\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)/g;
                      let match;
                      const text = m.text || "";

                      while ((match = re.exec(text)) !== null) {
                        if (match.index > lastIndex) parts.push(text.substring(lastIndex, match.index));
                        const lat = parseFloat(match[1]);
                        const lng = parseFloat(match[2]);
                        parts.push(
                          <button
                            key={match.index}
                            className="gpsLink"
                            onClick={() => startMapFocus(lat, lng)}
                          >
                            {match[0]}
                          </button>
                        );
                        lastIndex = re.lastIndex;
                      }
                      if (lastIndex < text.length) parts.push(text.substring(lastIndex));

                      return (
                        <div key={m.id} className={`logItem logItemChat logItem-${kind}`}>
                          <div className="logTop">
                            <div className="logTopLeft">
                              <span className="logName">{m.name}</span>
                              {trust ? (
                                <span className={trust > 0 ? "trust trustUp" : "trust trustDown"}>
                                  Trust {trust > 0 ? `+${trust}` : trust}
                                </span>
                              ) : null}
                            </div>
                            <div className="logTopRight">
                              <button
                                className={mine === "confirm" ? "msgAction msgActionOn" : "msgAction"}
                                onClick={() => reactToMessage(m.id, "confirm")}
                                disabled={stealthLock || !connected}
                                title="Confirm this report"
                              >
                                ✓ {counts.confirm || 0}
                              </button>
                              <button
                                className={mine === "dispute" ? "msgAction msgActionOn" : "msgAction"}
                                onClick={() => reactToMessage(m.id, "dispute")}
                                disabled={stealthLock || !connected}
                                title="Dispute this report"
                              >
                                ✕ {counts.dispute || 0}
                              </button>
                              <button
                                className="msgAction"
                                onClick={() => pinMessage(m.id)}
                                disabled={stealthLock || !connected}
                                title="Pin as commander broadcast"
                              >
                                Pin
                              </button>
                              <span className="logTime">{formatTime(m.createdAt)}</span>
                            </div>
                          </div>
                          <div className="logText">
                            <Badge tone={tone}>{label}</Badge>
                            <span className="spacer" />
                            {parts.length > 0 ? parts : text}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="typingLine">
                  {typingNames.length ? (
                    <div className="meta">
                      {typingNames.map((t) => t.name).join(", ")}{" "}
                      {typingNames.length === 1 ? "is" : "are"} typing...
                    </div>
                  ) : (
                    <div className="meta">&nbsp;</div>
                  )}
                </div>

                <div className="composer composerChat">
                  <label className="label" style={{ width: 180 }}>
                    Message Type
                    <select className="select" value={chatKind} onChange={(e) => setChatKind(e.target.value)} disabled={stealthLock}>
                      <option value="info">Info</option>
                      <option value="threat">Threat</option>
                      <option value="resource">Resource</option>
                      <option value="route">Route</option>
                    </select>
                  </label>
                  <input
                    className="input"
                    value={chatInput}
                    onChange={(e) => onChatInputChange(e.target.value)}
                    placeholder="Report threats, routes, resources…"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") sendChat();
                    }}
                    maxLength={600}
                    disabled={stealthLock}
                  />
                  <button className="button" onClick={sendChat} disabled={!connected || stealthLock}>
                    Transmit
                  </button>
                </div>
              </div>

              <aside className="chatRight">
                <div className="sideCard">
                  <div className="sideTitle">Zone Intel</div>
                  <div className="meta">ID: {zoneId}</div>
                  <div className="meta">Rule: keep comms short, actionable, and verifiable.</div>
                  <button className="button" onClick={shareMyLocationToZone} disabled={stealthLock}>
                    Prefill My GPS
                  </button>
                </div>

                <div className="sideCard">
                  <div className="sideTitle">Zone Summary</div>
                  <div className="meta">Last 60 messages: {zoneSummary.total}</div>
                  <div className="meta">Threats: {zoneSummary.counts.threat} • Resources: {zoneSummary.counts.resource} • Routes: {zoneSummary.counts.route}</div>
                  {zoneSummary.last.threat ? (
                    <div className="meta"><strong>Latest threat:</strong> {zoneSummary.last.threat.text}</div>
                  ) : null}
                  {zoneSummary.last.resource ? (
                    <div className="meta"><strong>Latest resource:</strong> {zoneSummary.last.resource.text}</div>
                  ) : null}
                  {zoneSummary.last.route ? (
                    <div className="meta"><strong>Latest route:</strong> {zoneSummary.last.route.text}</div>
                  ) : null}
                </div>

                <div className="sideCard">
                  <div className="sideTitle">Active Presence</div>
                  <div className="meta">Survivors in this sector: {zonePresence?.count ?? 0}</div>
                  <div className="presenceList">
                    {(zonePresence?.users || []).length === 0 ? (
                      <div className="empty">No live presence yet.</div>
                    ) : (
                      (zonePresence.users || []).slice(0, 12).map((u) => (
                        <div key={u.socketId} className="presenceItem">
                          <span className="presenceDot" />
                          <span className="presenceName">{u.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="sideCard">
                  <div className="sideTitle">Quick Templates</div>
                  <div className="chipRow">
                    <button
                      className="chip"
                      disabled={stealthLock}
                      onClick={() => applyTemplate({ kind: "threat", text: "THREAT: movement heard. Avoid main corridor." })}
                    >
                      Threat Spotted
                    </button>
                    <button
                      className="chip"
                      disabled={stealthLock}
                      onClick={() => applyTemplate({ kind: "resource", text: "RESOURCE: found water/food cache at" })}
                    >
                      Resource Cache
                    </button>
                    <button
                      className="chip"
                      disabled={stealthLock}
                      onClick={() => applyTemplate({ kind: "route", text: "ROUTE: safe path confirmed via" })}
                    >
                      Safe Route
                    </button>
                    <button
                      className="chip"
                      disabled={stealthLock}
                      onClick={() => applyTemplate({ kind: "info", text: "STATUS: regroup at" })}
                    >
                      Regroup
                    </button>
                  </div>
                  <div className="meta">Tip: pick a template, fill the blanks, hit Transmit.</div>
                </div>
              </aside>
            </div>
          </section>
        ) : null}

        {activeTab === "sos" ? (
          <section className="panel grid2 tabPanel">
            <div>
              <div className="panelHeader">
                <div className="panelTitle">Global SOS Alert Stream</div>
                <div className="panelHint">SOS broadcasts to everyone. GPS is attached when available.</div>
              </div>

              <div className="row sosControls">
                <label className="label" style={{ width: 180 }}>
                  Category
                  <select className="select" value={sosCategory} onChange={(e) => setSosCategory(e.target.value)} disabled={stealthLock}>
                    <option value="general">General</option>
                    <option value="medical">Medical</option>
                    <option value="evac">Evac</option>
                    <option value="supplies">Supplies</option>
                    <option value="threat">Threat</option>
                    <option value="lost">Lost</option>
                  </select>
                </label>
                <label className="label" style={{ width: 180 }}>
                  Severity
                  <select className="select" value={sosSeverity} onChange={(e) => setSosSeverity(e.target.value)} disabled={stealthLock}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </label>
                <label className="label" style={{ minWidth: 220, flex: 1 }}>
                  Sector (optional)
                  <select className="select" value={zoneId} onChange={(e) => setZoneId(e.target.value)} disabled={stealthLock}>
                    {(zones.length ? zones : [{ id: "castle-byers", name: "Castle Byers" }]).map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="sosMetaRow">
                <button
                  className={sosAttachGps ? "chip sosChipOn" : "chip"}
                  type="button"
                  onClick={() => setSosAttachGps((p) => !p)}
                  disabled={stealthLock}
                >
                  GPS: {sosAttachGps ? "ON" : "OFF"}
                </button>
                <button
                  className={sosOnlyOpen ? "chip sosChipOn" : "chip"}
                  type="button"
                  onClick={() => setSosOnlyOpen((p) => !p)}
                >
                  Show: {sosOnlyOpen ? "OPEN" : "ALL"}
                </button>
                <label className="label" style={{ width: 220, marginBottom: 0 }}>
                  Filter
                  <select className="select" value={sosCategoryFilter} onChange={(e) => setSosCategoryFilter(e.target.value)}>
                    <option value="all">All categories</option>
                    <option value="medical">Medical</option>
                    <option value="evac">Evac</option>
                    <option value="supplies">Supplies</option>
                    <option value="threat">Threat</option>
                    <option value="lost">Lost</option>
                    <option value="general">General</option>
                  </select>
                </label>
                <button className={sosSound ? "chip sosChipOn" : "chip"} type="button" onClick={toggleSosSound}>
                  Sound: {sosSound ? "ON" : "OFF"}
                </button>
              </div>

              <div className="chipRow" style={{ marginTop: 10 }}>
                <button className="chip" disabled={stealthLock} onClick={() => applySosTemplate({ category: "medical", severity: "critical", text: "MEDICAL: severe injury. Need aid at" })}>
                  Medical (Critical)
                </button>
                <button className="chip" disabled={stealthLock} onClick={() => applySosTemplate({ category: "evac", severity: "high", text: "EVAC: trapped. Need extraction at" })}>
                  Evac Needed
                </button>
                <button className="chip" disabled={stealthLock} onClick={() => applySosTemplate({ category: "supplies", severity: "medium", text: "SUPPLIES: need water/food/medical at" })}>
                  Supplies
                </button>
                <button className="chip" disabled={stealthLock} onClick={() => applySosTemplate({ category: "lost", severity: "high", text: "LOST: separated from group. Last seen near" })}>
                  Lost Survivor
                </button>
              </div>

              <div className="composer">
                <input
                  className="input"
                  value={sosInput}
                  onChange={(e) => setSosInput(e.target.value)}
                  placeholder="SOS: location, threat, injuries, supplies needed…"
                  maxLength={400}
                  disabled={stealthLock}
                />
                <button className="button buttonDanger" onClick={sendSos} disabled={!connected || busy || stealthLock}>
                  Send SOS
                </button>
              </div>

              <div className="log">
                {filteredSosAlerts.length === 0 ? (
                  <div className="empty">No SOS alerts yet.</div>
                ) : (
                  filteredSosAlerts.map((a) => (
                    <div key={a.id} className="logItem logItemSos">
                      <div className="logTop">
                        <span className="logName">{a.name}</span>
                        <span className="sosBadges">
                          <Badge tone={a.severity === "critical" || a.severity === "high" ? "bad" : a.severity === "medium" ? "warn" : "mid"}>
                            {String(a.severity || "high").toUpperCase()}
                          </Badge>
                          <Badge tone={a.category === "medical" ? "bad" : a.category === "supplies" ? "good" : a.category === "evac" ? "warn" : "mid"}>
                            {String(a.category || "general").toUpperCase()}
                          </Badge>
                          <Badge tone={(a.status || (a.resolvedAt ? "resolved" : "open")) === "resolved" ? "good" : "bad"}>
                            {(a.status || (a.resolvedAt ? "resolved" : "open")).toUpperCase()}
                          </Badge>
                          <span className="logTime">{formatTime(a.createdAt)}</span>
                        </span>
                      </div>
                      <div className="logText">{a.message}</div>
                      {a.zoneId ? <div className="meta">Sector: {a.zoneId}</div> : null}
                      {a.location ? (
                        <div className="meta">GPS: {a.location.lat.toFixed(5)}, {a.location.lng.toFixed(5)}</div>
                      ) : (
                        <div className="meta">GPS: unavailable</div>
                      )}

                      <div className="sosActionRow">
                        <button
                          className={sosHasActor(a.acknowledgements, identity.userId) ? "msgAction msgActionOn" : "msgAction"}
                          onClick={() => emitSosAction("sos_ack", a.id)}
                          disabled={stealthLock}
                        >
                          ✓ Acknowledge ({sosCounts(a.acknowledgements)})
                        </button>
                        <button
                          className={sosHasActor(a.responders, identity.userId) ? "msgAction msgActionOn" : "msgAction"}
                          onClick={() => emitSosAction("sos_take", a.id)}
                          disabled={stealthLock}
                        >
                          → Responding ({sosCounts(a.responders)})
                        </button>
                        <button
                          className={(a.status || (a.resolvedAt ? "resolved" : "open")) === "resolved" ? "msgAction" : "msgAction msgActionDanger"}
                          onClick={() => emitSosAction("sos_resolve", a.id)}
                          disabled={stealthLock}
                        >
                          {(a.status || (a.resolvedAt ? "resolved" : "open")) === "resolved" ? "Reopen" : "Resolve"}
                        </button>
                      </div>

                      {(Array.isArray(a.responders) && a.responders.length) || (Array.isArray(a.acknowledgements) && a.acknowledgements.length) ? (
                        <div className="meta">
                          {Array.isArray(a.responders) && a.responders.length ? `Responders: ${a.responders.map((r) => r?.name || "Survivor").slice(0, 3).join(", ")}${a.responders.length > 3 ? "…" : ""}` : null}
                          {Array.isArray(a.acknowledgements) && a.acknowledgements.length ? `  •  Acknowledged: ${a.acknowledgements.map((r) => r?.name || "Survivor").slice(0, 3).join(", ")}${a.acknowledgements.length > 3 ? "…" : ""}` : null}
                          {a.resolvedAt ? `  •  Resolved: ${formatTime(a.resolvedAt)}${a.resolvedBy?.name ? ` by ${a.resolvedBy.name}` : ""}` : null}
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div>
              <div className="panelHeader">
                <div className="panelTitle">Threat Indicators</div>
                <div className="panelHint">Report danger markers to update the evolving risk map.</div>
              </div>

              <div className="row rowTight">
                <label className="label" style={{ flex: 1 }}>
                  Threat
                  <input
                    className="input"
                    value={threatLabel}
                    onChange={(e) => setThreatLabel(e.target.value)}
                    placeholder="e.g., vines moving / demobats / unstable gate"
                    maxLength={120}
                    disabled={stealthLock}
                  />
                </label>
                <label className="label" style={{ width: 180 }}>
                  Severity
                  <select
                    className="select"
                    value={threatSeverity}
                    onChange={(e) => setThreatSeverity(e.target.value)}
                    disabled={stealthLock}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
              </div>
              <button className="button" onClick={reportThreat} disabled={!connected || busy || stealthLock}>
                Drop Threat Marker
              </button>

              <div className="log">
                {threats.length === 0 ? (
                  <div className="empty">No threat reports yet.</div>
                ) : (
                  threats.map((t) => (
                    <div key={t.id} className="logItem">
                      <div className="logTop">
                        <span className="logName">{t.name}</span>
                        <span className="logTime">{formatTime(t.createdAt)}</span>
                      </div>
                      <div className="logText">
                        <Badge tone={t.severity === "high" ? "bad" : t.severity === "low" ? "warn" : "mid"}>
                          {t.severity.toUpperCase()}
                        </Badge>
                        <span className="spacer" />
                        {t.label}
                      </div>
                      {typeof t.confidence === "number" ? (
                        <div className="meta">Confidence: {(t.confidence * 100).toFixed(0)}%</div>
                      ) : null}
                      {t.location ? (
                        <div className="meta">GPS: {t.location.lat.toFixed(5)}, {t.location.lng.toFixed(5)}</div>
                      ) : (
                        <div className="meta">GPS: unavailable</div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "map" ? (
          <section className="panel tabPanel">
            <div className="panelHeader">
              <div className="panelTitle">Relief Camp Map</div>
              <div className="panelHint">Safe zones, camp status, resource availability, and danger markers.</div>
            </div>

            <div className="row" style={{ alignItems: "end" }}>
              <label className="label" style={{ width: 180 }}>
                Mark Type
                <select className="select" value={markKind} onChange={(e) => setMarkKind(e.target.value)} disabled={stealthLock}>
                  <option value="rally">Rally Point</option>
                  <option value="safe">Safe Zone</option>
                  <option value="resource">Resource</option>
                  <option value="blocked">Blocked</option>
                  <option value="danger">Danger</option>
                </select>
              </label>
              <label className="label" style={{ width: 180 }}>
                Radius (m)
                <select className="select" value={markRadiusM} onChange={(e) => setMarkRadiusM(Number(e.target.value))} disabled={stealthLock}>
                  <option value={60}>60</option>
                  <option value={120}>120</option>
                  <option value={250}>250</option>
                  <option value={500}>500</option>
                  <option value={1000}>1000</option>
                </select>
              </label>
              <label className="label" style={{ flex: 1, minWidth: 220 }}>
                Label
                <input
                  className="input"
                  value={markLabel}
                  onChange={(e) => setMarkLabel(e.target.value)}
                  placeholder="e.g., 'Safe corridor', 'Supply cache', 'Gate activity'"
                  maxLength={80}
                  disabled={stealthLock}
                />
              </label>

              <button
                className={markMode ? "button buttonDanger" : "button"}
                type="button"
                onClick={() => setMarkMode((p) => !p)}
                disabled={!connected || busy || stealthLock}
                title="When enabled, click the map to place a zone marker"
              >
                {markMode ? "Click map to place…" : "Mark Zone"}
              </button>
              <button
                className="button"
                type="button"
                onClick={markMyLocation}
                disabled={!connected || busy || stealthLock}
              >
                Mark My Location
              </button>
            </div>

            <div className="legend">
              <span className="legendItem"><span className="dot dotCamp" /> Relief Camp</span>
              <span className="legendItem"><span className="dot dotDanger" /> Danger Zone (broken streak)</span>
              <span className="legendItem"><span className="dot dotThreat" /> Threat Marker</span>
              <span className="legendItem"><span className="dot dotZone" /> Marked Zone</span>
            </div>

            <div className={markMode ? "mapWrap mapWrapMark" : "mapWrap"}>
              <MapContainer center={mapCenter} zoom={12} scrollWheelZoom className={markMode ? "map mapMark" : "map"}>
                <TileLayer
                  attribution='&copy; OpenStreetMap contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />

                <MapZoneMarkerPlacer enabled={markMode && !stealthLock} onPick={addZoneMarker} />

                {camps.map((c) => (
                  <Marker key={c.id} position={[c.location.lat, c.location.lng]}>
                    <Popup>
                      <div className="popupTitle">{c.name}</div>
                      <div className="meta">Status: {c.status}</div>
                      <div className="meta">
                        Resources — Food: {c.resources.food}, Water: {c.resources.water}, Medical: {c.resources.medical}, Power: {c.resources.power}
                      </div>
                    </Popup>
                    <Tooltip direction="top" offset={[0, -10]} opacity={0.9}>
                      {c.name}
                    </Tooltip>
                  </Marker>
                ))}

                {dangerZones
                  .filter((z) => z.location)
                  .map((z) => (
                    <CircleMarker
                      key={z.id}
                      center={[z.location.lat, z.location.lng]}
                      radius={18}
                      pathOptions={{ color: "#ff2a2a", fillColor: "#ff2a2a", fillOpacity: 0.25 }}
                    >
                      <Popup>
                        <div className="popupTitle">Potential Danger Zone</div>
                        <div className="meta">Survivor: {z.name}</div>
                        <div className="meta">Last seen: {formatTime(z.lastSeenAt)}</div>
                        <div className="meta">Reason: broken daily check-in streak</div>
                      </Popup>
                    </CircleMarker>
                  ))}

                {threats
                  .filter((t) => t.location)
                  .slice(0, 60)
                  .map((t) => (
                    <CircleMarker
                      key={t.id}
                      center={[t.location.lat, t.location.lng]}
                      radius={12}
                      pathOptions={{
                        color: t.severity === "high" ? "#ff9b2f" : "#ffcf4d",
                        fillColor: t.severity === "high" ? "#ff9b2f" : "#ffcf4d",
                        fillOpacity: 0.3
                      }}
                    >
                      <Popup>
                        <div className="popupTitle">Threat Marker</div>
                        <div className="meta">{t.label}</div>
                        <div className="meta">Severity: {t.severity}</div>
                        {typeof t.confidence === "number" ? (
                          <div className="meta">Confidence: {(t.confidence * 100).toFixed(0)}%</div>
                        ) : null}
                        <div className="meta">Reported by: {t.name}</div>
                        <div className="meta">Time: {formatTime(t.createdAt)}</div>
                      </Popup>
                    </CircleMarker>
                  ))}

                {zoneMarkers
                  .filter((m) => m?.location)
                  .slice(0, 120)
                  .map((m) => {
                    const style = markerStyleByKind?.[m.kind] || markerStyleByKind.rally;
                    return (
                      <Circle
                        key={m.id}
                        center={[m.location.lat, m.location.lng]}
                        radius={Number.isFinite(Number(m.radiusM)) ? Number(m.radiusM) : 250}
                        pathOptions={{
                          color: style.color,
                          fillColor: style.fillColor,
                          fillOpacity: style.fillOpacity,
                          weight: 2
                        }}
                      >
                        <Popup>
                          <div className="popupTitle">Marked Zone</div>
                          <div className="meta">Type: {String(m.kind || "rally")}</div>
                          <div className="meta">Label: {m.label || "Marked Zone"}</div>
                          <div className="meta">Radius: {m.radiusM || 250}m</div>
                          <div className="meta">By: {m.name || "Survivor"}</div>
                          <div className="meta">Time: {formatTime(m.createdAt)}</div>
                        </Popup>
                      </Circle>
                    );
                  })}

                <MapController focus={mapFocus} />
              </MapContainer>
            </div>
          </section>
        ) : null}

        {activeTab === "checkin" ? (
          <section className="panel tabPanel">
            <div className="panelHeader">
              <div className="panelTitle">Daily Streak Check-In</div>
              <div className="panelHint">
                Confirm you’re safe. If your streak breaks, your last known GPS location becomes a potential danger zone.
              </div>
            </div>

            <div className="cardGrid">
              <div className="card">
                <div className="cardTitle">Your Status</div>
                <div className="cardLine">{statusBadge} • Streak: {me?.streak ?? 0}</div>
                <div className="meta">User ID: {identity.userId}</div>
                <div className="meta">Last check-in: {me?.lastCheckInAt ? formatTime(me.lastCheckInAt) : "never"}</div>
                <div className="meta">Next reset (UTC): {checkinCountdown}</div>
              </div>

              <div className="card">
                <div className="cardTitle">Action</div>
                <button className="button" onClick={doCheckIn} disabled={busy}>
                  I’m Safe (Check-In)
                </button>
                <div className="chipRow" style={{ marginTop: 10 }}>
                  <button
                    className={checkinAttachGps ? "chip sosChipOn" : "chip"}
                    type="button"
                    onClick={() => setCheckinAttachGps((p) => !p)}
                    disabled={busy}
                  >
                    GPS: {checkinAttachGps ? "ON" : "OFF"}
                  </button>
                  <button className="chip" type="button" onClick={() => applyCheckInTemplate("STATUS: all clear. Staying mobile.")} disabled={busy}>
                    All Clear
                  </button>
                  <button className="chip" type="button" onClick={() => applyCheckInTemplate("STATUS: low supplies. Need water/food.")} disabled={busy}>
                    Low Supplies
                  </button>
                  <button className="chip" type="button" onClick={() => applyCheckInTemplate("STATUS: injured but stable. Avoid travel.")} disabled={busy}>
                    Injured
                  </button>
                </div>

                <label className="label" style={{ marginTop: 10 }}>
                  Daily Log (optional)
                  <input
                    className="input"
                    value={checkinNote}
                    onChange={(e) => setCheckinNote(e.target.value)}
                    placeholder="Short note for today: status, supplies, rendezvous…"
                    maxLength={180}
                    disabled={busy}
                  />
                </label>

                <div className="meta">Tip: keep it short — this is your daily breadcrumb trail.</div>
              </div>

              <div className="card">
                <div className="cardTitle">Active Danger Zones</div>
                <div className="meta">Derived from survivors with broken streaks.</div>
                <div className="meta">Count: {dangerZones.length}</div>

                {dangerZones.length === 0 ? (
                  <div className="meta" style={{ marginTop: 10 }}>
                    None right now. Danger zones appear when a survivor misses daily check-ins and has a last known location.
                  </div>
                ) : (
                  <div className="presenceList" style={{ marginTop: 10 }}>
                    {dangerZones.slice(0, 8).map((z) => (
                      <div key={z.id} className="presenceItem">
                        <span style={{ color: "#eee" }}>{z.name || "Survivor"}</span>
                        <span className="spacer" />
                        {z.location ? (
                          <button
                            className="chip"
                            type="button"
                            onClick={() => locateOnMap(z.location, 15)}
                            title="Open Map and focus this danger zone"
                            disabled={stealthLock}
                          >
                            Locate
                          </button>
                        ) : (
                          <span className="mono" style={{ color: "#888" }}>
                            no GPS
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="card">
                <div className="cardTitle">Last 7 Days</div>
                <div className="streakGrid">
                  {checkInHistory.days.map((d) => (
                    <div
                      key={d.key}
                      className={
                        d.entry
                          ? (d.isToday ? "streakCell streakOk streakToday" : "streakCell streakOk")
                          : (d.isToday ? "streakCell streakMiss streakToday" : "streakCell streakMiss")
                      }
                      title={d.entry?.note ? `${d.key} — ${d.entry.note}` : d.key}
                    >
                      <div className="streakDay">{d.key.slice(5)}</div>
                      <div className="streakMark">{d.entry ? "✓" : "–"}</div>
                    </div>
                  ))}
                </div>
                <div className="meta">Green = checked in. Gray = no log yet.</div>
              </div>

              <div className="card">
                <div className="cardTitle">Recent Logs</div>
                {checkInHistory.recent.length === 0 ? (
                  <div className="meta">No logs yet.</div>
                ) : (
                  <div className="presenceList">
                    {checkInHistory.recent.map((e) => (
                      <div key={`${e.dayKey}-${e.at}`} className="presenceItem">
                        <span className="mono">{e.dayKey}</span>
                        <span className="spacer" />
                        <span style={{ color: "#ddd" }}>{e.note || "(no note)"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}
        {activeTab === "hawkins" ? (
          <div className="tabPanel">
            <HawkinsProtocol
              identity={identity}
              mode={hawkinsMode}
              setMode={setHawkinsMode}
              autoReportThreat={autoReportThreat}
            />
          </div>
        ) : null}
        {activeTab === "intel" ? (
          <Intel identity={identity} stealthLock={stealthLock} apiPost={apiPost} />
        ) : null}
      </main>

      <footer className="footer">
        <div>
          This is a fictional disaster coordination UI themed after Stranger Things.
        </div>
      </footer>
    </div>
  );
}
