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

  // Messages read
  state.socket.on('messages:read', ({ chatId, readBy }) => {
    if (chatId === state.currentChatId && readBy !== state.user.id) {
      document.querySelectorAll('.message-out .message-check').forEach(el => {
        el.classList.add('read');
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
    .filter(c => c.last_message !== null)
    .map(chat => {
      const isActive = chat.chat_id === state.currentChatId;
      const initials = getInitials(chat.other_display_name);
      const time = chat.last_message_time ? formatTime(chat.last_message_time) : '';
      const isMyMessage = chat.last_message_sender === state.user.id;
      const preview = chat.last_message || '';
      const truncated = preview.length > 40 ? preview.substring(0, 40) + '...' : preview;
      const unread = parseInt(chat.unread_count) || 0;

      return `
        <div class="chat-item ${isActive ? 'active' : ''}" data-chat-id="${chat.chat_id}" data-user-id="${chat.other_user_id}">
          <div class="chat-item-avatar" style="background:${chat.other_avatar_color}">
            ${initials}
            ${chat.other_is_online ? '<div class="online-dot"></div>' : ''}
          </div>
          <div class="chat-item-body">
            <div class="chat-item-top">
              <div class="chat-item-name">${escapeHtml(chat.other_display_name)}</div>
              <div class="chat-item-time">${time}</div>
            </div>
            <div class="chat-item-bottom">
              <div class="chat-item-message">
                ${isMyMessage ? '<span class="sender-prefix">Вы: </span>' : ''}${escapeHtml(truncated)}
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
      const initials = getInitials(data.otherUser.display_name);
      chatAvatar.style.background = data.otherUser.avatar_color;
      chatAvatar.textContent = initials;
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

  const checkSvg = isMine ? `
    <span class="message-check ${msg.is_read ? 'read' : ''}">
      <svg viewBox="0 0 16 16"><path fill="currentColor" d="M1.5 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.5" fill="none"/><path fill="currentColor" d="M5.5 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
    </span>
  ` : '';

  const html = `
    <div class="message ${isMine ? 'message-out' : 'message-in'}" data-id="${msg.id}">
      <div class="message-text">${linkify(escapeHtml(msg.text))}</div>
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
        <div class="search-user-avatar" style="background:${u.avatar_color}">
          ${getInitials(u.display_name)}
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

// ============ EVENT LISTENERS ============
function setupEventListeners() {
  // Auth
  authForm.addEventListener('submit', handleAuth);
  authSwitchLink.addEventListener('click', (e) => {
    e.preventDefault();
    toggleAuthMode();
  });

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

  // Close search on click outside
  document.addEventListener('click', (e) => {
    if (!searchResults.contains(e.target) && !searchInput.contains(e.target)) {
      if (searchResults.style.display === 'block') {
        hideSearch();
      }
    }
  });

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
      if (searchResults.style.display === 'block') {
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
  if (messageInput.value.trim()) {
    sendBtn.classList.add('active');
  } else {
    sendBtn.classList.remove('active');
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
