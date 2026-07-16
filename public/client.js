// client.js
// Complete frontend logic for the random chat app.

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // Persistent anonymous client id (stored in localStorage) so the server
  // can remember "reported" pairs even across reconnects/page refreshes.
  // -----------------------------------------------------------------------
  function getOrCreateClientId() {
    var key = 'talkstrangr_client_id';
    var existing = localStorage.getItem(key);
    if (existing) return existing;
    var id = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(key, id);
    return id;
  }

  var clientId = getOrCreateClientId();
  var socket = io();

  // -----------------------------------------------------------------------
  // DOM references
  // -----------------------------------------------------------------------
  var homeScreen = document.getElementById('homeScreen');
  var searchScreen = document.getElementById('searchScreen');
  var chatScreen = document.getElementById('chatScreen');

  var onlineCountText = document.getElementById('onlineCountText');
  var genderGroup = document.getElementById('genderGroup');
  var lookingForGroup = document.getElementById('lookingForGroup');
  var startChatBtn = document.getElementById('startChatBtn');

  var searchStatusText = document.getElementById('searchStatusText');
  var timeoutBox = document.getElementById('timeoutBox');
  var switchAnyoneBtn = document.getElementById('switchAnyoneBtn');
  var keepWaitingBtn = document.getElementById('keepWaitingBtn');
  var cancelSearchBtn = document.getElementById('cancelSearchBtn');

  var chatHeaderText = document.getElementById('chatHeaderText');
  var genderBadge = document.getElementById('genderBadge');
  var statusDot = document.getElementById('statusDot');
  var reportBtn = document.getElementById('reportBtn');
  var messagesArea = document.getElementById('messagesArea');
  var typingIndicator = document.getElementById('typingIndicator');
  var messageForm = document.getElementById('messageForm');
  var messageInput = document.getElementById('messageInput');
  var sendBtn = document.getElementById('sendBtn');
  var nextBtn = document.getElementById('nextBtn');
  var stopBtn = document.getElementById('stopBtn');
  var toast = document.getElementById('toast');

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  var selectedGender = null;
  var selectedLookingFor = 'any';
  var isChatting = false;
  var typingTimeout = null;
  var toastTimeout = null;

  // -----------------------------------------------------------------------
  // Client-side safety filters (mirrors backend; backend remains authoritative)
  // -----------------------------------------------------------------------
  var BAD_WORDS = [
    'fuck', 'fucking', 'fucker', 'shit', 'bitch', 'asshole', 'bastard',
    'dick', 'pussy', 'cunt', 'whore', 'slut', 'randi', 'chutiya', 'madarchod',
    'behenchod', 'bhosdi', 'bhenchod', 'gandu', 'lund', 'chod', 'harami'
  ];

  function filterBadWordsClient(message) {
    var filtered = message;
    BAD_WORDS.forEach(function (word) {
      var escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var regex = new RegExp('\\b' + escaped + '\\b', 'gi');
      filtered = filtered.replace(regex, function (match) {
        return '*'.repeat(match.length);
      });
    });
    return filtered;
  }

  var LINK_REGEX = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|in|io|co|xyz|me|link|info|biz)\b)/i;

  function containsLinkClient(message) {
    return LINK_REGEX.test(message);
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // -----------------------------------------------------------------------
  // Screen switching helpers
  // -----------------------------------------------------------------------
  function showScreen(screenEl) {
    [homeScreen, searchScreen, chatScreen].forEach(function (el) {
      el.classList.add('hidden');
    });
    screenEl.classList.remove('hidden');
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.remove('hidden');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function () {
      toast.classList.add('hidden');
    }, 3500);
  }

  // -----------------------------------------------------------------------
  // Home screen: gender / lookingFor selection
  // -----------------------------------------------------------------------
  genderGroup.addEventListener('click', function (e) {
    var btn = e.target.closest('.chip');
    if (!btn) return;
    Array.prototype.forEach.call(genderGroup.querySelectorAll('.chip'), function (c) {
      c.classList.remove('active');
    });
    btn.classList.add('active');
    selectedGender = btn.getAttribute('data-gender');
  });

  lookingForGroup.addEventListener('click', function (e) {
    var btn = e.target.closest('.chip');
    if (!btn) return;
    Array.prototype.forEach.call(lookingForGroup.querySelectorAll('.chip'), function (c) {
      c.classList.remove('active');
    });
    btn.classList.add('active');
    selectedLookingFor = btn.getAttribute('data-lookingfor');
  });

  startChatBtn.addEventListener('click', function () {
    if (!selectedGender) {
      showToast('Please select your gender first.');
      return;
    }
    beginSearch();
  });

  function beginSearch() {
    showScreen(searchScreen);
    searchStatusText.textContent = 'Looking for a stranger to chat with…';
    timeoutBox.classList.add('hidden');
    socket.emit('findPartner', { gender: selectedGender, lookingFor: selectedLookingFor });
  }

  cancelSearchBtn.addEventListener('click', function () {
    socket.emit('leaveChat');
    timeoutBox.classList.add('hidden');
    showScreen(homeScreen);
  });

  switchAnyoneBtn.addEventListener('click', function () {
    selectedLookingFor = 'any';
    timeoutBox.classList.add('hidden');
    searchStatusText.textContent = 'Searching with "Anyone" filter…';
    socket.emit('switchToAnyone');
  });

  keepWaitingBtn.addEventListener('click', function () {
    timeoutBox.classList.add('hidden');
    searchStatusText.textContent = 'Still looking for a stranger to chat with…';
    socket.emit('keepWaiting');
  });

  // -----------------------------------------------------------------------
  // Chat screen: messaging
  // -----------------------------------------------------------------------
  function appendMessage(text, type) {
    var msgEl = document.createElement('div');
    msgEl.className = 'msg ' + type;
    msgEl.innerHTML = escapeHtml(text);
    messagesArea.appendChild(msgEl);
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function resetChatUI() {
    messagesArea.innerHTML = '';
    typingIndicator.classList.add('hidden');
    messageInput.value = '';
  }

  function enterChatMode(partnerGender) {
    isChatting = true;
    resetChatUI();
    showScreen(chatScreen);
    statusDot.classList.remove('offline');
    chatHeaderText.textContent = 'Connected with a stranger';
    updateGenderBadge(partnerGender);
    appendMessage('You are now chatting with a random stranger. Say hi!', 'system');
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();
  }

  function updateGenderBadge(partnerGender) {
    genderBadge.classList.remove('badge-male', 'badge-female', 'hidden');

    if (partnerGender === 'male') {
      genderBadge.textContent = 'M';
      genderBadge.classList.add('badge-male');
    } else if (partnerGender === 'female') {
      genderBadge.textContent = 'F';
      genderBadge.classList.add('badge-female');
    } else {
      // Other / unknown -> no badge, just the normal status text
      genderBadge.textContent = '';
      genderBadge.classList.add('hidden');
    }
  }

  function exitChatMode(statusMessage) {
    isChatting = false;
    statusDot.classList.add('offline');
    messageInput.disabled = true;
    sendBtn.disabled = true;
    typingIndicator.classList.add('hidden');
    genderBadge.classList.add('hidden');
    if (statusMessage) {
      appendMessage(statusMessage, 'system');
    }
  }

  messageForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!isChatting) return;

    var raw = messageInput.value.trim();
    if (!raw) return;

    if (containsLinkClient(raw)) {
      showToast('Links are not allowed in chat.');
      return;
    }

    var cleaned = filterBadWordsClient(raw);
    socket.emit('chatMessage', cleaned);
    messageInput.value = '';
    socket.emit('typing', false);
  });

  var typingActive = false;
  messageInput.addEventListener('input', function () {
    if (!isChatting) return;
    if (!typingActive) {
      typingActive = true;
      socket.emit('typing', true);
    }
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(function () {
      typingActive = false;
      socket.emit('typing', false);
    }, 1200);
  });

  nextBtn.addEventListener('click', function () {
    if (!selectedGender) {
      showScreen(homeScreen);
      return;
    }
    socket.emit('skip');
    showScreen(searchScreen);
    searchStatusText.textContent = 'Finding you a new stranger…';
    timeoutBox.classList.add('hidden');
    socket.emit('rejoinQueue', { gender: selectedGender, lookingFor: selectedLookingFor });
  });

  stopBtn.addEventListener('click', function () {
    socket.emit('leaveChat');
    exitChatMode(null);
    showScreen(homeScreen);
  });

  reportBtn.addEventListener('click', function () {
    if (!isChatting) return;
    var confirmed = window.confirm('Report this stranger? You will not be matched with them again.');
    if (!confirmed) return;
    socket.emit('report');
  });

  // -----------------------------------------------------------------------
  // Socket event listeners
  // -----------------------------------------------------------------------
  socket.on('connect', function () {
    socket.emit('register', clientId);
  });

  socket.on('onlineCount', function (count) {
    var n = Number(count) || 0;
    onlineCountText.textContent = n + (n === 1 ? ' user online right now' : ' users online right now');
  });

  socket.on('matched', function (data) {
    enterChatMode(data && data.partnerGender);
  });

  socket.on('noMatchTimeout', function () {
    timeoutBox.classList.remove('hidden');
    searchStatusText.textContent = 'Still searching…';
  });

  socket.on('chatMessage', function (data) {
    if (!data || typeof data.text !== 'string') return;
    appendMessage(data.text, data.from === 'me' ? 'me' : 'stranger');
  });

  socket.on('typing', function (isTyping) {
    if (isTyping) {
      typingIndicator.classList.remove('hidden');
    } else {
      typingIndicator.classList.add('hidden');
    }
  });

  socket.on('partnerLeft', function (data) {
    var reason = (data && data.reason) || 'left';
    var message = 'Stranger disconnected.';
    if (reason === 'skipped') message = 'Stranger skipped the chat.';
    if (reason === 'reported') message = 'Stranger disconnected.';
    exitChatMode(message + ' Click "Next / Skip" to find someone new.');
  });

  socket.on('systemNotice', function (text) {
    if (isChatting) {
      appendMessage(text, 'system');
    } else {
      showToast(text);
    }
  });

  socket.on('disconnect', function () {
    showToast('Connection lost. Reconnecting…');
    statusDot.classList.add('offline');
  });

  socket.on('connect_error', function () {
    showToast('Unable to connect to the server. Please refresh the page.');
  });
})();
