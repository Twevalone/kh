// ============ STATE ============
const state = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  socket: null,
  currentChatId: null,
  currentOtherUser: null,
  chats: [],
  isRegister: false,
  typingTimeout: null,
  searchTimeout: null,
  openingChat: false,  // guard against double-open
  // Voice recording
  mediaRecorder: null,
  audioChunks: [],
  recordingStartTime: null,
  recordingTimer: null,
  isRecording: false,
  // Call
  callState: 'idle', // idle | outgoing | incoming | active
  callPeer: null,     // { id, name, avatarColor, avatarUrl }
  peerConnection: null,
  localStream: null,
  callTimer: null,
  callStartTime: null,
  isMuted: false,
  isSpeaker: false,
  pendingOffer: null,
  pendingCandidates: [],
  // Reply & forward
  replyTo: null, // { id, senderName, text, type }
  contextMenuMsgId: null,
  forwardMsg: null, // message to forward
};

// ============ DOM ELEMENTS ============
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const authScreen = $('#auth-screen');
const appScreen = $('#app-screen');
const authForm = $('#auth-form');
const authBtn = $('#auth-btn');
const authError = $('#auth-error');
const authSubtitle = $('#auth-subtitle');
const authSwitchText = $('#auth-switch-text');
const authSwitchLink = $('#auth-switch-link');
const displayNameGroup = $('#displayname-group');
const displayNameInput = $('#displayname-input');
const usernameInput = $('#username-input');
const passwordInput = $('#password-input');

const sidebar = $('#sidebar');
const searchInput = $('#search-input');
const searchResults = $('#search-results');
const searchResultsList = $('#search-results-list');
const chatList = $('#chat-list');
const noChats = $('#no-chats');

const chatArea = $('#chat-area');
const chatEmpty = $('#chat-empty');
const chatView = $('#chat-view');
const chatAvatar = $('#chat-avatar');
const chatName = $('#chat-name');
const chatStatus = $('#chat-status');
const messagesContainer = $('#messages-container');
const messagesList = $('#messages-list');
const messageInput = $('#message-input');
const sendBtn = $('#send-btn');
const backBtn = $('#back-btn');
const typingIndicator = $('#typing-indicator');
const typingText = $('#typing-text');

// Reply & forward DOM
const replyBar = $('#reply-bar');
const replyBarName = $('#reply-bar-name');
const replyBarText = $('#reply-bar-text');
const replyBarClose = $('#reply-bar-close');
const msgContextMenu = $('#msg-context-menu');
const ctxReply = $('#ctx-reply');
const ctxForward = $('#ctx-forward');
const ctxCopy = $('#ctx-copy');
const forwardModal = $('#forward-modal');
const forwardChatList = $('#forward-chat-list');
const forwardClose = $('#forward-close');

// ============ INIT ============
function init() {
  if (state.token && state.user) {
    showApp();
  } else {
    showAuth();
  }
  setupEventListeners();
  initEmojiPicker();
}

// ============ AUTH ============
function showAuth() {
  authScreen.classList.add('active');
  appScreen.classList.remove('active');
}

function showApp() {
  authScreen.classList.remove('active');
  appScreen.classList.add('active');
  connectSocket();
}

function toggleAuthMode() {
  state.isRegister = !state.isRegister;
  if (state.isRegister) {
    authBtn.textContent = 'Зарегистрироваться';
    authSubtitle.textContent = 'Создайте аккаунт';
    authSwitchText.textContent = 'Уже есть аккаунт?';
    authSwitchLink.textContent = 'Войти';
    displayNameGroup.style.display = 'block';
  } else {
    authBtn.textContent = 'Войти';
    authSubtitle.textContent = 'Войдите, чтобы продолжить';
    authSwitchText.textContent = 'Нет аккаунта?';
    authSwitchLink.textContent = 'Зарегистрироваться';
    displayNameGroup.style.display = 'none';
  }
  authError.textContent = '';
}

async function handleAuth(e) {
  e.preventDefault();
  authError.textContent = '';

  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const displayName = displayNameInput.value.trim();

  if (!username || !password) {
    authError.textContent = 'Заполните все поля';
    return;
  }

  if (state.isRegister && !displayName) {
    authError.textContent = 'Введите ваше имя';
    return;
  }

  authBtn.disabled = true;
  authBtn.textContent = 'Подождите...';

  try {
    const endpoint = state.isRegister ? '/api/register' : '/api/login';
    const body = state.isRegister
      ? { username, password, displayName }
      : { username, password };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Ошибка');
    }

    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));

    // Clear form
    usernameInput.value = '';
    passwordInput.value = '';
    displayNameInput.value = '';

    showApp();
  } catch (err) {
    authError.textContent = err.message;
  } finally {
    authBtn.disabled = false;
    authBtn.textContent = state.isRegister ? 'Зарегистрироваться' : 'Войти';
  }
}

// ============ SOCKET ============
function connectSocket() {
  if (state.socket) {
    state.socket.disconnect();
  }

  state.socket = io({
    auth: { token: state.token },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });

  state.socket.on('connect', () => {
    console.log('Connected to server');
    loadChats();

    // Re-join current chat room after reconnect
    if (state.currentChatId) {
      console.log('Rejoining chat room:', state.currentChatId);
      state.socket.emit('chat:open', state.currentChatId, (data) => {
        if (data && data.messages) {
          // Re-render messages from server to ensure nothing is lost
          renderMessages(data.messages);
        }
      });
    }
  });

  state.socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
  });

  // Only logout on explicit auth failure, not on temporary connection issues
  state.socket.on('connect_error', (err) => {
    console.error('Connection error:', err.message);
    if (err.message === 'Invalid token' || err.message === 'Authentication required') {
      logout();
    }
    // Otherwise just let Socket.IO reconnect automatically
  });

  // New message
  state.socket.on('message:new', (message) => {
    if (message.chat_id === state.currentChatId) {
      // Don't add duplicate messages
      if (!document.querySelector(`.message[data-id="${message.id}"]`)) {
        appendMessage(message);
        scrollToBottom();
      }

      // Mark as read if chat is open
      if (message.sender_id !== state.user.id) {
        state.socket.emit('messages:markRead', state.currentChatId);
      }
    }
    loadChats();
  });

  // Chats updated
  state.socket.on('chats:updated', () => {
    loadChats();
  });

  // Messages read — update single checks to double checks
  state.socket.on('messages:read', ({ chatId, readBy }) => {
    if (chatId === state.currentChatId && readBy !== state.user.id) {
      document.querySelectorAll('.message-out .message-check:not(.read)').forEach(el => {
        el.classList.add('read');
        el.innerHTML = `
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 12 5 16 12 6"/>
            <polyline points="7 12 11 16 18 6"/>
          </svg>`;
      });
    }
    loadChats();
  });

  // Typing indicators
  state.socket.on('typing:start', ({ chatId, userId }) => {
    if (chatId === state.currentChatId && userId !== state.user.id) {
      typingIndicator.style.display = 'flex';
      chatStatus.textContent = 'печатает...';
      chatStatus.classList.add('online');
    }
  });

  state.socket.on('typing:stop', ({ chatId, userId }) => {
    if (chatId === state.currentChatId && userId !== state.user.id) {
      typingIndicator.style.display = 'none';
      updateChatStatus();
    }
  });

  // Online/offline
  state.socket.on('user:online', ({ userId }) => {
    if (state.currentOtherUser && state.currentOtherUser.id === userId) {
      state.currentOtherUser.is_online = true;
      updateChatStatus();
    }
    updateChatListOnlineStatus(userId, true);
  });

  state.socket.on('user:offline', ({ userId }) => {
    if (state.currentOtherUser && state.currentOtherUser.id === userId) {
      state.currentOtherUser.is_online = false;
      updateChatStatus();
    }
    updateChatListOnlineStatus(userId, false);
  });

  // Avatar updated by another user
  state.socket.on('user:avatar-updated', ({ userId, avatarUrl }) => {
    if (state.currentOtherUser && state.currentOtherUser.id === userId) {
      state.currentOtherUser.avatar_url = avatarUrl;
      setAvatarElement(chatAvatar, state.currentOtherUser.display_name, state.currentOtherUser.avatar_color, avatarUrl);
    }
    loadChats();
  });

  // ---- Call signaling ----
  state.socket.on('call:incoming', ({ callerId, callerName, callerAvatarColor, callerAvatarUrl }) => {
    if (state.callState !== 'idle') return;
    state.callPeer = { id: callerId, name: callerName, avatarColor: callerAvatarColor, avatarUrl: callerAvatarUrl };
    showIncomingCall();
  });

  state.socket.on('call:accepted', async () => {
    if (state.callState !== 'outgoing') return;
    callOutStatus.textContent = 'Подключение...';
    // Caller: set up WebRTC, create offer, send it
    await startWebRTC(true);
  });

  state.socket.on('call:rejected', () => {
    if (state.callState === 'outgoing') {
      endCallCleanup();
      showCallToast('Звонок отклонён');
    }
  });

  state.socket.on('call:ended', ({ by }) => {
    if (state.callPeer && state.callPeer.id === by) {
      endCallCleanup();
      showCallToast('Звонок завершён');
    }
  });

  // Callee receives offer from caller
  state.socket.on('call:offer', async ({ from, offer }) => {
    console.log('Received offer, callState:', state.callState, 'pc:', !!state.peerConnection);
    // Buffer offer if PeerConnection isn't ready yet
    if (!state.peerConnection) {
      state.pendingOffer = { from, offer };
      console.log('Buffered offer — PeerConnection not ready yet');
      return;
    }
    await handleOffer(from, offer);
  });

  state.socket.on('call:answer', async ({ from, answer }) => {
    if (!state.peerConnection) return;
    try {
      await state.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      console.log('Remote description set (answer)');
    } catch (err) {
      console.error('Error handling answer:', err);
    }
  });

  state.socket.on('call:ice-candidate', async ({ from, candidate }) => {
    // Buffer ICE candidates if PeerConnection isn't ready
    if (!state.peerConnection) {
      if (!state.pendingCandidates) state.pendingCandidates = [];
      state.pendingCandidates.push(candidate);
      return;
    }
    try {
      await state.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  });
}

function logout() {
  state.token = null;
  state.user = null;
  state.currentChatId = null;
  state.currentOtherUser = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  showAuth();
}

// ============ CHATS ============
function loadChats() {
  if (!state.socket || !state.socket.connected) return;
  state.socket.emit('chats:list', (chats) => {
    state.chats = chats;
    renderChatList();
  });
}

function renderChatList() {
  const items = state.chats
    .filter(c => c.last_message !== null || c.last_message_type === 'voice')
    .map(chat => {
      const isActive = chat.chat_id === state.currentChatId;
      const initials = getInitials(chat.other_display_name);
      const time = chat.last_message_time ? formatTime(chat.last_message_time) : '';
      const isMyMessage = chat.last_message_sender === state.user.id;
      const isVoice = chat.last_message_type === 'voice';
      const preview = isVoice ? '' : (chat.last_message || '');
      const truncated = preview.length > 40 ? preview.substring(0, 40) + '...' : preview;
      const unread = parseInt(chat.unread_count) || 0;

      return `
        <div class="chat-item ${isActive ? 'active' : ''}" data-chat-id="${chat.chat_id}" data-user-id="${chat.other_user_id}">
          <div class="chat-item-avatar" style="${getAvatarStyle(chat.other_avatar_color, chat.other_avatar_url)}">
            ${renderAvatarHTML(chat.other_display_name, chat.other_avatar_color, chat.other_avatar_url)}
            ${chat.other_is_online ? '<div class="online-dot"></div>' : ''}
          </div>
          <div class="chat-item-body">
            <div class="chat-item-top">
              <div class="chat-item-name">${escapeHtml(chat.other_display_name)}</div>
              <div class="chat-item-time">${time}</div>
            </div>
            <div class="chat-item-bottom">
              <div class="chat-item-message">
                ${isMyMessage ? '<span class="sender-prefix">Вы: </span>' : ''}${isVoice ? '<span class="chat-item-voice-icon"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg></span> Голосовое сообщение' : escapeHtml(truncated)}
              </div>
              ${unread > 0 ? `<div class="unread-badge">${unread}</div>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

  if (items) {
    chatList.innerHTML = items;
    noChats.style.display = 'none';
  } else {
    chatList.innerHTML = '';
    noChats.style.display = 'flex';
    chatList.appendChild(noChats);
  }
}

function updateChatListOnlineStatus(userId, isOnline) {
  const chatItem = chatList.querySelector(`[data-user-id="${userId}"]`);
  if (chatItem) {
    const avatar = chatItem.querySelector('.chat-item-avatar');
    const dot = avatar.querySelector('.online-dot');
    if (isOnline && !dot) {
      avatar.insertAdjacentHTML('beforeend', '<div class="online-dot"></div>');
    } else if (!isOnline && dot) {
      dot.remove();
    }
  }
}

// ============ OPEN CHAT ============
function openChat(otherUserId) {
  // Prevent double-open / race conditions
  if (state.openingChat) return;
  state.openingChat = true;

  state.socket.emit('chat:start', otherUserId, (data) => {
    state.openingChat = false;

    if (!data || !data.chatId) {
      console.error('Failed to open chat');
      return;
    }

    state.currentChatId = data.chatId;
    state.currentOtherUser = data.otherUser;

    // Join socket room
    state.socket.emit('chat:open', data.chatId, () => {});

    // Update header UI
    if (data.otherUser) {
      setAvatarElement(chatAvatar, data.otherUser.display_name, data.otherUser.avatar_color, data.otherUser.avatar_url);
      chatName.textContent = data.otherUser.display_name;
      updateChatStatus();
    }

    // Clear reply state when switching chats
    clearReply();

    // Render messages
    renderMessages(data.messages || []);

    // Show chat
    chatEmpty.style.display = 'none';
    chatView.style.display = 'flex';
    scrollToBottom(false);

    // Hide search, update chat list
    hideSearch();
    loadChats();

    // Mobile: hide sidebar
    if (window.innerWidth <= 768) {
      sidebar.classList.add('hidden');
    }

    // Focus input
    messageInput.focus();
  });
}

// Render all messages from array (replaces existing)
function renderMessages(messages) {
  messagesList.innerHTML = '';
  let lastDate = '';
  messages.forEach(msg => {
    const msgDate = formatDate(msg.created_at);
    if (msgDate !== lastDate) {
      appendDateSeparator(msgDate);
      lastDate = msgDate;
    }
    appendMessage(msg);
  });
}

function updateChatStatus() {
  if (!state.currentOtherUser) return;
  if (state.currentOtherUser.is_online) {
    chatStatus.textContent = 'в сети';
    chatStatus.classList.add('online');
  } else {
    const lastSeen = state.currentOtherUser.last_seen;
    chatStatus.textContent = lastSeen ? `был(а) ${formatLastSeen(lastSeen)}` : 'не в сети';
    chatStatus.classList.remove('online');
  }
}

// ============ MESSAGES ============
function appendMessage(msg) {
  const isMine = msg.sender_id === state.user.id;
  const time = formatMessageTime(msg.created_at);

  let checkSvg = '';
  if (isMine) {
    if (msg.is_read) {
      checkSvg = `<span class="message-check read">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="1 12 5 16 12 6"/>
          <polyline points="7 12 11 16 18 6"/>
        </svg>
      </span>`;
    } else {
      checkSvg = `<span class="message-check">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 12 8 16 16 6"/>
        </svg>
      </span>`;
    }
  }

  // Reply preview inside message
  let replyHTML = '';
  if (msg.reply_to_id && msg.reply_sender_name) {
    const replyPreview = msg.reply_type === 'voice'
      ? '🎤 Голосовое сообщение'
      : escapeHtml((msg.reply_text || '').substring(0, 80));
    replyHTML = `
      <div class="message-reply" data-reply-id="${msg.reply_to_id}">
        <div class="message-reply-name">${escapeHtml(msg.reply_sender_name)}</div>
        <div class="message-reply-text">${replyPreview}</div>
      </div>`;
  }

  // Forward label (clickable to open original sender's profile)
  let forwardHTML = '';
  if (msg.forwarded_from) {
    const fwdClickable = msg.fwd_user_id ? ' clickable' : '';
    forwardHTML = `
      <div class="message-forward-label${fwdClickable}" data-fwd-user-id="${msg.fwd_user_id || ''}" data-fwd-username="${escapeHtml(msg.fwd_username || '')}" data-fwd-name="${escapeHtml(msg.fwd_display_name || msg.forwarded_from)}" data-fwd-color="${msg.fwd_avatar_color || '#5B9BD5'}" data-fwd-avatar="${escapeHtml(msg.fwd_avatar_url || '')}" data-fwd-online="${msg.fwd_is_online || false}" data-fwd-lastseen="${msg.fwd_last_seen || ''}">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>
        Переслано от ${escapeHtml(msg.forwarded_from)}
      </div>`;
  }

  let contentHTML;
  if (msg.type === 'voice') {
    if (msg.audio_data) {
      const duration = msg.audio_duration ? formatVoiceDuration(msg.audio_duration) : '0:00';
      const waveformBars = generateWaveformBars();
      contentHTML = `
        <div class="voice-player" data-audio="${msg.audio_data}" data-duration="${msg.audio_duration || 0}">
          <button class="voice-play-btn" onclick="toggleVoicePlay(this)">
            <svg class="voice-play-icon" viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
          </button>
          <div class="voice-progress-wrapper">
            <div class="voice-waveform">${waveformBars}</div>
            <div class="voice-progress-bar" onclick="seekVoice(event, this)">
              <div class="voice-progress-fill"></div>
            </div>
          </div>
          <span class="voice-duration">${duration}</span>
        </div>`;
    } else {
      contentHTML = `<div class="voice-expired">🎤 Голосовое сообщение удалено</div>`;
    }
  } else {
    contentHTML = `<div class="message-text">${linkify(escapeHtml(msg.text || ''))}</div>`;
  }

  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${isMine ? 'message-out' : 'message-in'}`;
  msgDiv.dataset.id = msg.id;
  msgDiv.dataset.senderId = msg.sender_id || '';
  msgDiv.dataset.sender = msg.sender_display_name || msg.sender_username || '';
  msgDiv.dataset.text = (msg.text || '').substring(0, 200);
  msgDiv.dataset.type = msg.type || 'text';
  msgDiv.innerHTML = `
      ${forwardHTML}
      ${replyHTML}
      ${contentHTML}
      <div class="message-meta">
        <span class="message-time">${time}</span>
        ${checkSvg}
      </div>`;

  messagesList.appendChild(msgDiv);
}

function appendDateSeparator(dateStr) {
  const html = `
    <div class="date-separator">
      <span>${dateStr}</span>
    </div>
  `;
  messagesList.insertAdjacentHTML('beforeend', html);
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !state.currentChatId) return;

  const payload = {
    chatId: state.currentChatId,
    text
  };

  if (state.replyTo) {
    payload.replyToId = state.replyTo.id;
  }

  state.socket.emit('message:send', payload);

  messageInput.value = '';
  clearReply();
  autoResizeInput();
  updateSendButton();
  messageInput.focus();

  // Stop typing
  state.socket.emit('typing:stop', state.currentChatId);
}

function scrollToBottom(smooth = true) {
  requestAnimationFrame(() => {
    messagesContainer.scrollTo({
      top: messagesContainer.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
  });
}

// ============ SEARCH ============
function handleSearch(query) {
  if (!query.trim()) {
    hideSearch();
    return;
  }

  clearTimeout(state.searchTimeout);
  state.searchTimeout = setTimeout(() => {
    state.socket.emit('users:search', query, (users) => {
      renderSearchResults(users);
    });
  }, 200);
}

function renderSearchResults(users) {
  if (users.length === 0) {
    searchResultsList.innerHTML = '<div class="empty-state"><p>Ничего не найдено</p></div>';
  } else {
    searchResultsList.innerHTML = users.map(u => `
      <div class="search-user-item" data-user-id="${u.id}">
        <div class="search-user-avatar" style="${getAvatarStyle(u.avatar_color, u.avatar_url)}">
          ${renderAvatarHTML(u.display_name, u.avatar_color, u.avatar_url)}
        </div>
        <div class="search-user-info">
          <div class="search-user-name">${escapeHtml(u.display_name)}</div>
          <div class="search-user-username">@${escapeHtml(u.username)}</div>
        </div>
      </div>
    `).join('');
  }
  searchResults.style.display = 'block';
}

function hideSearch() {
  searchResults.style.display = 'none';
  searchResultsList.innerHTML = '';
  searchInput.value = '';
}

// ============ EMOJI PICKER ============
const EMOJI_DATA = {
  'Смайлы': ['😀','😂','🤣','😊','😍','🥰','😘','😜','🤪','😎','🤩','🥳','😏','😒','😤','😡','🤬','😱','😨','😰','😢','😭','🥺','😩','😫','🤯','😳','🤗','🤔','🤫','🤭','🙄','😴','🤮','🤢','🤧','😷','🤒','🤕','😵','🥴','😇','🤠','🤑','😈','👻','💀','☠️','👽','🤖','💩','🤡'],
  'Жесты': ['👍','👎','👊','✊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✌️','🤞','🤟','🤘','👌','🤌','🤏','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤙','💪','🖕','✍️','🫶','❤️'],
  'Люди': ['😺','😸','😹','😻','😼','😽','🙀','😿','😾','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦅','🦆','🦉','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞'],
  'Еда': ['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🍆','🌽','🥕','🧄','🧅','🥔','🍕','🍔','🍟','🌭','🍿','🧂','🥚','🍳','🥓','🥩','🍗','🍖','🧀','🌮','🌯','🍣','🍱','🍩','🍪','🎂','🍰','🧁','🍫','🍬','🍭','☕','🍵','🧃','🍺','🍻','🥂','🍷'],
  'Предметы': ['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🎱','🏓','🏸','🥅','⛳','🎣','🎯','🥊','🎮','🕹️','🎲','🎭','🎨','🎬','🎤','🎧','🎵','🎶','🎹','🥁','🎷','🎺','🎸','💻','📱','💡','🔋','📷','📹','📺','📻','⏰','💰','💎','🔑','🔒','📌','✂️','📎','📝','📚'],
  'Символы': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','✅','❌','❓','❗','‼️','⁉️','💯','🔥','⭐','🌟','✨','💫','💥','💢','💤','🎉','🎊']
};

const emojiPicker = $('#emoji-picker');
const emojiGrid = $('#emoji-grid');
const emojiTabs = $('#emoji-tabs');
const emojiBtn = $('#emoji-btn');
let currentEmojiCategory = null;

function initEmojiPicker() {
  const categories = Object.keys(EMOJI_DATA);

  // Create tabs
  emojiTabs.innerHTML = categories.map((cat, i) => {
    const firstEmoji = EMOJI_DATA[cat][0];
    return `<button class="emoji-tab ${i === 0 ? 'active' : ''}" data-cat="${cat}" title="${cat}">${firstEmoji}</button>`;
  }).join('');

  // Show first category
  showEmojiCategory(categories[0]);

  // Tab clicks
  emojiTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.emoji-tab');
    if (!tab) return;
    emojiTabs.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    showEmojiCategory(tab.dataset.cat);
  });

  // Emoji clicks
  emojiGrid.addEventListener('click', (e) => {
    const item = e.target.closest('.emoji-item');
    if (!item) return;
    insertEmoji(item.textContent);
  });
}

function showEmojiCategory(cat) {
  if (currentEmojiCategory === cat) return;
  currentEmojiCategory = cat;
  const emojis = EMOJI_DATA[cat] || [];
  emojiGrid.innerHTML = emojis.map(e => `<button class="emoji-item">${e}</button>`).join('');
}

function insertEmoji(emoji) {
  const start = messageInput.selectionStart;
  const end = messageInput.selectionEnd;
  const text = messageInput.value;
  messageInput.value = text.substring(0, start) + emoji + text.substring(end);
  messageInput.selectionStart = messageInput.selectionEnd = start + emoji.length;
  messageInput.focus();
  updateSendButton();
  autoResizeInput();
}

function toggleEmojiPicker() {
  const isOpen = emojiPicker.style.display !== 'none';
  emojiPicker.style.display = isOpen ? 'none' : 'flex';
}

// ============ SIDE MENU ============
const sideMenu = $('#side-menu');
const sideMenuOverlay = $('#side-menu-overlay');
const menuBtn = $('#menu-btn');
const menuAvatar = $('#menu-avatar');
const menuName = $('#menu-name');
const menuUsername = $('#menu-username');

const profileModal = $('#profile-modal');
const profileAvatar = $('#profile-avatar');
const profileDisplayName = $('#profile-display-name');
const profileUsername = $('#profile-username');
const profileId = $('#profile-id');

const settingsModal = $('#settings-modal');

function openSideMenu() {
  if (!state.user) return;
  // Fill user info
  const displayName = state.user.displayName || state.user.display_name || '?';
  const avatarColor = state.user.avatarColor || state.user.avatar_color || '#5B9BD5';
  const avatarUrl = state.user.avatarUrl || state.user.avatar_url || null;
  setAvatarElement(menuAvatar, displayName, avatarColor, avatarUrl);
  menuName.textContent = displayName;
  menuUsername.textContent = '@' + (state.user.username || '');

  sideMenuOverlay.style.display = 'block';
  requestAnimationFrame(() => sideMenu.classList.add('open'));
}

function closeSideMenu() {
  sideMenu.classList.remove('open');
  setTimeout(() => { sideMenuOverlay.style.display = 'none'; }, 250);
}

function openProfileModal() {
  closeSideMenu();
  if (!state.user) return;

  const displayName = state.user.displayName || state.user.display_name || '?';
  const avatarColor = state.user.avatarColor || state.user.avatar_color || '#5B9BD5';
  const avatarUrl = state.user.avatarUrl || state.user.avatar_url || null;
  setAvatarElement(profileAvatar, displayName, avatarColor, avatarUrl);
  profileDisplayName.textContent = displayName;
  profileUsername.textContent = '@' + (state.user.username || '');
  profileId.textContent = state.user.id || '';

  profileModal.style.display = 'flex';
}

function openSettingsModal() {
  closeSideMenu();
  settingsModal.style.display = 'flex';
}

// ============ USER PROFILE (view other users) ============
const userProfileModal = $('#user-profile-modal');
const upAvatar = $('#up-avatar');
const upName = $('#up-name');
const upStatus = $('#up-status');
const upUsername = $('#up-username');
const upSendMessage = $('#up-send-message');
let userProfileTarget = null; // store user data for "send message" action

function openUserProfile(user) {
  if (!user) return;

  userProfileTarget = user;

  // Avatar
  const displayName = user.display_name || user.other_display_name || '?';
  const avatarColor = user.avatar_color || user.other_avatar_color || '#5B9BD5';
  const avatarUrl = user.avatar_url || user.other_avatar_url || null;
  setAvatarElement(upAvatar, displayName, avatarColor, avatarUrl);

  // Make avatar clickable if has image
  if (avatarUrl) {
    upAvatar.classList.add('has-image');
    upAvatar.onclick = () => openAvatarViewer(avatarUrl, displayName);
  } else {
    upAvatar.classList.remove('has-image');
    upAvatar.onclick = null;
  }

  // Name
  upName.textContent = displayName;

  // Username
  const username = user.username || user.other_username || '';
  upUsername.textContent = '@' + username;

  // Online status
  const isOnline = user.is_online || user.other_is_online || false;
  if (isOnline) {
    upStatus.textContent = 'в сети';
    upStatus.classList.add('online');
  } else {
    const lastSeen = user.last_seen || user.other_last_seen;
    upStatus.textContent = lastSeen ? `был(а) ${formatLastSeen(lastSeen)}` : 'не в сети';
    upStatus.classList.remove('online');
  }

  // Show/hide send message button based on context
  const userId = user.id || user.other_user_id;
  if (userId && userId !== state.user.id) {
    upSendMessage.style.display = 'flex';
  } else {
    upSendMessage.style.display = 'none';
  }

  userProfileModal.style.display = 'flex';
}

function closeUserProfile() {
  userProfileModal.style.display = 'none';
  userProfileTarget = null;
}

// ============ AVATAR VIEWER (fullscreen) ============
const avatarViewer = $('#avatar-viewer');
const avatarViewerImg = $('#avatar-viewer-img');
const avatarViewerName = $('#avatar-viewer-name');
const avatarViewerClose = $('#avatar-viewer-close');

function openAvatarViewer(imageUrl, name) {
  if (!imageUrl) return;
  avatarViewerImg.src = imageUrl;
  avatarViewerName.textContent = name || '';
  avatarViewer.style.display = 'flex';
}

function closeAvatarViewer() {
  avatarViewer.style.display = 'none';
  avatarViewerImg.src = '';
}

// ============ AVATAR UPLOAD ============
const avatarInput = $('#avatar-input');
const profileAvatarWrapper = $('#profile-avatar-wrapper');

function handleAvatarUpload(file) {
  if (!file || !file.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // Resize to max 200x200
      const canvas = document.createElement('canvas');
      const MAX = 200;
      let w = img.width, h = img.height;
      if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
      else { w = Math.round(w * MAX / h); h = MAX; }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      const base64 = canvas.toDataURL('image/jpeg', 0.8);
      uploadAvatar(base64);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function uploadAvatar(base64) {
  try {
    const res = await fetch('/api/avatar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + state.token
      },
      body: JSON.stringify({ avatar: base64 })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка загрузки');

    // Update local state
    state.user.avatarUrl = base64;
    state.user.avatar_url = base64;
    localStorage.setItem('user', JSON.stringify(state.user));

    // Update profile modal avatar
    setAvatarElement(profileAvatar, state.user.displayName || state.user.display_name, null, base64);

    // Broadcast via socket
    if (state.socket && state.socket.connected) {
      state.socket.emit('avatar:updated', base64);
    }

    // Reload chats so own chats update if needed
    loadChats();
  } catch (err) {
    console.error('Avatar upload error:', err);
    alert('Ошибка загрузки аватара: ' + err.message);
  }
}

// ============ EVENT LISTENERS ============
// ============ REPLY / FORWARD / CONTEXT MENU ============
function setReply(msgId, senderName, text, type) {
  state.replyTo = { id: msgId, senderName, text, type };
  replyBarName.textContent = senderName;
  replyBarText.textContent = type === 'voice' ? '🎤 Голосовое сообщение' : (text || '').substring(0, 80);
  replyBar.style.display = 'flex';
  messageInput.focus();
}

function clearReply() {
  state.replyTo = null;
  replyBar.style.display = 'none';
}

function showContextMenu(e, msgEl) {
  e.preventDefault();
  e.stopPropagation();
  hideContextMenu();

  const msgId = msgEl.dataset.id;
  const msgType = msgEl.dataset.type;
  const msgText = msgEl.dataset.text;
  const msgSender = msgEl.dataset.sender;
  const msgSenderId = msgEl.dataset.senderId;

  // For voice forwarding, grab audio data from the voice player
  let msgAudioData = null;
  let msgAudioDuration = null;
  const voicePlayer = msgEl.querySelector('.voice-player');
  if (voicePlayer) {
    msgAudioData = voicePlayer.dataset.audio || null;
    msgAudioDuration = parseFloat(voicePlayer.dataset.duration) || null;
  }

  state.contextMenuMsgId = msgId;
  msgContextMenu._msgData = { id: msgId, type: msgType, text: msgText, sender: msgSender, senderId: msgSenderId, audioData: msgAudioData, audioDuration: msgAudioDuration };

  // Show/hide copy based on message type
  ctxCopy.style.display = msgType === 'voice' ? 'none' : 'flex';

  msgContextMenu.style.display = 'block';

  // Position
  const menuW = msgContextMenu.offsetWidth;
  const menuH = msgContextMenu.offsetHeight;
  let x = e.clientX || e.touches?.[0]?.clientX || 0;
  let y = e.clientY || e.touches?.[0]?.clientY || 0;

  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
  if (x < 8) x = 8;
  if (y < 8) y = 8;

  msgContextMenu.style.left = x + 'px';
  msgContextMenu.style.top = y + 'px';
}

function hideContextMenu() {
  msgContextMenu.style.display = 'none';
  state.contextMenuMsgId = null;
}

function handleCtxReply() {
  const d = msgContextMenu._msgData;
  if (d) setReply(d.id, d.sender, d.text, d.type);
  hideContextMenu();
}

function handleCtxCopy() {
  const d = msgContextMenu._msgData;
  if (d && d.text) {
    navigator.clipboard.writeText(d.text).catch(() => {});
  }
  hideContextMenu();
}

function handleCtxForward() {
  const d = msgContextMenu._msgData;
  if (!d) return;
  state.forwardMsg = d;
  hideContextMenu();
  openForwardModal();
}

function openForwardModal() {
  forwardChatList.innerHTML = '';
  // Show all chats
  state.chats.forEach(chat => {
    const name = chat.other_display_name || chat.other_username;
    const color = chat.other_avatar_color || '#5B9BD5';
    const avatarUrl = chat.other_avatar_url;
    const avatarHTML = avatarUrl
      ? `<div class="forward-chat-avatar"><img class="avatar-img" src="${avatarUrl}"></div>`
      : `<div class="forward-chat-avatar" style="background:${color}">${(name || '?')[0].toUpperCase()}</div>`;

    forwardChatList.insertAdjacentHTML('beforeend', `
      <div class="forward-chat-item" data-chat-id="${chat.chat_id}" data-user-id="${chat.other_user_id}">
        ${avatarHTML}
        <div class="forward-chat-name">${escapeHtml(name)}</div>
      </div>
    `);
  });
  forwardModal.style.display = 'flex';
}

function closeForwardModal() {
  forwardModal.style.display = 'none';
  state.forwardMsg = null;
}

function handleForwardSelect(chatId, targetUserId) {
  const fwd = state.forwardMsg;
  if (!fwd) return;

  const targetChatId = chatId;
  const senderName = fwd.sender;
  const senderId = fwd.senderId;

  const payload = {
    chatId: targetChatId,
    forwardedFrom: senderName,
    forwardedFromId: senderId
  };

  // Forward voice messages with audio data intact
  if (fwd.type === 'voice' && fwd.audioData) {
    payload.type = 'voice';
    payload.audioData = fwd.audioData;
    payload.audioDuration = fwd.audioDuration;
  } else {
    payload.text = fwd.text || '';
  }

  state.socket.emit('message:send', payload);

  closeForwardModal();

  // Open that chat if different
  if (targetChatId !== state.currentChatId) {
    openChat(targetUserId);
  }
}

function scrollToMessage(msgId) {
  const el = messagesList.querySelector(`.message[data-id="${msgId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('message-highlight');
    setTimeout(() => el.classList.remove('message-highlight'), 1600);
  }
}

// Long press for mobile
let longPressTimer = null;
let longPressTarget = null;

function onMsgTouchStart(e) {
  const msgEl = e.target.closest('.message');
  if (!msgEl) return;
  // Don't interfere with voice play buttons
  if (e.target.closest('.voice-play-btn') || e.target.closest('.voice-progress-bar')) return;
  longPressTarget = msgEl;
  longPressTimer = setTimeout(() => {
    showContextMenu(e, msgEl);
    longPressTarget = null;
  }, 500);
}

function onMsgTouchEnd() {
  clearTimeout(longPressTimer);
  longPressTarget = null;
}

function onMsgTouchMove() {
  clearTimeout(longPressTimer);
  longPressTarget = null;
}

// ============ SWIPE TO REPLY (mobile) ============
let swipeStartX = null;
let swipeMsgEl = null;

function setupEventListeners() {
  // Auth
  authForm.addEventListener('submit', handleAuth);
  authSwitchLink.addEventListener('click', (e) => {
    e.preventDefault();
    toggleAuthMode();
  });

  // Side menu
  menuBtn.addEventListener('click', openSideMenu);
  sideMenuOverlay.addEventListener('click', closeSideMenu);

  $('#menu-profile').addEventListener('click', openProfileModal);
  $('#menu-settings').addEventListener('click', openSettingsModal);
  $('#menu-contacts').addEventListener('click', () => {
    closeSideMenu();
    searchInput.focus();
  });
  $('#menu-logout').addEventListener('click', () => {
    closeSideMenu();
    logout();
  });

  // Avatar upload
  profileAvatarWrapper.addEventListener('click', () => { avatarInput.click(); });
  avatarInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleAvatarUpload(e.target.files[0]);
      avatarInput.value = ''; // reset so same file can be re-selected
    }
  });

  // View other user's profile — click on chat header
  chatAvatar.addEventListener('click', () => {
    if (state.currentOtherUser) openUserProfile(state.currentOtherUser);
  });
  $('.chat-header-info').addEventListener('click', () => {
    if (state.currentOtherUser) openUserProfile(state.currentOtherUser);
  });

  // User profile modal
  $('#user-profile-close').addEventListener('click', closeUserProfile);
  userProfileModal.addEventListener('click', (e) => { if (e.target === userProfileModal) closeUserProfile(); });

  // Avatar viewer
  avatarViewerClose.addEventListener('click', closeAvatarViewer);
  $('.avatar-viewer-backdrop').addEventListener('click', closeAvatarViewer);
  upSendMessage.addEventListener('click', () => {
    const userId = userProfileTarget?.id || userProfileTarget?.other_user_id;
    if (userId) {
      closeUserProfile();
      openChat(userId);
    }
  });

  // Close modals
  $('#profile-close').addEventListener('click', () => { profileModal.style.display = 'none'; });
  $('#settings-close').addEventListener('click', () => { settingsModal.style.display = 'none'; });
  profileModal.addEventListener('click', (e) => { if (e.target === profileModal) profileModal.style.display = 'none'; });
  settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.style.display = 'none'; });

  // Search
  searchInput.addEventListener('input', (e) => {
    handleSearch(e.target.value);
  });

  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim()) {
      handleSearch(searchInput.value);
    }
  });

  // Click search result
  searchResultsList.addEventListener('click', (e) => {
    const item = e.target.closest('.search-user-item');
    if (item) {
      openChat(item.dataset.userId);
    }
  });

  // Click chat item
  chatList.addEventListener('click', (e) => {
    const item = e.target.closest('.chat-item');
    if (item) {
      openChat(item.dataset.userId);
    }
  });

  // Emoji picker
  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleEmojiPicker();
  });

  // Close emoji picker, search, context menu on click outside
  document.addEventListener('click', (e) => {
    // Close context menu
    if (msgContextMenu.style.display !== 'none' && !msgContextMenu.contains(e.target)) {
      hideContextMenu();
    }
    // Close emoji picker
    if (emojiPicker.style.display !== 'none' && !emojiPicker.contains(e.target) && !emojiBtn.contains(e.target)) {
      emojiPicker.style.display = 'none';
    }
    // Close search
    if (!searchResults.contains(e.target) && !searchInput.contains(e.target)) {
      if (searchResults.style.display === 'block') {
        hideSearch();
      }
    }
  });

  // Call buttons
  $('#call-btn').addEventListener('click', initiateCall);
  $('#call-out-cancel').addEventListener('click', cancelOutgoingCall);
  $('#call-in-accept').addEventListener('click', acceptCall);
  $('#call-in-reject').addEventListener('click', rejectCall);
  $('#call-end').addEventListener('click', endActiveCall);
  callMuteBtn.addEventListener('click', toggleMute);
  callSpeakerBtn.addEventListener('click', toggleSpeaker);

  // Reply bar close
  replyBarClose.addEventListener('click', clearReply);

  // Context menu actions
  ctxReply.addEventListener('click', handleCtxReply);
  ctxForward.addEventListener('click', handleCtxForward);
  ctxCopy.addEventListener('click', handleCtxCopy);

  // Right-click on messages
  messagesList.addEventListener('contextmenu', (e) => {
    const msgEl = e.target.closest('.message');
    if (msgEl) showContextMenu(e, msgEl);
  });

  // Long press on messages (mobile)
  messagesList.addEventListener('touchstart', onMsgTouchStart, { passive: true });
  messagesList.addEventListener('touchend', onMsgTouchEnd);
  messagesList.addEventListener('touchmove', onMsgTouchMove);

  // Click on reply inside message — scroll to original
  // Click on forward label — open original sender's profile
  messagesList.addEventListener('click', (e) => {
    const replyEl = e.target.closest('.message-reply');
    if (replyEl) {
      scrollToMessage(replyEl.dataset.replyId);
      return;
    }

    const fwdEl = e.target.closest('.message-forward-label.clickable');
    if (fwdEl) {
      const fwdUserId = fwdEl.dataset.fwdUserId;
      if (fwdUserId) {
        openUserProfile({
          id: fwdUserId,
          username: fwdEl.dataset.fwdUsername,
          display_name: fwdEl.dataset.fwdName,
          avatar_color: fwdEl.dataset.fwdColor,
          avatar_url: fwdEl.dataset.fwdAvatar || null,
          is_online: fwdEl.dataset.fwdOnline === 'true',
          last_seen: fwdEl.dataset.fwdLastseen || null
        });
      }
    }
  });

  // Forward modal
  forwardClose.addEventListener('click', closeForwardModal);
  forwardModal.addEventListener('click', (e) => { if (e.target === forwardModal) closeForwardModal(); });
  forwardChatList.addEventListener('click', (e) => {
    const item = e.target.closest('.forward-chat-item');
    if (item) {
      handleForwardSelect(item.dataset.chatId, item.dataset.userId);
    }
  });

  // Voice recording
  micBtn.addEventListener('click', () => {
    if (!state.currentChatId) return;
    startRecording();
  });
  voiceCancelBtn.addEventListener('click', () => stopRecording(false));
  voiceSendBtn.addEventListener('click', () => stopRecording(true));

  // Send message
  sendBtn.addEventListener('click', sendMessage);

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto resize input
  messageInput.addEventListener('input', () => {
    autoResizeInput();
    updateSendButton();

    // Typing indicator
    if (state.currentChatId && state.socket && state.socket.connected) {
      state.socket.emit('typing:start', state.currentChatId);
      clearTimeout(state.typingTimeout);
      state.typingTimeout = setTimeout(() => {
        if (state.socket && state.socket.connected) {
          state.socket.emit('typing:stop', state.currentChatId);
        }
      }, 2000);
    }
  });

  // Back button (mobile)
  backBtn.addEventListener('click', () => {
    sidebar.classList.remove('hidden');
    state.currentChatId = null;
    state.currentOtherUser = null;
    clearReply();
    chatView.style.display = 'none';
    chatEmpty.style.display = 'flex';
    loadChats();
  });

  // Handle escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (msgContextMenu.style.display !== 'none') {
        hideContextMenu();
      } else if (forwardModal.style.display !== 'none') {
        closeForwardModal();
      } else if (avatarViewer.style.display !== 'none') {
        closeAvatarViewer();
      } else if (userProfileModal.style.display !== 'none') {
        closeUserProfile();
      } else if (state.replyTo) {
        clearReply();
      } else if (searchResults.style.display === 'block') {
        hideSearch();
      }
    }
  });
}

function autoResizeInput() {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
}

function updateSendButton() {
  const inputArea = messageInput.closest('.message-input-area');
  if (messageInput.value.trim()) {
    sendBtn.classList.add('active');
    inputArea.classList.add('has-text');
  } else {
    sendBtn.classList.remove('active');
    inputArea.classList.remove('has-text');
  }
}

// ============ VOICE CALLS ============
const ICE_SERVERS = {
  iceServers: [
    // STUN
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // TURN (free relay — needed when direct P2P fails behind NAT)
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  iceCandidatePoolSize: 10
};

const callOutgoing = $('#call-outgoing');
const callIncoming = $('#call-incoming');
const callActive = $('#call-active');
const callOutAvatar = $('#call-out-avatar');
const callOutName = $('#call-out-name');
const callOutStatus = $('#call-out-status');
const callInAvatar = $('#call-in-avatar');
const callInName = $('#call-in-name');
const callActiveAvatar = $('#call-active-avatar');
const callActiveName = $('#call-active-name');
const callActiveTimer = $('#call-active-timer');
const callMuteBtn = $('#call-mute');
const callSpeakerBtn = $('#call-speaker');

function initiateCall() {
  if (!state.currentOtherUser || state.callState !== 'idle') return;
  if (!state.socket || !state.socket.connected) return;

  const user = state.currentOtherUser;
  state.callPeer = {
    id: user.id,
    name: user.display_name,
    avatarColor: user.avatar_color,
    avatarUrl: user.avatar_url || null
  };
  state.callState = 'outgoing';

  state.socket.emit('call:initiate', { targetUserId: user.id }, (res) => {
    if (res && res.error) {
      state.callState = 'idle';
      state.callPeer = null;
      showCallToast(res.error);
      return;
    }
    showOutgoingCall();
  });
}

function showOutgoingCall() {
  setAvatarElement(callOutAvatar, state.callPeer.name, state.callPeer.avatarColor, state.callPeer.avatarUrl);
  callOutName.textContent = state.callPeer.name;
  callOutStatus.textContent = 'Вызов...';
  callOutgoing.style.display = 'flex';
}

function showIncomingCall() {
  state.callState = 'incoming';
  setAvatarElement(callInAvatar, state.callPeer.name, state.callPeer.avatarColor, state.callPeer.avatarUrl);
  callInName.textContent = state.callPeer.name;
  callIncoming.style.display = 'flex';
  playRingtone();
}

async function acceptCall() {
  if (state.callState !== 'incoming') return;
  stopRingtone();
  callIncoming.style.display = 'none';

  // IMPORTANT: Set up WebRTC FIRST, then tell caller we're ready
  await startWebRTC(false);

  // Now signal to caller that we're ready to receive the offer
  state.socket.emit('call:accept', { targetUserId: state.callPeer.id });
}

function rejectCall() {
  if (state.callState !== 'incoming') return;
  stopRingtone();
  state.socket.emit('call:reject', { targetUserId: state.callPeer.id });
  endCallCleanup();
}

function cancelOutgoingCall() {
  if (state.callState !== 'outgoing') return;
  state.socket.emit('call:end', { targetUserId: state.callPeer.id });
  endCallCleanup();
}

function endActiveCall() {
  if (state.callState !== 'active' && state.callState !== 'outgoing') return;
  if (state.callPeer) {
    state.socket.emit('call:end', { targetUserId: state.callPeer.id });
  }
  endCallCleanup();
}

async function handleOffer(from, offer) {
  if (!state.peerConnection) return;
  try {
    await state.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);
    state.socket.emit('call:answer', { targetUserId: from, answer });
    console.log('Sent answer to', from);
  } catch (err) {
    console.error('Error handling offer:', err);
  }
}

async function startWebRTC(isCaller, forceRelay = false) {
  try {
    // Reset buffers
    state.pendingOffer = null;
    state.pendingCandidates = [];
    state.callRetried = state.callRetried || false;

    // Get microphone (reuse if already have it from retry)
    if (!state.localStream) {
      console.log('Requesting microphone...');
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('Microphone acquired');
    }

    // Close old peer connection if retrying
    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }

    // Build ICE config — force relay mode on retry
    const iceConfig = { ...ICE_SERVERS };
    if (forceRelay) {
      iceConfig.iceTransportPolicy = 'relay';
      console.log('FORCED RELAY MODE — all traffic via TURN');
    }

    // Create peer connection
    state.peerConnection = new RTCPeerConnection(iceConfig);
    console.log('PeerConnection created, relay:', forceRelay);

    // Add local audio tracks
    state.localStream.getTracks().forEach(track => {
      state.peerConnection.addTrack(track, state.localStream);
    });

    // Handle remote stream
    state.peerConnection.ontrack = (event) => {
      console.log('Remote track received');
      const old = document.getElementById('remote-audio');
      if (old) old.remove();

      const remoteAudio = document.createElement('audio');
      remoteAudio.id = 'remote-audio';
      remoteAudio.autoplay = true;
      remoteAudio.srcObject = event.streams[0];
      document.body.appendChild(remoteAudio);
      remoteAudio.play().catch(e => console.log('Audio play error:', e));
    };

    // ICE candidates — send to peer
    state.peerConnection.onicecandidate = (event) => {
      if (event.candidate && state.callPeer) {
        console.log('ICE candidate type:', event.candidate.type, event.candidate.protocol);
        state.socket.emit('call:ice-candidate', {
          targetUserId: state.callPeer.id,
          candidate: event.candidate
        });
      }
    };

    // ICE connection state
    state.peerConnection.oniceconnectionstatechange = () => {
      const iceState = state.peerConnection?.iceConnectionState;
      console.log('ICE state:', iceState, '| relay:', forceRelay);

      if (iceState === 'connected' || iceState === 'completed') {
        if (!state.callStartTime) {
          state.callStartTime = Date.now();
          if (state.callTimer) clearInterval(state.callTimer);
          state.callTimer = setInterval(updateCallTimer, 1000);
          callActiveTimer.textContent = '00:00';
          console.log('CALL CONNECTED' + (forceRelay ? ' (via TURN relay)' : ' (direct)'));
        }
      } else if (iceState === 'checking') {
        callActiveTimer.textContent = forceRelay ? 'Подключение через relay...' : 'Подключение...';
      } else if (iceState === 'failed') {
        console.error('ICE failed, relay:', forceRelay, 'retried:', state.callRetried);

        // AUTO-RETRY: if first attempt failed, retry with forced TURN relay
        if (!forceRelay && !state.callRetried && isCaller) {
          console.log('Direct connection failed — retrying with TURN relay...');
          callActiveTimer.textContent = 'Повтор через relay...';
          state.callRetried = true;
          // Re-negotiate with forced relay
          startWebRTC(true, true);
          return;
        }

        showCallToast('Не удалось установить соединение');
        endActiveCall();
      } else if (iceState === 'disconnected') {
        callActiveTimer.textContent = 'Переподключение...';
        setTimeout(() => {
          if (state.peerConnection?.iceConnectionState === 'disconnected') {
            // Try ICE restart before giving up
            if (state.peerConnection && isCaller) {
              console.log('Attempting ICE restart...');
              state.peerConnection.restartIce();
              state.peerConnection.createOffer({ iceRestart: true }).then(offer => {
                state.peerConnection.setLocalDescription(offer);
                state.socket.emit('call:offer', { targetUserId: state.callPeer.id, offer });
              }).catch(() => {});
              // Give restart 5 more seconds
              setTimeout(() => {
                if (state.peerConnection?.iceConnectionState === 'disconnected') {
                  endActiveCall();
                  showCallToast('Соединение потеряно');
                }
              }, 5000);
            } else {
              endActiveCall();
              showCallToast('Соединение потеряно');
            }
          }
        }, 5000);
      }
    };

    // Log gathered ICE candidate types for debugging
    let candidateTypes = new Set();
    state.peerConnection.onicegatheringstatechange = () => {
      const gs = state.peerConnection?.iceGatheringState;
      console.log('ICE gathering:', gs);
      if (gs === 'complete') {
        console.log('Candidate types gathered:', [...candidateTypes]);
        if (!candidateTypes.has('relay') && !forceRelay) {
          console.warn('No TURN relay candidates gathered — TURN servers may not be reachable');
        }
      }
    };

    // Track candidate types
    const origOnIceCandidate = state.peerConnection.onicecandidate;
    state.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        candidateTypes.add(event.candidate.type);
      }
      origOnIceCandidate(event);
    };

    // Show active call UI (only on first attempt)
    if (state.callState !== 'active') {
      showActiveCall();
    }

    // Apply buffered ICE candidates
    if (state.pendingCandidates && state.pendingCandidates.length > 0) {
      console.log(`Applying ${state.pendingCandidates.length} buffered ICE candidates`);
      for (const c of state.pendingCandidates) {
        try { await state.peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { }
      }
      state.pendingCandidates = [];
    }

    // Apply buffered offer
    if (!isCaller && state.pendingOffer) {
      console.log('Applying buffered offer');
      await handleOffer(state.pendingOffer.from, state.pendingOffer.offer);
      state.pendingOffer = null;
    }

    if (isCaller) {
      const offer = await state.peerConnection.createOffer();
      await state.peerConnection.setLocalDescription(offer);
      state.socket.emit('call:offer', {
        targetUserId: state.callPeer.id,
        offer
      });
      console.log('Offer sent, relay:', forceRelay);
    }

    // Timeout
    const timeout = forceRelay ? 15000 : 12000;
    setTimeout(() => {
      if (state.peerConnection && state.callState === 'active' && !state.callStartTime) {
        const iceState = state.peerConnection.iceConnectionState;
        if (iceState !== 'connected' && iceState !== 'completed') {
          // On first attempt, try relay before giving up
          if (!forceRelay && !state.callRetried && isCaller) {
            console.log('Timeout — retrying with TURN relay...');
            callActiveTimer.textContent = 'Повтор через relay...';
            state.callRetried = true;
            startWebRTC(true, true);
            return;
          }
          console.error('Call timeout. ICE state:', iceState);
          showCallToast('Не удалось подключиться');
          endActiveCall();
        }
      }
    }, timeout);

  } catch (err) {
    console.error('WebRTC error:', err);
    endActiveCall();
    showCallToast('Не удалось начать звонок: ' + err.message);
  }
}

function showActiveCall() {
  state.callState = 'active';
  callOutgoing.style.display = 'none';
  callIncoming.style.display = 'none';

  setAvatarElement(callActiveAvatar, state.callPeer.name, state.callPeer.avatarColor, state.callPeer.avatarUrl);
  callActiveName.textContent = state.callPeer.name;
  callActiveTimer.textContent = 'Подключение...';

  // Timer starts only when ICE connects (see oniceconnectionstatechange)
  state.callStartTime = null;
  state.isMuted = false;
  state.isSpeaker = false;
  callMuteBtn.classList.remove('active');
  callSpeakerBtn.classList.remove('active');

  callActive.style.display = 'flex';
}

function updateCallTimer() {
  if (!state.callStartTime) return;
  const elapsed = Math.floor((Date.now() - state.callStartTime) / 1000);
  const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const secs = (elapsed % 60).toString().padStart(2, '0');
  callActiveTimer.textContent = `${mins}:${secs}`;
}

function endCallCleanup() {
  stopRingtone();

  if (state.peerConnection) {
    state.peerConnection.close();
    state.peerConnection = null;
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }

  const remoteAudio = document.getElementById('remote-audio');
  if (remoteAudio) remoteAudio.remove();

  if (state.callTimer) {
    clearInterval(state.callTimer);
    state.callTimer = null;
  }

  state.callState = 'idle';
  state.callPeer = null;
  state.callStartTime = null;
  state.isMuted = false;
  state.isSpeaker = false;
  state.pendingOffer = null;
  state.pendingCandidates = [];
  state.callRetried = false;

  callOutgoing.style.display = 'none';
  callIncoming.style.display = 'none';
  callActive.style.display = 'none';
}

function toggleMute() {
  if (!state.localStream) return;
  state.isMuted = !state.isMuted;
  state.localStream.getAudioTracks().forEach(t => { t.enabled = !state.isMuted; });
  callMuteBtn.classList.toggle('active', state.isMuted);
}

function toggleSpeaker() {
  state.isSpeaker = !state.isSpeaker;
  callSpeakerBtn.classList.toggle('active', state.isSpeaker);
  const remoteAudio = document.getElementById('remote-audio');
  if (remoteAudio) {
    remoteAudio.volume = state.isSpeaker ? 1.0 : 0.7;
  }
}

// Simple ringtone using Web Audio API
let ringtoneCtx = null;
let ringtoneInterval = null;

function playRingtone() {
  try {
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    function beep() {
      if (!ringtoneCtx) return;
      const osc = ringtoneCtx.createOscillator();
      const gain = ringtoneCtx.createGain();
      osc.connect(gain);
      gain.connect(ringtoneCtx.destination);
      osc.frequency.value = 440;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ringtoneCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ringtoneCtx.currentTime + 0.5);
      osc.start(ringtoneCtx.currentTime);
      osc.stop(ringtoneCtx.currentTime + 0.5);
    }
    beep();
    ringtoneInterval = setInterval(beep, 2000);
  } catch (e) {
    console.log('Ringtone not supported');
  }
}

function stopRingtone() {
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval);
    ringtoneInterval = null;
  }
  if (ringtoneCtx) {
    ringtoneCtx.close().catch(() => {});
    ringtoneCtx = null;
  }
}

function showCallToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:white;padding:10px 24px;border-radius:20px;font-size:14px;z-index:4000;animation:callFadeIn 0.3s ease;';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ============ VOICE RECORDING ============
const micBtn = $('#mic-btn');
const voiceRecordingOverlay = $('#voice-recording-overlay');
const voiceCancelBtn = $('#voice-cancel-btn');
const voiceSendBtn = $('#voice-send-btn');
const voiceRecordingTimer = $('#voice-recording-timer');

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Try to use webm/opus, fall back to whatever is available
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

    state.mediaRecorder = new MediaRecorder(stream, { mimeType });
    state.audioChunks = [];
    state.isRecording = true;
    state.recordingStartTime = Date.now();

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        state.audioChunks.push(e.data);
      }
    };

    state.mediaRecorder.onstop = () => {
      // Stop all tracks
      stream.getTracks().forEach(t => t.stop());
    };

    state.mediaRecorder.start(100); // Collect data every 100ms

    // Show recording UI
    voiceRecordingOverlay.style.display = 'flex';
    updateRecordingTimer();
    state.recordingTimer = setInterval(updateRecordingTimer, 100);

  } catch (err) {
    console.error('Microphone access error:', err);
    alert('Не удалось получить доступ к микрофону. Проверьте разрешения.');
  }
}

function updateRecordingTimer() {
  if (!state.recordingStartTime) return;
  const elapsed = (Date.now() - state.recordingStartTime) / 1000;
  const mins = Math.floor(elapsed / 60);
  const secs = Math.floor(elapsed % 60);
  voiceRecordingTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
}

function stopRecording(send = false) {
  if (!state.mediaRecorder || !state.isRecording) return;

  clearInterval(state.recordingTimer);
  state.recordingTimer = null;
  const duration = (Date.now() - state.recordingStartTime) / 1000;

  if (send && duration >= 0.5) {
    // We need to wait for the final data
    state.mediaRecorder.onstop = () => {
      // Stop tracks
      state.mediaRecorder.stream.getTracks().forEach(t => t.stop());

      const blob = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType });
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result; // data:audio/webm;...
        sendVoiceMessage(base64, Math.round(duration * 10) / 10);
      };
      reader.readAsDataURL(blob);
    };
  } else {
    // Cancel — just stop tracks
    const origOnStop = state.mediaRecorder.onstop;
    state.mediaRecorder.onstop = () => {
      state.mediaRecorder.stream.getTracks().forEach(t => t.stop());
    };
  }

  state.mediaRecorder.stop();
  state.isRecording = false;
  state.recordingStartTime = null;
  voiceRecordingOverlay.style.display = 'none';
  voiceRecordingTimer.textContent = '0:00';
}

function sendVoiceMessage(base64Audio, duration) {
  if (!state.currentChatId || !state.socket || !state.socket.connected) return;

  state.socket.emit('message:send', {
    chatId: state.currentChatId,
    type: 'voice',
    audioData: base64Audio,
    audioDuration: duration
  });
}

// ============ VOICE PLAYER ============
let currentPlayingAudio = null;
let currentPlayingBtn = null;
let currentProgressFill = null;
let currentDurationEl = null;

function toggleVoicePlay(btn) {
  const player = btn.closest('.voice-player');
  const audioSrc = player.dataset.audio;
  const totalDuration = parseFloat(player.dataset.duration) || 0;
  const progressFill = player.querySelector('.voice-progress-fill');
  const durationEl = player.querySelector('.voice-duration');
  const playIcon = btn.querySelector('.voice-play-icon');

  // If same button clicked and audio is playing, pause
  if (currentPlayingBtn === btn && currentPlayingAudio && !currentPlayingAudio.paused) {
    currentPlayingAudio.pause();
    playIcon.innerHTML = '<path fill="currentColor" d="M8 5v14l11-7z"/>';
    return;
  }

  // If different audio is playing, stop it first
  if (currentPlayingAudio && !currentPlayingAudio.paused) {
    currentPlayingAudio.pause();
    currentPlayingAudio.currentTime = 0;
    if (currentPlayingBtn) {
      currentPlayingBtn.querySelector('.voice-play-icon').innerHTML = '<path fill="currentColor" d="M8 5v14l11-7z"/>';
    }
    if (currentProgressFill) currentProgressFill.style.width = '0%';
    if (currentDurationEl && currentPlayingBtn) {
      const origDur = parseFloat(currentPlayingBtn.closest('.voice-player').dataset.duration) || 0;
      currentDurationEl.textContent = formatVoiceDuration(origDur);
    }
  }

  // If we already have audio for this button and it's paused, resume
  if (currentPlayingBtn === btn && currentPlayingAudio && currentPlayingAudio.paused) {
    currentPlayingAudio.play();
    playIcon.innerHTML = '<path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    return;
  }

  // Create new audio
  const audio = new Audio(audioSrc);
  currentPlayingAudio = audio;
  currentPlayingBtn = btn;
  currentProgressFill = progressFill;
  currentDurationEl = durationEl;

  // Activate waveform bars
  const waveform = player.querySelector('.voice-waveform');
  const bars = waveform ? waveform.querySelectorAll('.voice-waveform-bar') : [];

  audio.addEventListener('timeupdate', () => {
    if (audio.duration && isFinite(audio.duration)) {
      const pct = (audio.currentTime / audio.duration) * 100;
      progressFill.style.width = pct + '%';
      durationEl.textContent = formatVoiceDuration(audio.currentTime);

      // Update waveform active bars
      const activePct = audio.currentTime / audio.duration;
      bars.forEach((bar, i) => {
        if (i / bars.length <= activePct) {
          bar.classList.add('active');
        } else {
          bar.classList.remove('active');
        }
      });
    }
  });

  audio.addEventListener('ended', () => {
    playIcon.innerHTML = '<path fill="currentColor" d="M8 5v14l11-7z"/>';
    progressFill.style.width = '0%';
    durationEl.textContent = formatVoiceDuration(totalDuration);
    bars.forEach(b => b.classList.remove('active'));
    currentPlayingAudio = null;
    currentPlayingBtn = null;
  });

  audio.play();
  playIcon.innerHTML = '<path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
}

function seekVoice(event, progressBar) {
  if (!currentPlayingAudio || currentPlayingBtn !== progressBar.closest('.voice-player').querySelector('.voice-play-btn')) return;
  const rect = progressBar.getBoundingClientRect();
  const pct = (event.clientX - rect.left) / rect.width;
  if (currentPlayingAudio.duration && isFinite(currentPlayingAudio.duration)) {
    currentPlayingAudio.currentTime = pct * currentPlayingAudio.duration;
  }
}

function formatVoiceDuration(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function generateWaveformBars() {
  const count = 32;
  let html = '';
  for (let i = 0; i < count; i++) {
    // Generate pseudo-random heights for visual interest
    const h = 6 + Math.floor(Math.sin(i * 0.8) * 8 + Math.cos(i * 1.3) * 6 + 10);
    html += `<div class="voice-waveform-bar" style="height:${h}px"></div>`;
  }
  return html;
}

// ============ AVATAR HELPERS ============
function renderAvatarHTML(displayName, avatarColor, avatarUrl) {
  if (avatarUrl) {
    return `<img src="${avatarUrl}" class="avatar-img" alt="">`;
  }
  return getInitials(displayName);
}

function getAvatarStyle(avatarColor, avatarUrl) {
  if (avatarUrl) return 'background:transparent';
  return `background:${avatarColor}`;
}

function setAvatarElement(el, displayName, avatarColor, avatarUrl) {
  if (avatarUrl) {
    el.innerHTML = `<img src="${avatarUrl}" class="avatar-img" alt="">`;
    el.style.background = 'transparent';
  } else {
    el.textContent = getInitials(displayName);
    el.style.background = avatarColor || '#5B9BD5';
  }
}

// ============ HELPERS ============
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function linkify(text) {
  const urlPattern = /(https?:\/\/[^\s<]+)/g;
  return text.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (!isNaN(d)) return d;
  return new Date(dateStr.replace(' ', 'T') + 'Z');
}

function formatTime(dateStr) {
  const date = parseDate(dateStr);
  if (!date) return '';
  const now = new Date();
  const diff = now - date;
  const oneDay = 86400000;

  if (diff < oneDay && date.getDate() === now.getDate()) {
    return date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  } else if (diff < oneDay * 7) {
    return date.toLocaleDateString('ru', { weekday: 'short' });
  } else {
    return date.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
  }
}

function formatMessageTime(dateStr) {
  const date = parseDate(dateStr);
  if (!date) return '';
  return date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateStr) {
  const date = parseDate(dateStr);
  if (!date) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today - 86400000);
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (msgDay.getTime() === today.getTime()) return 'Сегодня';
  if (msgDay.getTime() === yesterday.getTime()) return 'Вчера';
  return date.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatLastSeen(dateStr) {
  const date = parseDate(dateStr);
  if (!date) return '';
  const now = new Date();
  const diff = (now - date) / 1000;

  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин. назад`;
  if (diff < 86400) return `сегодня в ${date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`;
  if (diff < 172800) return `вчера в ${date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`;
  return date.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

// ============ START ============
init();
