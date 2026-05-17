// ─────────────────────────────────────────────
//  Nexus Server — Phase 1 + Auth
//  Handles: auth, room management,
//           WebRTC signaling, chat, whiteboard
// ─────────────────────────────────────────────

const express   = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const path      = require('path');
const mongoose  = require('mongoose');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app        = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST'] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── MongoDB ───────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('  MongoDB connected'))
  .catch(e  => console.error('  MongoDB error:', e.message));

// ── User model ────────────────────────────────
const userSchema = new mongoose.Schema({
  email:       { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:    { type: String, required: true },
  displayName: { type: String, required: true, trim: true },
  createdAt:   { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ── JWT helpers ───────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'nexus-change-this-in-production';

function signToken(user) {
  return jwt.sign(
    { userId: user._id, email: user.email, displayName: user.displayName },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// ── Rate limiting ─────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' }
});

// ── Health check ──────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ app: 'Nexus', status: 'running', rooms: rooms.size, uptime: Math.floor(process.uptime()) + 's' });
});

// ── REGISTER ──────────────────────────────────
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { email, password, displayName } = req.body;
    if (!email || !password || !displayName)
      return res.status(400).json({ error: 'All fields are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (displayName.trim().length < 2)
      return res.status(400).json({ error: 'Name must be at least 2 characters.' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ error: 'An account with this email already exists.' });

    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({ email: email.toLowerCase(), password: hash, displayName: displayName.trim() });
    const token = signToken(user);
    console.log(`[Auth] Registered: ${user.email}`);
    res.status(201).json({ token, user: { email: user.email, displayName: user.displayName } });
  } catch(e) {
    console.error('[Register]', e.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── LOGIN ─────────────────────────────────────
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user)
      return res.status(401).json({ error: 'Invalid email or password.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(401).json({ error: 'Invalid email or password.' });

    const token = signToken(user);
    console.log(`[Auth] Login: ${user.email}`);
    res.json({ token, user: { email: user.email, displayName: user.displayName } });
  } catch(e) {
    console.error('[Login]', e.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── VERIFY TOKEN ──────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ── Room store ────────────────────────────────
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
    console.log(`[${roomCode}] Room removed`);
  }
}

// ── Socket.io ─────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null, currentName = null;

  socket.on('join-room', ({ roomCode, name }) => {
    if (!roomCode || !name) return;
    roomCode = roomCode.toUpperCase().trim();
    name     = name.trim();
    if (!rooms.has(roomCode)) rooms.set(roomCode, { participants: new Map() });
    const room = rooms.get(roomCode);
    room.participants.set(socket.id, { name, socketId: socket.id, joinedAt: Date.now() });
    socket.join(roomCode);
    currentRoom = roomCode;
    currentName = name;
    const others = getParticipants(roomCode).filter(p => p.socketId !== socket.id);
    socket.emit('room-joined', { roomCode, participants: others });
    socket.to(roomCode).emit('participant-joined', { socketId: socket.id, name });
    io.to(roomCode).emit('participants-updated', getParticipants(roomCode));
    console.log(`[${roomCode}] ${name} joined (${room.participants.size})`);
  });

  socket.on('leave-room', () => handleLeave());

  socket.on('offer', ({ targetSocketId, offer }) => {
    if (!targetSocketId || !offer) return;
    socket.to(targetSocketId).emit('offer', { fromSocketId: socket.id, fromName: currentName, offer });
  });

  socket.on('answer', ({ targetSocketId, answer }) => {
    if (!targetSocketId || !answer) return;
    socket.to(targetSocketId).emit('answer', { fromSocketId: socket.id, answer });
  });

  socket.on('ice-candidate', ({ targetSocketId, candidate }) => {
    if (!targetSocketId || !candidate) return;
    socket.to(targetSocketId).emit('ice-candidate', { fromSocketId: socket.id, candidate });
  });

  socket.on('chat-message', ({ message }) => {
    if (!currentRoom || !message?.trim()) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    io.to(currentRoom).emit('chat-message', { fromSocketId: socket.id, name: currentName, message: message.trim(), time });
  });

  socket.on('draw-event', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('draw-event', { fromSocketId: socket.id, ...data });
  });

  socket.on('clear-board', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('clear-board');
  });

  socket.on('disconnect', () => handleLeave());

  function handleLeave() {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.participants.delete(socket.id);
      socket.to(currentRoom).emit('participant-left', { socketId: socket.id, name: currentName });
      io.to(currentRoom).emit('participants-updated', getParticipants(currentRoom));
      cleanupRoom(currentRoom);
    }
    socket.leave(currentRoom);
    currentRoom = null;
    currentName = null;
  }
});

// ── START ─────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n  Nexus listening on port ${PORT}\n`);
});
