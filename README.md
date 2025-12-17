# Upside-Down Survivor Network

Real-time disaster communication + coordination for the fictional Upside Down.

**Included features (per spec)**
- **Zone-based chat rooms** (real-time via Socket.IO)
- **Global SOS alert stream** (real-time broadcast)
- **Interactive Relief Camp Map** showing **safe zones/camps**, **camp status**, and **resource availability**
- **Daily Streak Check-In** ("I’m Safe")
  - If a survivor **fails to check in** and the **streak breaks**, the backend marks their **last known GPS location** as a **potential danger zone**
  - Danger zones appear on the map to help others avoid/inspect risky sectors

**Hackathon demo tab**
- **H.A.W.K.I.N.S. Protocol**: a two-mode survival dashboard with a **Panic Switch**
  - **Running (Anti-Vecna)**: simulated heart-rate threshold triggers **Totem Audio** + red strobe
  - **Hiding (Anti-Demogorgon)**: microphone “spike” detection triggers **silent** RUN state + vibration
  - **Crowdsourced Sentry**: stealth detections automatically broadcast **Threat Markers** that appear on the map/stream
  - **Confidence scoring**: auto markers include a confidence percentage derived from spike strength + repeats
  - **Mode-enforced policy**: when Stealth Mode is ON, manual transmissions (chat/SOS/manual threat) are muted
  - Note: the app does not ship copyrighted music; you can load any audio file you have rights to.

## Run locally

Prereqs: Node.js 18+ (you have Node 22).

From repo root:

```bash
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:5174`

## How it works

- **Frontend**: React (Vite) in `client/`
- **Backend**: Node.js + Express + Socket.IO in `server/`
- **State**: in-memory (no database). Restarting the server resets messages/alerts.

### Key endpoints

- `GET /api/health`
- `GET /api/zones`
- `GET /api/camps`
- `GET /api/sos`
- `GET /api/threats`
- `GET /api/danger-zones`
- `POST /api/checkin` body: `{ userId, name, location?: { lat, lng } }`

### WebSocket events

- `join_zone` → joins a zone room, returns `zone_history`
- `chat_message` → zone-scoped messages
- `sos_alert` → global SOS messages
- `threat_report` → global threat markers
- `danger_zones_update` → pushes updated danger zones list

## Notes

- The map uses OpenStreetMap tiles (requires internet access).
- Location is attached when the browser grants Geolocation permission.
