const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const db = new Database(path.join(__dirname, 'messenger.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#5B9BD5',
    last_seen TEXT DEFAULT (datetime('now')),
    is_online INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'private',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id),
    FOREIGN KEY (chat_id) REFERENCES chats(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    is_read INTEGER DEFAULT 0,
    FOREIGN KEY (chat_id) REFERENCES chats(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(chat_id, is_read);
`);

const AVATAR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F0B27A', '#82E0AA',
  '#F1948A', '#85929E', '#73C6B6'
];

function getRandomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

// User operations
const createUser = db.prepare(`
  INSERT INTO users (id, username, display_name, password_hash, avatar_color)
  VALUES (?, ?, ?, ?, ?)
`);

const getUserByUsername = db.prepare(`
  SELECT * FROM users WHERE username = ?
`);

const getUserById = db.prepare(`
  SELECT id, username, display_name, avatar_color, last_seen, is_online FROM users WHERE id = ?
`);

const searchUsers = db.prepare(`
  SELECT id, username, display_name, avatar_color, is_online
  FROM users
  WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
  LIMIT 20
`);

const setUserOnline = db.prepare(`
  UPDATE users SET is_online = 1, last_seen = datetime('now') WHERE id = ?
`);

const setUserOffline = db.prepare(`
  UPDATE users SET is_online = 0, last_seen = datetime('now') WHERE id = ?
`);

// Chat operations
const createChat = db.prepare(`
  INSERT INTO chats (id, type) VALUES (?, ?)
`);

const addChatMember = db.prepare(`
  INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)
`);

const findPrivateChat = db.prepare(`
  SELECT cm1.chat_id FROM chat_members cm1
  JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id
  JOIN chats c ON c.id = cm1.chat_id
  WHERE cm1.user_id = ? AND cm2.user_id = ? AND c.type = 'private'
`);

const getUserChats = db.prepare(`
  SELECT 
    c.id as chat_id,
    c.type,
    u.id as other_user_id,
    u.username as other_username,
    u.display_name as other_display_name,
    u.avatar_color as other_avatar_color,
    u.is_online as other_is_online,
    u.last_seen as other_last_seen,
    (SELECT text FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
    (SELECT sender_id FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_sender,
    (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
    (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND is_read = 0 AND sender_id != ?) as unread_count
  FROM chats c
  JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
  JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id != ?
  JOIN users u ON u.id = cm2.user_id
  WHERE c.type = 'private'
  ORDER BY last_message_time DESC
`);

// Message operations
const createMessage = db.prepare(`
  INSERT INTO messages (id, chat_id, sender_id, text) VALUES (?, ?, ?, ?)
`);

const getChatMessages = db.prepare(`
  SELECT 
    m.id, m.chat_id, m.sender_id, m.text, m.created_at, m.is_read,
    u.username as sender_username, u.display_name as sender_display_name, u.avatar_color as sender_avatar_color
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  WHERE m.chat_id = ?
  ORDER BY m.created_at ASC
`);

const markMessagesAsRead = db.prepare(`
  UPDATE messages SET is_read = 1
  WHERE chat_id = ? AND sender_id != ? AND is_read = 0
`);

module.exports = {
  db,
  createUser,
  getUserByUsername,
  getUserById,
  searchUsers,
  setUserOnline,
  setUserOffline,
  createChat,
  addChatMember,
  findPrivateChat,
  getUserChats,
  createMessage,
  getChatMessages,
  markMessagesAsRead,
  uuidv4,
  bcrypt,
  getRandomColor
};
