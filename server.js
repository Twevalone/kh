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
app.use(express.json({ limit: '2mb' }));

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

    const existing = await ops.getUserByUsername(username.toLowerCase());
    if (existing) {
      return res.status(400).json({ error: 'Имя пользователя занято' });
    }

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    const avatarColor = getRandomColor();

    await ops.createUser(id, username.toLowerCase(), displayName, passwordHash, avatarColor);

    const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: { id, username: username.toLowerCase(), displayName, avatarColor, avatarUrl: null }
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

    const user = await ops.getUserByUsername(username.toLowerCase());
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
        avatarColor: user.avatar_color,
        avatarUrl: user.avatar_url || null
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// List all users (debug)
app.get('/api/users', async (req, res) => {
  try {
    const users = await ops.getAllUsers();
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Upload avatar
app.post('/api/avatar', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Невалидный токен' });
    }

    const { avatar } = req.body;
    if (!avatar) {
      return res.status(400).json({ error: 'Аватар не предоставлен' });
    }

    // Check size: max ~200KB of base64 string
    if (avatar.length > 300000) {
      return res.status(400).json({ error: 'Аватар слишком большой (макс 200KB)' });
    }

    await ops.updateAvatar(decoded.userId, avatar);

    res.json({ ok: true });
  } catch (err) {
    console.error('Avatar upload error:', err);
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
  ops.setUserOnline(userId).catch(console.error);

  // Broadcast online status
  io.emit('user:online', { userId });

  // Get user info
  socket.on('user:me', async (callback) => {
    try {
      const user = await ops.getUserById(userId);
      callback(user);
    } catch (err) {
      console.error('user:me error:', err);
      callback(null);
    }
  });

  // Search users
  socket.on('users:search', async (query, callback) => {
    try {
      const users = await ops.searchUsers(query, userId);
      callback(users);
    } catch (err) {
      console.error('users:search error:', err);
      callback([]);
    }
  });

  // Get chat list
  socket.on('chats:list', async (callback) => {
    try {
      const chats = await ops.getUserChats(userId);
      callback(chats);
    } catch (err) {
      console.error('chats:list error:', err);
      callback([]);
    }
  });

  // Start or get a private chat
  socket.on('chat:start', async (otherUserId, callback) => {
    try {
      let chat = await ops.findPrivateChat(userId, otherUserId);

      if (!chat) {
        const chatId = uuidv4();
        await ops.createChat(chatId, 'private');
        await ops.addChatMember(chatId, userId);
        await ops.addChatMember(chatId, otherUserId);
        chat = { chat_id: chatId };
      }

      const otherUser = await ops.getUserById(otherUserId);
      const messages = await ops.getChatMessages(chat.chat_id);

      // Mark messages as read
      await ops.markMessagesAsRead(chat.chat_id, userId);

      // Join the socket room
      socket.join(chat.chat_id);

      callback({
        chatId: chat.chat_id,
        otherUser,
        messages
      });
    } catch (err) {
      console.error('chat:start error:', err);
      callback({ chatId: null, otherUser: null, messages: [] });
    }
  });

  // Open existing chat
  socket.on('chat:open', async (chatId, callback) => {
    try {
      const messages = await ops.getChatMessages(chatId);
      await ops.markMessagesAsRead(chatId, userId);

      socket.join(chatId);

      // Notify sender that messages were read
      socket.to(chatId).emit('messages:read', { chatId, readBy: userId });

      callback({ messages });
    } catch (err) {
      console.error('chat:open error:', err);
      callback({ messages: [] });
    }
  });

  // Send message (text or voice)
  socket.on('message:send', async (data, callback) => {
    try {
      const { chatId, text, type, audioData, audioDuration, replyToId, forwardedFrom } = data;

      // Validate based on message type
      if (type === 'voice') {
        if (!audioData) return;
        if (audioData.length > 2000000) {
          if (callback) callback({ error: 'Голосовое сообщение слишком большое' });
          return;
        }
      } else {
        if (!text || !text.trim()) return;
      }

      const messageId = uuidv4();
      const trimmedText = type === 'voice' ? null : text.trim();

      await ops.createMessage(messageId, chatId, userId, trimmedText, type || 'text', audioData || null, audioDuration || null, replyToId || null, forwardedFrom || null);

      const sender = await ops.getUserById(userId);

      // Build reply info if replying
      let replyInfo = null;
      if (replyToId) {
        const replyMsg = await ops.getMessageById(replyToId);
        if (replyMsg) {
          replyInfo = {
            reply_to_id: replyToId,
            reply_text: replyMsg.text,
            reply_type: replyMsg.type,
            reply_sender_name: replyMsg.sender_display_name
          };
        }
      }

      const message = {
        id: messageId,
        chat_id: chatId,
        sender_id: userId,
        text: trimmedText,
        type: type || 'text',
        audio_data: audioData || null,
        audio_duration: audioDuration || null,
        reply_to_id: replyToId || null,
        forwarded_from: forwardedFrom || null,
        ...(replyInfo || {}),
        created_at: new Date().toISOString(),
        is_read: false,
        sender_username: sender?.username,
        sender_display_name: sender?.display_name,
        sender_avatar_color: sender?.avatar_color,
        sender_avatar_url: sender?.avatar_url || null
      };

      io.to(chatId).emit('message:new', message);

      const chatMembers = await ops.getChatMembersExcept(chatId, userId);
      chatMembers.forEach(member => {
        const memberSockets = onlineUsers.get(member.user_id);
        if (memberSockets) {
          memberSockets.forEach(sid => {
            io.to(sid).emit('chats:updated');
          });
        }
      });

      if (callback) callback(message);
    } catch (err) {
      console.error('message:send error:', err);
    }
  });

  // Mark messages as read
  socket.on('messages:markRead', async (chatId) => {
    try {
      await ops.markMessagesAsRead(chatId, userId);
      socket.to(chatId).emit('messages:read', { chatId, readBy: userId });
    } catch (err) {
      console.error('messages:markRead error:', err);
    }
  });

  // Avatar updated
  socket.on('avatar:updated', (avatarUrl) => {
    // Broadcast to all connected users so they see the new avatar
    socket.broadcast.emit('user:avatar-updated', { userId, avatarUrl });
  });

  // ---- VOICE CALLS (signaling) ----
  socket.on('call:initiate', async ({ targetUserId }, callback) => {
    try {
      const caller = await ops.getUserById(userId);
      const targetSockets = onlineUsers.get(targetUserId);
      if (!targetSockets || targetSockets.size === 0) {
        if (callback) callback({ error: 'Пользователь не в сети' });
        return;
      }
      // Send incoming call to all sockets of the target user
      targetSockets.forEach(sid => {
        io.to(sid).emit('call:incoming', {
          callerId: userId,
          callerName: caller?.display_name || 'Unknown',
          callerAvatarColor: caller?.avatar_color,
          callerAvatarUrl: caller?.avatar_url || null
        });
      });
      if (callback) callback({ ok: true });
    } catch (err) {
      console.error('call:initiate error:', err);
      if (callback) callback({ error: 'Ошибка сервера' });
    }
  });

  socket.on('call:accept', ({ targetUserId }) => {
    const targetSockets = onlineUsers.get(targetUserId);
    if (targetSockets) {
      targetSockets.forEach(sid => io.to(sid).emit('call:accepted', { by: userId }));
    }
  });

  socket.on('call:reject', ({ targetUserId }) => {
    const targetSockets = onlineUsers.get(targetUserId);
    if (targetSockets) {
      targetSockets.forEach(sid => io.to(sid).emit('call:rejected', { by: userId }));
    }
  });

  socket.on('call:end', ({ targetUserId }) => {
    const targetSockets = onlineUsers.get(targetUserId);
    if (targetSockets) {
      targetSockets.forEach(sid => io.to(sid).emit('call:ended', { by: userId }));
    }
  });

  socket.on('call:offer', ({ targetUserId, offer }) => {
    const targetSockets = onlineUsers.get(targetUserId);
    if (targetSockets) {
      targetSockets.forEach(sid => io.to(sid).emit('call:offer', { from: userId, offer }));
    }
  });

  socket.on('call:answer', ({ targetUserId, answer }) => {
    const targetSockets = onlineUsers.get(targetUserId);
    if (targetSockets) {
      targetSockets.forEach(sid => io.to(sid).emit('call:answer', { from: userId, answer }));
    }
  });

  socket.on('call:ice-candidate', ({ targetUserId, candidate }) => {
    const targetSockets = onlineUsers.get(targetUserId);
    if (targetSockets) {
      targetSockets.forEach(sid => io.to(sid).emit('call:ice-candidate', { from: userId, candidate }));
    }
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
        ops.setUserOffline(userId).catch(console.error);
        io.emit('user:offline', { userId });
        // End any ongoing call — broadcast to all in case someone was in call with this user
        io.emit('call:ended', { by: userId });
      }
    }
  });
});

// SPA fallback (only for non-API routes)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START ============
async function start() {
  await initDB();

  // Log registered users on startup
  try {
    const users = await ops.getAllUsers();
    console.log(`Registered users: ${users.length}`);
    users.forEach(u => console.log(`  - @${u.username} (${u.display_name})`));
  } catch (e) {
    console.log('Could not list users:', e.message);
  }

  // Cleanup old voice messages every hour (keep 3 days)
  const VOICE_CLEANUP_DAYS = 3;
  const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

  async function runCleanup() {
    try {
      const deleted = await ops.cleanupOldVoiceMessages(VOICE_CLEANUP_DAYS);
      if (deleted > 0) {
        console.log(`Cleanup: deleted ${deleted} voice messages older than ${VOICE_CLEANUP_DAYS} days`);
      }
    } catch (err) {
      console.error('Voice cleanup error:', err);
    }
  }

  // Run cleanup on startup and then every hour
  runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL);

  server.listen(PORT, () => {
    console.log(`\n  Messenger started!`);
    console.log(`  Open: http://localhost:${PORT}\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
