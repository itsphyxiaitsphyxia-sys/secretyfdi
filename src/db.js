import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dataDir = path.resolve(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "app.sqlite"));
db.pragma("journal_mode = WAL");

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_path TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_a, user_b)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      kind TEXT NOT NULL, -- 'text' | 'file'
      body TEXT,          -- text message
      file_id TEXT,       -- references files.id for kind='file'
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,  -- encrypted file path on disk
      iv_b64 TEXT NOT NULL,
      tag_b64 TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

export function now() {
  return Date.now();
}

export function uid(prefix = "") {
  return prefix + crypto.randomBytes(18).toString("hex");
}