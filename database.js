const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        avatar_color TEXT NOT NULL DEFAULT '#5B9BD5',
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        is_online BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'private',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_members (
        chat_id TEXT NOT NULL REFERENCES chats(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (chat_id, user_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id),
        sender_id TEXT NOT NULL REFERENCES users(id),
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        is_read BOOLEAN DEFAULT FALSE
      )
    `);

    // Create indexes (safe to run multiple times)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(chat_id, is_read)`);

    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// ============ AVATAR COLORS ============
const AVATAR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F0B27A', '#82E0AA',
  '#F1948A', '#85929E', '#73C6B6'
];

function getRandomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

// ============ OPERATIONS (all async) ============
const ops = {
  async createUser(id, username, displayName, passwordHash, avatarColor) {
    await pool.query(
      `INSERT INTO users (id, username, display_name, password_hash, avatar_color) VALUES ($1, $2, $3, $4, $5)`,
      [id, username, displayName, passwordHash, avatarColor]
    );
  },

  async getUserByUsername(username) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
    return rows[0] || null;
  },

  async getUserById(id) {
    const { rows } = await pool.query(
      `SELECT id, username, display_name, avatar_color, last_seen, is_online FROM users WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async searchUsers(query, excludeId) {
    const pattern = `%${query}%`;
    const { rows } = await pool.query(
      `SELECT id, username, display_name, avatar_color, is_online
       FROM users
       WHERE (username ILIKE $1 OR display_name ILIKE $2) AND id != $3
       LIMIT 20`,
      [pattern, pattern, excludeId]
    );
    return rows;
  },

  async setUserOnline(id) {
    await pool.query(`UPDATE users SET is_online = TRUE, last_seen = NOW() WHERE id = $1`, [id]);
  },

  async setUserOffline(id) {
    await pool.query(`UPDATE users SET is_online = FALSE, last_seen = NOW() WHERE id = $1`, [id]);
  },

  async createChat(id, type) {
    await pool.query(`INSERT INTO chats (id, type) VALUES ($1, $2)`, [id, type]);
  },

  async addChatMember(chatId, userId) {
    await pool.query(
      `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [chatId, userId]
    );
  },

  async findPrivateChat(userId1, userId2) {
    const { rows } = await pool.query(
      `SELECT cm1.chat_id FROM chat_members cm1
       JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id
       JOIN chats c ON c.id = cm1.chat_id
       WHERE cm1.user_id = $1 AND cm2.user_id = $2 AND c.type = 'private'`,
      [userId1, userId2]
    );
    return rows[0] || null;
  },

  async getUserChats(userId) {
    const { rows } = await pool.query(
      `SELECT 
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
        (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND is_read = FALSE AND sender_id != $1) as unread_count
      FROM chats c
      JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
      JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id != $3
      JOIN users u ON u.id = cm2.user_id
      WHERE c.type = 'private'
      ORDER BY last_message_time DESC NULLS LAST`,
      [userId, userId, userId]
    );
    return rows;
  },

  async createMessage(id, chatId, senderId, text) {
    await pool.query(
      `INSERT INTO messages (id, chat_id, sender_id, text) VALUES ($1, $2, $3, $4)`,
      [id, chatId, senderId, text]
    );
  },

  async getChatMessages(chatId) {
    const { rows } = await pool.query(
      `SELECT 
        m.id, m.chat_id, m.sender_id, m.text, m.created_at, m.is_read,
        u.username as sender_username, u.display_name as sender_display_name, u.avatar_color as sender_avatar_color
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.chat_id = $1
      ORDER BY m.created_at ASC`,
      [chatId]
    );
    return rows;
  },

  async markMessagesAsRead(chatId, userId) {
    await pool.query(
      `UPDATE messages SET is_read = TRUE WHERE chat_id = $1 AND sender_id != $2 AND is_read = FALSE`,
      [chatId, userId]
    );
  },

  async getChatMembersExcept(chatId, userId) {
    const { rows } = await pool.query(
      `SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id != $2`,
      [chatId, userId]
    );
    return rows;
  }
};

module.exports = {
  pool,
  initDB,
  ops,
  uuidv4,
  bcrypt,
  getRandomColor
};
