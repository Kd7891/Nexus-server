// ─────────────────────────────────────────────
//  Nexus Server — Phase 1
//  Handles: room management, WebRTC signaling,
//           live chat relay, whiteboard sync
// ─────────────────────────────────────────────

const express   = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');

const app        = express();
const httpServer = createServer(app);

// ── CORS ──────────────────────────────────────
// Allow your frontend to connect.
// In production, replace '*' with your actual
// frontend URL e.g. 'https://nexus.vercel.app'
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// ── Health check ──────────────────────────────
// Render pings this to confirm the server is up
app.get('/', (req, res) => {
  res.json({
    app:     'Nexus',
    status:  'running',
    rooms:   rooms.size,
    uptime:  Math.floor(process.uptime()) + 's'
  });
});

// ── Room store ────────────────────────────────
// rooms: Map<roomCode, Room>
// Room:  { participants: Map<socketId, Participant> }
// Participant: { name, socketId, joinedAt }
const rooms = new Map();

function getParticipants(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  return Array.from(room.participants.values());
}

function cleanupRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room && room.participants.size === 0) {
    rooms.delete(roomCode);
    console.log(`[${roomCode}] Room removed (empty)`);
  }
}

// ── Socket.io ─────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // Track which room + name this socket belongs to
  let currentRoom = null;
  let currentName = null;

  // ── JOIN ROOM ──────────────────────────────
  // Client sends: { roomCode, name }
  // Server responds with current participant list
  // and notifies everyone else
  socket.on('join-room', ({ roomCode, name }) => {
    if (!roomCode || !name) return;
    roomCode = roomCode.toUpperCase().trim();
    name     = name.trim();

    // Create room if it doesn't exist yet
    if (!rooms.has(roomCode)) {
      rooms.set(roomCode, { participants: new Map() });
      console.log(`[${roomCode}] Room created`);
    }

    const room = rooms.get(roomCode);
    room.participants.set(socket.id, {
      name,
      socketId:  socket.id,
      joinedAt:  Date.now()
    });

    socket.join(roomCode);
    currentRoom = roomCode;
    currentName = name;

    // Send the newcomer: list of people already in the room
    // (they'll need to initiate WebRTC offers to each of them)
    const others = getParticipants(roomCode).filter(p => p.socketId !== socket.id);
    socket.emit('room-joined', { roomCode, participants: others });

    // Tell everyone else: new person arrived (so they can expect an offer)
    socket.to(roomCode).emit('participant-joined', { socketId: socket.id, name });

    // Broadcast the fresh participant list to everyone in the room
    io.to(roomCode).emit('participants-updated', getParticipants(roomCode));

    console.log(`[${roomCode}] ${name} joined — ${room.participants.size} in room`);
  });

  // ── LEAVE ROOM (explicit) ──────────────────
  socket.on('leave-room', () => handleLeave());

  // ── WebRTC SIGNALING ───────────────────────
  // These events are just relayed between specific peers.
  // The server never reads the offer/answer/candidate content.

  // Step 1: Caller sends offer to a specific peer
  socket.on('offer', ({ targetSocketId, offer }) => {
    if (!targetSocketId || !offer) return;
    socket.to(targetSocketId).emit('offer', {
      fromSocketId: socket.id,
      fromName:     currentName,
      offer
    });
  });

  // Step 2: Receiver sends answer back to caller
  socket.on('answer', ({ targetSocketId, answer }) => {
    if (!targetSocketId || !answer) return;
    socket.to(targetSocketId).emit('answer', {
      fromSocketId: socket.id,
      answer
    });
  });

  // Step 3: Both sides exchange ICE candidates (network paths)
  socket.on('ice-candidate', ({ targetSocketId, candidate }) => {
    if (!targetSocketId || !candidate) return;
    socket.to(targetSocketId).emit('ice-candidate', {
      fromSocketId: socket.id,
      candidate
    });
  });

  // ── CHAT ──────────────────────────────────
  // Relay a chat message to everyone in the room (including sender)
  socket.on('chat-message', ({ message }) => {
    if (!currentRoom || !message || !message.trim()) return;
    const time = new Date().toLocaleTimeString([], {
      hour:   '2-digit',
      minute: '2-digit'
    });
    io.to(currentRoom).emit('chat-message', {
      fromSocketId: socket.id,
      name:         currentName,
      message:      message.trim(),
      time
    });
  });

  // ── WHITEBOARD SYNC ────────────────────────
  // draw-event is sent to everyone EXCEPT the sender
  // (the sender already drew it locally for zero latency)
  socket.on('draw-event', (eventData) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('draw-event', {
      fromSocketId: socket.id,
      ...eventData  // tool, color, size, x0, y0, x1, y1
    });
  });

  // Relay "clear whiteboard" to everyone else in the room
  socket.on('clear-board', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('clear-board');
  });

  // ── DISCONNECT ─────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[-] Socket disconnected: ${socket.id} (${reason})`);
    handleLeave();
  });

  // ── LEAVE HANDLER ─────────────────────────
  function handleLeave() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);

    if (room) {
      room.participants.delete(socket.id);

      // Tell everyone this person left (so they can clean up their WebRTC connection)
      socket.to(currentRoom).emit('participant-left', {
        socketId: socket.id,
        name:     currentName
      });

      // Broadcast the updated participant list
      io.to(currentRoom).emit('participants-updated', getParticipants(currentRoom));

      const remaining = room.participants.size;
      console.log(`[${currentRoom}] ${currentName} left — ${remaining} remaining`);

      cleanupRoom(currentRoom);
    }

    socket.leave(currentRoom);
    currentRoom = null;
    currentName = null;
  }
});

// ── START ─────────────────────────────────────
// Render injects $PORT automatically; local default is 3001
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n  Nexus server listening on port ${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/\n`);
});
