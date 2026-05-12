const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  },
  maxHttpBufferSize: 5 * 1024 * 1024,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Health check
app.get('/', (req, res) => res.json({ status: 'AnonChat backend running' }));
app.get('/health', (req, res) => res.json({ status: 'ok', users: waitingUsers.size + connectedPairs.size / 2 }));

// Waiting queues by preference
const waitingQueues = { male:[], female:[], other:[], any:[] };
const connectedPairs = new Map();
const userInfo = new Map();
const waitingUsers = new Set();

function generateRoomKey() {
  return crypto.randomBytes(16).toString('hex');
}

function tryMatch(socket) {
  const user = userInfo.get(socket.id);
  if (!user) return;

  const { pref, gender, country } = user;
  let partnerSocket = null;

  const searchQueues = pref === 'any'
    ? ['male', 'female', 'other', 'any']
    : [pref, 'any'];

  // First try: match by country too
  for (const q of searchQueues) {
    const queue = waitingQueues[q];
    for (let i = 0; i < queue.length; i++) {
      const candidate = queue[i];
      if (candidate.id === socket.id) continue;
      const candidateInfo = userInfo.get(candidate.id);
      if (!candidateInfo) continue;

      const candidateWantsUs = candidateInfo.pref === 'any' || candidateInfo.pref === gender;
      const countryMatch = country === 'any' || candidateInfo.country === 'any' || candidateInfo.country === country;

      if (candidateWantsUs && countryMatch) {
        partnerSocket = candidate;
        queue.splice(i, 1);
        waitingUsers.delete(candidate.id);
        break;
      }
    }
    if (partnerSocket) break;
  }

  // Fallback: ignore country filter if no match found after 10s
  if (!partnerSocket && country !== 'any') {
    for (const q of searchQueues) {
      const queue = waitingQueues[q];
      for (let i = 0; i < queue.length; i++) {
        const candidate = queue[i];
        if (candidate.id === socket.id) continue;
        const candidateInfo = userInfo.get(candidate.id);
        if (!candidateInfo) continue;
        const candidateWantsUs = candidateInfo.pref === 'any' || candidateInfo.pref === gender;
        if (candidateWantsUs) {
          partnerSocket = candidate;
          queue.splice(i, 1);
          waitingUsers.delete(candidate.id);
          break;
        }
      }
      if (partnerSocket) break;
    }
  }

  if (partnerSocket) {
    removeFromQueues(socket.id);
    waitingUsers.delete(socket.id);

    const sharedKey = generateRoomKey();
    connectedPairs.set(socket.id, partnerSocket.id);
    connectedPairs.set(partnerSocket.id, socket.id);

    const partnerInfo = userInfo.get(partnerSocket.id);

    socket.emit('matched', {
      partnerNick: partnerInfo.nick,
      partnerGender: partnerInfo.gender,
      partnerCountry: partnerInfo.country,
      sharedKey
    });

    partnerSocket.emit('matched', {
      partnerNick: user.nick,
      partnerGender: user.gender,
      partnerCountry: user.country,
      sharedKey
    });

    console.log(`✅ Matched: ${user.nick}(${gender}/${country}) ↔ ${partnerInfo.nick}(${partnerInfo.gender}/${partnerInfo.country})`);
  } else {
    const myQueue = pref === 'any' ? 'any' : pref;
    waitingQueues[myQueue].push(socket);
    waitingUsers.add(socket.id);
    socket.emit('waiting', { position: waitingUsers.size });
    console.log(`⏳ Waiting: ${user.nick} (pref:${pref}, gender:${gender}, country:${country})`);
  }
}

function removeFromQueues(socketId) {
  for (const q of Object.values(waitingQueues)) {
    const idx = q.findIndex(s => s.id === socketId);
    if (idx !== -1) q.splice(idx, 1);
  }
}

io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on('findPartner', ({ nick, gender, pref, country }) => {
    const safeNick = String(nick || 'Anonymous').slice(0, 20).replace(/[<>]/g, '');
    const safeGender = ['male', 'female', 'other'].includes(gender) ? gender : 'other';
    const safePref = ['male', 'female', 'other', 'any'].includes(pref) ? pref : 'any';
    const safeCountry = String(country || 'any').slice(0, 10);

    userInfo.set(socket.id, { nick: safeNick, gender: safeGender, pref: safePref, country: safeCountry });
    tryMatch(socket);
  });

  socket.on('cancelSearch', () => {
    removeFromQueues(socket.id);
    waitingUsers.delete(socket.id);
  });

  socket.on('sendMessage', ({ text, encryptedText }) => {
    const partnerId = connectedPairs.get(socket.id);
    if (!partnerId) return;
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) return;
    const user = userInfo.get(socket.id);
    partnerSocket.emit('receiveMessage', {
      text: encryptedText || text,
      senderNick: user?.nick || 'Stranger',
      timestamp: Date.now()
    });
  });

  socket.on('sendImage', ({ imageData }) => {
    const partnerId = connectedPairs.get(socket.id);
    if (!partnerId) return;
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) return;
    if (!imageData || !imageData.startsWith('data:image/')) return;
    const user = userInfo.get(socket.id);
    partnerSocket.emit('receiveImage', {
      imageData,
      senderNick: user?.nick || 'Stranger',
      timestamp: Date.now()
    });
  });

  socket.on('typing', (isTyping) => {
    const partnerId = connectedPairs.get(socket.id);
    if (!partnerId) return;
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) partnerSocket.emit('partnerTyping', isTyping);
  });

  socket.on('skip', () => {
    handleDisconnectFromPair(socket);
    const user = userInfo.get(socket.id);
    if (user) tryMatch(socket);
  });

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
    if (partnerSocket) partnerSocket.emit('partnerLeft');
    connectedPairs.delete(socket.id);
    connectedPairs.delete(partnerId);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 AnonChat Server running on http://localhost:${PORT}`);
});
