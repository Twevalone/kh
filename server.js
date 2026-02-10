const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const path = require('path');
const { initDB, ops, uuidv4, bcrypt, getRandomColor } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const JWT_SECRET = process.env.JWT_SECRET || 'tg-messenger-secret-key-change-me';
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============ REST API ============

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, displayName, password } = req.body;

    if (!username || !password || !displayName) {
      return res.status(400).json({ error: 'Все поля обязательны' });
    }

    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Имя пользователя: 3-30 символов' });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Только латиница, цифры и _' });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    }

    const existing = ops.getUserByUsername(username.toLowerCase());
    if (existing) {
      return res.status(400).json({ error: 'Имя пользователя занято' });
    }

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    const avatarColor = getRandomColor();

    ops.createUser(id, username.toLowerCase(), displayName, passwordHash, avatarColor);

    const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: { id, username: username.toLowerCase(), displayName, avatarColor }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Введите имя пользователя и пароль' });
    }

    const user = ops.getUserByUsername(username.toLowerCase());
    if (!user) {
      return res.status(400).json({ error: 'Пользователь не найден' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Неверный пароль' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        avatarColor: user.avatar_color
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============ SOCKET.IO ============

// Map of userId -> Set of socket ids
const onlineUsers = new Map();

// Authenticate socket connections
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  console.log(`User connected: ${userId}`);

  // Track online status
  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }
  onlineUsers.get(userId).add(socket.id);
  ops.setUserOnline(userId);

  // Broadcast online status
  io.emit('user:online', { userId });

  // Get user info
  socket.on('user:me', (callback) => {
    const user = ops.getUserById(userId);
    callback(user);
  });

  // Search users
  socket.on('users:search', (query, callback) => {
    const users = ops.searchUsers(query, userId);
    callback(users);
  });

  // Get chat list
  socket.on('chats:list', (callback) => {
    const chats = ops.getUserChats(userId);
    callback(chats);
  });

  // Start or get a private chat
  socket.on('chat:start', (otherUserId, callback) => {
    let chat = ops.findPrivateChat(userId, otherUserId);

    if (!chat) {
      const chatId = uuidv4();
      ops.createChat(chatId, 'private');
      ops.addChatMember(chatId, userId);
      ops.addChatMember(chatId, otherUserId);
      chat = { chat_id: chatId };
    }

    const otherUser = ops.getUserById(otherUserId);
    const messages = ops.getChatMessages(chat.chat_id);

    // Mark messages as read
    ops.markMessagesAsRead(chat.chat_id, userId);

    // Join the socket room
    socket.join(chat.chat_id);

    callback({
      chatId: chat.chat_id,
      otherUser,
      messages
    });
  });

  // Open existing chat
  socket.on('chat:open', (chatId, callback) => {
    const messages = ops.getChatMessages(chatId);
    ops.markMessagesAsRead(chatId, userId);

    socket.join(chatId);

    // Notify sender that messages were read
    socket.to(chatId).emit('messages:read', { chatId, readBy: userId });

    callback({ messages });
  });

  // Send message
  socket.on('message:send', (data, callback) => {
    const { chatId, text } = data;

    if (!text || !text.trim()) return;

    const messageId = uuidv4();
    const trimmedText = text.trim();

    ops.createMessage(messageId, chatId, userId, trimmedText);

    const sender = ops.getUserById(userId);
    const message = {
      id: messageId,
      chat_id: chatId,
      sender_id: userId,
      text: trimmedText,
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
      is_read: 0,
      sender_username: sender?.username,
      sender_display_name: sender?.display_name,
      sender_avatar_color: sender?.avatar_color
    };

    // Send to all in room
    io.to(chatId).emit('message:new', message);

    // Notify other members to refresh chat list
    const chatMembers = ops.getChatMembersExcept(chatId, userId);
    chatMembers.forEach(member => {
      const memberSockets = onlineUsers.get(member.user_id);
      if (memberSockets) {
        memberSockets.forEach(sid => {
          io.to(sid).emit('chats:updated');
        });
      }
    });

    if (callback) callback(message);
  });

  // Mark messages as read
  socket.on('messages:markRead', (chatId) => {
    ops.markMessagesAsRead(chatId, userId);
    socket.to(chatId).emit('messages:read', { chatId, readBy: userId });
  });

  // Typing indicator
  socket.on('typing:start', (chatId) => {
    socket.to(chatId).emit('typing:start', { chatId, userId });
  });

  socket.on('typing:stop', (chatId) => {
    socket.to(chatId).emit('typing:stop', { chatId, userId });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${userId}`);

    const userSockets = onlineUsers.get(userId);
    if (userSockets) {
      userSockets.delete(socket.id);
      if (userSockets.size === 0) {
        onlineUsers.delete(userId);
        ops.setUserOffline(userId);
        io.emit('user:offline', { userId });
      }
    }
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START ============
async function start() {
  await initDB();

  server.listen(PORT, () => {
    console.log(`\n  Messenger started!`);
    console.log(`  Open: http://localhost:${PORT}\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
