# Nexus Server — Phase 1

Real-time signaling and sync server for the Nexus meeting app.
Built with Node.js, Express, and Socket.io.

---

## What this server does

| Feature | How |
|---|---|
| Room management | Creates and tracks meeting rooms in memory |
| WebRTC signaling | Relays offer / answer / ICE between peers |
| Live chat | Broadcasts messages to everyone in a room |
| Whiteboard sync | Relays draw events to all other participants |

Video and audio travel **directly between users** (peer-to-peer) — the server never touches the video stream, so bandwidth costs stay at zero.

---

## Deploy to Render (free, 5 minutes)

### Step 1 — Create a GitHub repo

1. Go to [github.com](https://github.com) and sign in (or create a free account)
2. Click **New repository**
3. Name it `nexus-server`
4. Click **Create repository**
5. Upload these files: `server.js`, `package.json`, `render.yaml`

### Step 2 — Deploy on Render

1. Go to [render.com](https://render.com) and sign up free
2. Click **New → Web Service**
3. Connect your GitHub account and select `nexus-server`
4. Render auto-detects the config from `render.yaml`
5. Click **Create Web Service**

Render will build and deploy automatically. Takes about 2 minutes.

### Step 3 — Get your server URL

Once deployed, Render gives you a URL like:

```
https://nexus-server-xxxx.onrender.com
```

Copy this URL — you'll need it in Phase 2 when connecting the frontend.

### Step 4 — Test it

Visit your Render URL in a browser. You should see:

```json
{
  "app": "Nexus",
  "status": "running",
  "rooms": 0,
  "uptime": "12s"
}
```

If you see this, your server is live. ✅

---

## Run locally (for development)

```bash
npm install
npm run dev
```

Then visit http://localhost:3001

---

## Socket.io events reference

### Client → Server

| Event | Payload | Description |
|---|---|---|
| `join-room` | `{ roomCode, name }` | Join or create a room |
| `leave-room` | — | Leave current room |
| `offer` | `{ targetSocketId, offer }` | Send WebRTC offer to a peer |
| `answer` | `{ targetSocketId, answer }` | Send WebRTC answer to a peer |
| `ice-candidate` | `{ targetSocketId, candidate }` | Send ICE candidate to a peer |
| `chat-message` | `{ message }` | Send a chat message to the room |
| `draw-event` | `{ tool, color, size, x0, y0, x1, y1 }` | Sync a whiteboard stroke |
| `clear-board` | — | Clear the whiteboard for everyone |

### Server → Client

| Event | Payload | Description |
|---|---|---|
| `room-joined` | `{ roomCode, participants }` | Confirms join, sends existing participants |
| `participant-joined` | `{ socketId, name }` | Someone new joined |
| `participant-left` | `{ socketId, name }` | Someone left |
| `participants-updated` | `[participants]` | Full updated participant list |
| `offer` | `{ fromSocketId, fromName, offer }` | Incoming WebRTC offer |
| `answer` | `{ fromSocketId, answer }` | Incoming WebRTC answer |
| `ice-candidate` | `{ fromSocketId, candidate }` | Incoming ICE candidate |
| `chat-message` | `{ fromSocketId, name, message, time }` | Incoming chat message |
| `draw-event` | `{ fromSocketId, ...drawData }` | Incoming whiteboard stroke |
| `clear-board` | — | Whiteboard was cleared by someone |

---

## Notes

- **Free tier on Render:** The server sleeps after 15 minutes of inactivity, then wakes on the next request (takes ~30 seconds). For always-on, you'd need a paid plan — but free is fine for testing and low traffic.
- **Scaling:** For hundreds of concurrent users, you'd add Redis to share room state across multiple server instances. For now, in-memory is perfect.
- **Security:** The server doesn't read the contents of offers/answers — it just relays them. End-to-end encryption is handled by WebRTC itself (DTLS-SRTP).
