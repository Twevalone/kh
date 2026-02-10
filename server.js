const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const path = require('path');
const {
  db, createUser, getUserByUsername, getUserById,
  searchUsers, setUserOnline, setUserOffline,
  createChat, addChatMember, findPrivateChat,
  getUserChats, createMessage, getChatMessages,
  markMessagesAsRead, uuidv4, bcrypt, getRandomColor
} = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const JWT_SECRET = process.env.JWT_SECRET || 'tg-messenger-secret-key-' + Math.random().toString(36);
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

    const existing = getUserByUsername.get(username.toLowerCase());
    if (existing) {
      return res.status(400).json({ error: 'Имя пользователя занято' });
    }

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    const avatarColor = getRandomColor();

    createUser.run(id, username.toLowerCase(), displayName, passwordHash, avatarColor);

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

    const user = getUserByUsername.get(username.toLowerCase());
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
  setUserOnline.run(userId);

  // Broadcast online status to all connected users
  io.emit('user:online', { userId });

  // Get user info
  socket.on('user:me', (callback) => {
    const user = getUserById.get(userId);
    callback(user);
  });

  // Search users
  socket.on('users:search', (query, callback) => {
    const pattern = `%${query}%`;
    const users = searchUsers.all(pattern, pattern, userId);
    callback(users);
  });

  // Get chat list
  socket.on('chats:list', (callback) => {
    const chats = getUserChats.all(userId, userId, userId);
    callback(chats);
  });

  // Start or get a private chat
  socket.on('chat:start', (otherUserId, callback) => {
    let chat = findPrivateChat.get(userId, otherUserId);

    if (!chat) {
      const chatId = uuidv4();
      createChat.run(chatId, 'private');
      addChatMember.run(chatId, userId);
      addChatMember.run(chatId, otherUserId);
      chat = { chat_id: chatId };
    }

    // Get chat details
    const otherUser = getUserById.get(otherUserId);
    const messages = getChatMessages.all(chat.chat_id);

    // Mark messages as read
    markMessagesAsRead.run(chat.chat_id, userId);

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
    const messages = getChatMessages.all(chatId);
    markMessagesAsRead.run(chatId, userId);

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

    createMessage.run(messageId, chatId, userId, trimmedText);

    const message = {
      id: messageId,
      chat_id: chatId,
      sender_id: userId,
      text: trimmedText,
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19),
      is_read: 0,
      sender_username: getUserById.get(userId)?.username,
      sender_display_name: getUserById.get(userId)?.display_name,
      sender_avatar_color: getUserById.get(userId)?.avatar_color
    };

    // Send to all in room including sender
    io.to(chatId).emit('message:new', message);

    // Also notify the other user to refresh their chat list
    // (in case they don't have this chat open)
    const chatMembers = db.prepare(
      'SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?'
    ).all(chatId, userId);

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
    markMessagesAsRead.run(chatId, userId);
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
        setUserOffline.run(userId);
        io.emit('user:offline', { userId });
      }
    }
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`\n  🚀 Мессенджер запущен!`);
  console.log(`  📱 Откройте: http://localhost:${PORT}`);
  console.log(`  🌐 Для друга: http://<ваш-ip>:${PORT}\n`);
});
