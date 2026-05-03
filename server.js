const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Vercel frontend URL yahan daalo
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

const io = new Server(server, {
  cors: {
    origin: ['https://anonchat-ruddy.vercel.app', FRONTEND_URL, '*'],
    methods: ['GET', 'POST'],
    credentials: false
  },
  maxHttpBufferSize: 5 * 1024 * 1024
});

// Health check
app.get('/', (req, res) => res.json({ status: 'AnonChat backend running' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Waiting queues by preference ──
// Key: 'male', 'female', 'other', 'any'
const waitingQueues = {
  male:   [],
  female: [],
  other:  [],
  any:    []
};

// ── Connected pairs: socketId -> partnerSocketId ──
const connectedPairs = new Map();

// ── User info: socketId -> { nick, gender, pref } ──
const userInfo = new Map();

// ── Waiting users set ──
const waitingUsers = new Set();

// ── Encryption key (per-pair, sent to both) ──
// In production use proper E2E — here we simulate with a shared session key
function generateRoomKey() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Try to match two users ──
function tryMatch(socket) {
  const user = userInfo.get(socket.id);
  if (!user) return;

  const { pref, gender } = user;

  // Find a waiting user who:
  // 1. Wants to chat with our gender (or any)
  // 2. Matches our pref (or we want any)
  let partnerSocket = null;

  const searchQueues = pref === 'any'
    ? ['male', 'female', 'other', 'any']
    : [pref, 'any'];

  for (const q of searchQueues) {
    const queue = waitingQueues[q];
    for (let i = 0; i < queue.length; i++) {
      const candidate = queue[i];
      if (candidate.id === socket.id) continue;

      const candidateInfo = userInfo.get(candidate.id);
      if (!candidateInfo) continue;

      // Check if candidate's preference matches our gender
      const candidateWantsUs =
        candidateInfo.pref === 'any' || candidateInfo.pref === gender;

      if (candidateWantsUs) {
        partnerSocket = candidate;
        queue.splice(i, 1);
        waitingUsers.delete(candidate.id);
        break;
      }
    }
    if (partnerSocket) break;
  }

  if (partnerSocket) {
    // Remove current user from their queue too
    removeFromQueues(socket.id);
    waitingUsers.delete(socket.id);

    // Create room + shared key
    const roomId = crypto.randomUUID();
    const sharedKey = generateRoomKey();

    connectedPairs.set(socket.id, partnerSocket.id);
    connectedPairs.set(partnerSocket.id, socket.id);

    const partnerInfo = userInfo.get(partnerSocket.id);

    // Notify both
    socket.emit('matched', {
      partnerNick: partnerInfo.nick,
      partnerGender: partnerInfo.gender,
      roomId,
      sharedKey
    });

    partnerSocket.emit('matched', {
      partnerNick: user.nick,
      partnerGender: user.gender,
      roomId,
      sharedKey
    });

    console.log(`✅ Matched: ${user.nick}(${gender}) ↔ ${partnerInfo.nick}(${partnerInfo.gender})`);
  } else {
    // Add to waiting queue
    const myQueue = pref === 'any' ? 'any' : pref;
    waitingQueues[myQueue].push(socket);
    waitingUsers.add(socket.id);
    socket.emit('waiting', { position: waitingUsers.size });
    console.log(`⏳ Waiting: ${user.nick} (pref: ${pref}, gender: ${gender})`);
  }
}

function removeFromQueues(socketId) {
  for (const q of Object.values(waitingQueues)) {
    const idx = q.findIndex(s => s.id === socketId);
    if (idx !== -1) q.splice(idx, 1);
  }
}

// ══════════════════════════════════════
//   SOCKET EVENTS
// ══════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ── User joins search ──
  socket.on('findPartner', ({ nick, gender, pref }) => {
    // Sanitize
    const safeNick = String(nick || 'Anonymous').slice(0, 20).replace(/[<>]/g, '');
    const safeGender = ['male', 'female', 'other'].includes(gender) ? gender : 'other';
    const safePref = ['male', 'female', 'other', 'any'].includes(pref) ? pref : 'any';

    userInfo.set(socket.id, { nick: safeNick, gender: safeGender, pref: safePref });
    tryMatch(socket);
  });

  // ── Cancel search ──
  socket.on('cancelSearch', () => {
    removeFromQueues(socket.id);
    waitingUsers.delete(socket.id);
    console.log(`❌ Cancelled: ${socket.id}`);
  });

  // ── Send text message ──
  socket.on('sendMessage', ({ text, encryptedText }) => {
    const partnerId = connectedPairs.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) return;

    // We forward the encrypted text — server NEVER reads plain text
    const user = userInfo.get(socket.id);
    partnerSocket.emit('receiveMessage', {
      text: encryptedText || text, // send encrypted version
      senderNick: user?.nick || 'Stranger',
      senderGender: user?.gender || 'other',
      timestamp: Date.now()
    });
  });

  // ── Send image ──
  socket.on('sendImage', ({ imageData }) => {
    const partnerId = connectedPairs.get(socket.id);
    if (!partnerId) return;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) return;

    // Validate it's actually an image base64
    if (!imageData || !imageData.startsWith('data:image/')) return;

    const user = userInfo.get(socket.id);
    partnerSocket.emit('receiveImage', {
      imageData,
      senderNick: user?.nick || 'Stranger',
      senderGender: user?.gender || 'other',
      timestamp: Date.now()
    });
  });

  // ── Typing indicator ──
  socket.on('typing', (isTyping) => {
    const partnerId = connectedPairs.get(socket.id);
    if (!partnerId) return;
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) partnerSocket.emit('partnerTyping', isTyping);
  });

  // ── Skip / find new ──
  socket.on('skip', () => {
    handleDisconnectFromPair(socket);
    const user = userInfo.get(socket.id);
    if (user) tryMatch(socket);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    handleDisconnectFromPair(socket);
    removeFromQueues(socket.id);
    waitingUsers.delete(socket.id);
    userInfo.delete(socket.id);
    console.log(`🔴 Disconnected: ${socket.id}`);
  });
});

function handleDisconnectFromPair(socket) {
  const partnerId = connectedPairs.get(socket.id);
  if (partnerId) {
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      partnerSocket.emit('partnerLeft');
    }
    connectedPairs.delete(socket.id);
    connectedPairs.delete(partnerId);
  }
}

// ── Start ──
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 AnonChat Server running on http://localhost:${PORT}`);
});
