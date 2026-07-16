// server.js
// Complete backend server for the random text chat website.
// Run with: node server.js

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve the frontend files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// SAFETY: Bad word filter (static list). Add/remove words here as needed.
// ---------------------------------------------------------------------------
const BAD_WORDS = [
  'fuck', 'fucking', 'fucker', 'shit', 'bitch', 'asshole', 'bastard',
  'dick', 'pussy', 'cunt', 'whore', 'slut', 'randi', 'chutiya', 'madarchod',
  'behenchod', 'bhosdi', 'bhenchod', 'gandu', 'lund', 'chod', 'harami',
  'saala kutta', 'porn', 'sex chat', 'nudes'
];

function filterBadWords(message) {
  let filtered = message;
  BAD_WORDS.forEach((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('\\b' + escaped + '\\b', 'gi');
    filtered = filtered.replace(regex, (match) => '*'.repeat(match.length));
  });
  return filtered;
}

// ---------------------------------------------------------------------------
// SAFETY: Link prevention. Blocks messages containing URLs / domains.
// ---------------------------------------------------------------------------
const LINK_REGEX = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|in|io|co|xyz|me|link|info|biz)\b)/i;

function containsLink(message) {
  return LINK_REGEX.test(message);
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

// All currently connected sockets -> user state
// userState: { socketId, clientId, gender, lookingFor, status, partnerId, waitTimer }
const users = new Map();

// Users currently waiting to be matched
let waitingQueue = [];

// Reported pairs, so two clientIds that had a report between them never match again.
// Stored as a Set of "clientIdA|clientIdB" (sorted alphabetically).
const blockedPairs = new Set();

function pairKey(clientIdA, clientIdB) {
  return [clientIdA, clientIdB].sort().join('|');
}

function isBlockedPair(clientIdA, clientIdB) {
  return blockedPairs.has(pairKey(clientIdA, clientIdB));
}

function broadcastOnlineCount() {
  io.emit('onlineCount', users.size);
}

function clearWaitTimer(state) {
  if (state && state.waitTimer) {
    clearTimeout(state.waitTimer);
    state.waitTimer = null;
  }
}

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter((s) => s !== socketId);
}

// Checks compatibility between two waiting users' preferences.
function isCompatible(a, b) {
  const aWantsB = a.lookingFor === 'any' || a.lookingFor === b.gender;
  const bWantsA = b.lookingFor === 'any' || b.lookingFor === a.gender;
  return aWantsB && bWantsA;
}

// Attempts to find a match for the given socket id inside the waiting queue.
function tryMatch(socketId) {
  const state = users.get(socketId);
  if (!state || state.status !== 'waiting') return;

  for (let i = 0; i < waitingQueue.length; i++) {
    const otherId = waitingQueue[i];
    if (otherId === socketId) continue;

    const otherState = users.get(otherId);
    if (!otherState || otherState.status !== 'waiting') continue;

    if (isBlockedPair(state.clientId, otherState.clientId)) continue;

    if (isCompatible(state, otherState)) {
      // Found a match — remove both from the queue
      removeFromQueue(socketId);
      removeFromQueue(otherId);
      clearWaitTimer(state);
      clearWaitTimer(otherState);

      state.status = 'chatting';
      otherState.status = 'chatting';
      state.partnerId = otherId;
      otherState.partnerId = socketId;

      io.to(socketId).emit('matched', { partnerGender: otherState.gender });
      io.to(otherId).emit('matched', { partnerGender: state.gender });
      return true;
    }
  }
  return false;
}

// Puts a user into the waiting queue and starts the 20s "no match" timer.
function enqueueUser(socketId) {
  const state = users.get(socketId);
  if (!state) return;

  state.status = 'waiting';
  state.partnerId = null;
  if (!waitingQueue.includes(socketId)) {
    waitingQueue.push(socketId);
  }

  const matched = tryMatch(socketId);
  if (matched) return;

  clearWaitTimer(state);
  state.waitTimer = setTimeout(() => {
    const current = users.get(socketId);
    if (current && current.status === 'waiting') {
      io.to(socketId).emit('noMatchTimeout');
    }
  }, 20000);
}

// Ends the current chat session for a socket, notifying the partner.
function endChat(socketId, { notifyPartner = true, reason = 'left' } = {}) {
  const state = users.get(socketId);
  if (!state) return;

  const partnerId = state.partnerId;
  state.partnerId = null;
  state.status = 'idle';
  clearWaitTimer(state);
  removeFromQueue(socketId);

  if (partnerId) {
    const partnerState = users.get(partnerId);
    if (partnerState) {
      partnerState.partnerId = null;
      partnerState.status = 'idle';
      if (notifyPartner) {
        io.to(partnerId).emit('partnerLeft', { reason });
      }
    }
  }
}

io.on('connection', (socket) => {
  // Client must send its persistent clientId (generated & stored in browser localStorage)
  // right after connecting via the 'register' event.
  socket.on('register', (clientId) => {
    const safeClientId = (typeof clientId === 'string' && clientId.length > 0)
      ? clientId.slice(0, 100)
      : socket.id;

    users.set(socket.id, {
      socketId: socket.id,
      clientId: safeClientId,
      gender: null,
      lookingFor: null,
      status: 'idle',
      partnerId: null,
      waitTimer: null,
    });

    broadcastOnlineCount();
  });

  socket.on('findPartner', (payload) => {
    const state = users.get(socket.id);
    if (!state) return;

    const gender = ['male', 'female', 'other'].includes(payload && payload.gender)
      ? payload.gender
      : 'other';
    const lookingFor = ['male', 'female', 'any'].includes(payload && payload.lookingFor)
      ? payload.lookingFor
      : 'any';

    // If already chatting, end that first
    if (state.status === 'chatting') {
      endChat(socket.id, { notifyPartner: true, reason: 'skipped' });
    }

    state.gender = gender;
    state.lookingFor = lookingFor;

    enqueueUser(socket.id);
  });

  // User agrees to widen their filter to "Anyone" after the 20s timeout.
  socket.on('switchToAnyone', () => {
    const state = users.get(socket.id);
    if (!state || state.status !== 'waiting') return;
    state.lookingFor = 'any';
    tryMatch(socket.id);
  });

  // User chooses to keep waiting with the same filter for another cycle.
  socket.on('keepWaiting', () => {
    const state = users.get(socket.id);
    if (!state || state.status !== 'waiting') return;
    clearWaitTimer(state);
    state.waitTimer = setTimeout(() => {
      const current = users.get(socket.id);
      if (current && current.status === 'waiting') {
        io.to(socket.id).emit('noMatchTimeout');
      }
    }, 20000);
  });

  socket.on('chatMessage', (rawMessage) => {
    const state = users.get(socket.id);
    if (!state || state.status !== 'chatting' || !state.partnerId) return;

    if (typeof rawMessage !== 'string') return;
    const trimmed = rawMessage.trim().slice(0, 1000);
    if (trimmed.length === 0) return;

    if (containsLink(trimmed)) {
      socket.emit('systemNotice', 'Links are not allowed in chat. Your message was not sent.');
      return;
    }

    const cleanMessage = filterBadWords(trimmed);

    io.to(state.partnerId).emit('chatMessage', { text: cleanMessage, from: 'stranger' });
    socket.emit('chatMessage', { text: cleanMessage, from: 'me' });
  });

  socket.on('typing', (isTyping) => {
    const state = users.get(socket.id);
    if (!state || state.status !== 'chatting' || !state.partnerId) return;
    io.to(state.partnerId).emit('typing', !!isTyping);
  });

  socket.on('skip', () => {
    const state = users.get(socket.id);
    if (!state) return;

    if (state.status === 'chatting') {
      endChat(socket.id, { notifyPartner: true, reason: 'skipped' });
    } else {
      clearWaitTimer(state);
      removeFromQueue(socket.id);
      state.status = 'idle';
    }
  });

  socket.on('rejoinQueue', (payload) => {
    const state = users.get(socket.id);
    if (!state) return;

    const gender = ['male', 'female', 'other'].includes(payload && payload.gender)
      ? payload.gender
      : state.gender || 'other';
    const lookingFor = ['male', 'female', 'any'].includes(payload && payload.lookingFor)
      ? payload.lookingFor
      : state.lookingFor || 'any';

    state.gender = gender;
    state.lookingFor = lookingFor;
    enqueueUser(socket.id);
  });

  socket.on('report', () => {
    const state = users.get(socket.id);
    if (!state || !state.partnerId) return;

    const partnerState = users.get(state.partnerId);
    if (partnerState) {
      blockedPairs.add(pairKey(state.clientId, partnerState.clientId));
    }

    socket.emit('systemNotice', 'Stranger has been reported. You will not be matched with them again.');
    endChat(socket.id, { notifyPartner: true, reason: 'reported' });
  });

  socket.on('leaveChat', () => {
    const state = users.get(socket.id);
    if (!state) return;
    if (state.status === 'chatting') {
      endChat(socket.id, { notifyPartner: true, reason: 'left' });
    } else {
      clearWaitTimer(state);
      removeFromQueue(socket.id);
      state.status = 'idle';
    }
  });

  socket.on('disconnect', () => {
    const state = users.get(socket.id);
    if (state) {
      clearWaitTimer(state);
      removeFromQueue(socket.id);
      if (state.status === 'chatting' && state.partnerId) {
        const partnerState = users.get(state.partnerId);
        if (partnerState) {
          partnerState.partnerId = null;
          partnerState.status = 'idle';
          io.to(state.partnerId).emit('partnerLeft', { reason: 'disconnected' });
        }
      }
    }
    users.delete(socket.id);
    broadcastOnlineCount();
  });
});

server.listen(PORT, () => {
  console.log(`Random Chat server running on http://localhost:${PORT}`);
});
