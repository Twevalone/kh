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
    // Update current chat header if it's this user
    if (state.currentOtherUser && state.currentOtherUser.id === userId) {
      state.currentOtherUser.avatar_url = avatarUrl;
      setAvatarElement(chatAvatar, state.currentOtherUser.display_name, state.currentOtherUser.avatar_color, avatarUrl);
    }
    // Refresh chat list to show updated avatars
    loadChats();
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

  const html = `
    <div class="message ${isMine ? 'message-out' : 'message-in'}" data-id="${msg.id}">
      ${contentHTML}
      <div class="message-meta">
        <span class="message-time">${time}</span>
        ${checkSvg}
      </div>
    </div>
  `;

  messagesList.insertAdjacentHTML('beforeend', html);
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

  state.socket.emit('message:send', {
    chatId: state.currentChatId,
    text
  });

  messageInput.value = '';
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

  // Close emoji picker and search on click outside
  document.addEventListener('click', (e) => {
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
    chatView.style.display = 'none';
    chatEmpty.style.display = 'flex';
    loadChats();
  });

  // Handle escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (avatarViewer.style.display !== 'none') {
        closeAvatarViewer();
      } else if (userProfileModal.style.display !== 'none') {
        closeUserProfile();
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
