import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Server as SocketIOServer } from "socket.io";

import * as database from "./db.js";
const { db, migrate, now, uid } = database;
import { authMiddleware, signToken, verifyToken } from "./auth.js";
import { getFileKeyFromEnv, encryptBuffer, decryptBuffer } from "./crypto.js";
import { geoFromIp } from "./ipgeo.js";

migrate();

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";

const uploadDir = path.resolve(process.cwd(), "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const fileKey = getFileKeyFromEnv();

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan("dev"));
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: "2mb" }));

// Serve client static (simple mode)
const clientDir = path.resolve(process.cwd(), "../client");
app.get("/", (req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});
app.use(express.static(clientDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

function getClientIp(req) {
  // x-forwarded-for if behind proxy
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.socket.remoteAddress;
}

/* -------- AUTH -------- */
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Champs manquants" });

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user) return res.status(401).json({ error: "Identifiants invalides" });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Identifiants invalides" });

  const token = signToken({ userId: user.id, username: user.username });
  return res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_path ? `/api/files/avatar/${user.id}` : null
    }
  });
});

app.get("/api/me", authMiddleware, (req, res) => {
  const u = db.prepare("SELECT id, username, display_name, avatar_path FROM users WHERE id = ?").get(req.user.userId);
  if (!u) return res.status(404).json({ error: "Utilisateur introuvable" });
  res.json({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarUrl: u.avatar_path ? `/api/files/avatar/${u.id}` : null
  });
});

app.post("/api/me/profile", authMiddleware, (req, res) => {
  const { displayName, username, password } = req.body || {};

  const current = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.userId);
  if (!current) return res.status(404).json({ error: "Utilisateur introuvable" });

  const updates = [];
  const params = {};

  if (typeof displayName === "string" && displayName.trim()) {
    updates.push("display_name = @display_name");
    params.display_name = displayName.trim();
  }
  if (typeof username === "string" && username.trim() && username.trim() !== current.username) {
    // unique check
    const exists = db.prepare("SELECT id FROM users WHERE username = ?").get(username.trim());
    if (exists) return res.status(409).json({ error: "Identifiant déjà utilisé" });
    updates.push("username = @username");
    params.username = username.trim();
  }
  if (typeof password === "string" && password.length >= 8) {
    updates.push("password_hash = @password_hash");
    params.password_hash = bcrypt.hashSync(password, 12);
  }

  if (!updates.length) return res.json({ ok: true });

  db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = @id`).run({ ...params, id: current.id });
  res.json({ ok: true });
});

/* -------- GEO -------- */
app.get("/api/geo", async (req, res) => {
  const ip = getClientIp(req);
  const geo = await geoFromIp(ip);
  res.json({ ip, geo });
});

/* -------- USERS LIST (for DM) -------- */
app.get("/api/users", authMiddleware, (req, res) => {
  const rows = db.prepare("SELECT id, username, display_name, avatar_path FROM users ORDER BY username ASC").all();
  res.json(rows.map(r => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_path ? `/api/files/avatar/${r.id}` : null
  })));
});

/* -------- CONVERSATIONS + MESSAGES -------- */
function convKey(a, b) {
  return [a, b].sort().join("::");
}

function getOrCreateConversation(userA, userB) {
  const [x, y] = [userA, userB].sort();
  const existing = db.prepare("SELECT * FROM conversations WHERE user_a = ? AND user_b = ?").get(x, y);
  if (existing) return existing;

  const c = { id: uid("c_"), user_a: x, user_b: y, created_at: now() };
  db.prepare("INSERT INTO conversations (id, user_a, user_b, created_at) VALUES (@id, @user_a, @user_b, @created_at)").run(c);
  return c;
}

app.get("/api/conversations/:otherUserId/messages", authMiddleware, (req, res) => {
  const me = req.user.userId;
  const other = req.params.otherUserId;
  const conv = getOrCreateConversation(me, other);

  const msgs = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
    LIMIT 200
  `).all(conv.id);

  res.json({ conversationId: conv.id, messages: msgs });
});

/* -------- FILES (encrypted at rest) --------
   Upload via JSON base64 for simplicity.
   For big video you’ll want multipart streaming later.
*/
app.post("/api/files/upload", authMiddleware, (req, res) => {
  const me = req.user.userId;
  const { filename, mime, b64 } = req.body || {};
  if (!filename || !mime || !b64) return res.status(400).json({ error: "Champs manquants" });

  const raw = Buffer.from(b64, "base64");
  if (raw.length > 15 * 1024 * 1024) return res.status(413).json({ error: "Fichier trop volumineux (max 15MB demo)" });

  const { ciphertext, iv, tag } = encryptBuffer(fileKey, raw);

  const id = uid("f_");
  const storage_path = path.join(uploadDir, `${id}.bin`);
  fs.writeFileSync(storage_path, ciphertext);

  db.prepare(`
    INSERT INTO files (id, owner_id, original_name, mime, size_bytes, storage_path, iv_b64, tag_b64, created_at)
    VALUES (@id, @owner_id, @original_name, @mime, @size_bytes, @storage_path, @iv_b64, @tag_b64, @created_at)
  `).run({
    id,
    owner_id: me,
    original_name: filename,
    mime,
    size_bytes: raw.length,
    storage_path,
    iv_b64: iv.toString("base64"),
    tag_b64: tag.toString("base64"),
    created_at: now()
  });

  res.json({ ok: true, fileId: id });
});

app.get("/api/files/my", authMiddleware, (req, res) => {
  const me = req.user.userId;
  const rows = db.prepare(`
    SELECT id, original_name, mime, size_bytes, created_at
    FROM files
    WHERE owner_id = ?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(me);
  res.json(rows);
});

app.get("/api/files/:id/download", authMiddleware, (req, res) => {
  const me = req.user.userId;
  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!f) return res.status(404).json({ error: "Fichier introuvable" });
  if (f.owner_id !== me) return res.status(403).json({ error: "Accès refusé" });

  const ciphertext = fs.readFileSync(f.storage_path);
  const iv = Buffer.from(f.iv_b64, "base64");
  const tag = Buffer.from(f.tag_b64, "base64");
  const plaintext = decryptBuffer(fileKey, ciphertext, iv, tag);

  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(f.original_name)}"`);
  res.send(plaintext);
});

// Avatar: stored as encrypted file too, but referenced from users.avatar_path = fileId
app.post("/api/me/avatar", authMiddleware, (req, res) => {
  const me = req.user.userId;
  const { filename, mime, b64 } = req.body || {};
  if (!filename || !mime || !b64) return res.status(400).json({ error: "Champs manquants" });

  const raw = Buffer.from(b64, "base64");
  if (raw.length > 2 * 1024 * 1024) return res.status(413).json({ error: "Avatar trop volumineux (max 2MB)" });

  const { ciphertext, iv, tag } = encryptBuffer(fileKey, raw);

  const fileId = uid("av_");
  const storage_path = path.join(uploadDir, `${fileId}.bin`);
  fs.writeFileSync(storage_path, ciphertext);

  db.prepare(`
    INSERT INTO files (id, owner_id, original_name, mime, size_bytes, storage_path, iv_b64, tag_b64, created_at)
    VALUES (@id, @owner_id, @original_name, @mime, @size_bytes, @storage_path, @iv_b64, @tag_b64, @created_at)
  `).run({
    id: fileId,
    owner_id: me,
    original_name: filename,
    mime,
    size_bytes: raw.length,
    storage_path,
    iv_b64: iv.toString("base64"),
    tag_b64: tag.toString("base64"),
    created_at: now()
  });

  db.prepare("UPDATE users SET avatar_path = ? WHERE id = ?").run(fileId, me);
  res.json({ ok: true });
});

app.get("/api/files/avatar/:userId", (req, res) => {
  const u = db.prepare("SELECT avatar_path FROM users WHERE id = ?").get(req.params.userId);
  if (!u || !u.avatar_path) return res.status(404).end();

  const f = db.prepare("SELECT * FROM files WHERE id = ?").get(u.avatar_path);
  if (!f) return res.status(404).end();

  const ciphertext = fs.readFileSync(f.storage_path);
  const iv = Buffer.from(f.iv_b64, "base64");
  const tag = Buffer.from(f.tag_b64, "base64");
  const plaintext = decryptBuffer(fileKey, ciphertext, iv, tag);

  res.setHeader("Content-Type", f.mime);
  res.send(plaintext);
});

/* -------- NOTES -------- */
app.get("/api/notes", authMiddleware, (req, res) => {
  const me = req.user.userId;
  const rows = db.prepare(`
    SELECT id, title, content, updated_at, created_at
    FROM notes
    WHERE owner_id = ?
    ORDER BY updated_at DESC
    LIMIT 200
  `).all(me);
  res.json(rows);
});

app.post("/api/notes", authMiddleware, (req, res) => {
  const me = req.user.userId;
  const { title, content } = req.body || {};
  if (!title || typeof title !== "string") return res.status(400).json({ error: "Titre invalide" });

  const n = {
    id: uid("n_"),
    owner_id: me,
    title: title.trim().slice(0, 80),
    content: (content || "").toString(),
    created_at: now(),
    updated_at: now()
  };

  db.prepare(`
    INSERT INTO notes (id, owner_id, title, content, updated_at, created_at)
    VALUES (@id, @owner_id, @title, @content, @updated_at, @created_at)
  `).run(n);

  res.json(n);
});

app.put("/api/notes/:id", authMiddleware, (req, res) => {
  const me = req.user.userId;
  const { title, content } = req.body || {};

  const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Note introuvable" });
  if (existing.owner_id !== me) return res.status(403).json({ error: "Accès refusé" });

  db.prepare(`
    UPDATE notes
    SET title = ?, content = ?, updated_at = ?
    WHERE id = ?
  `).run(
    (title || existing.title).toString().trim().slice(0, 80),
    (content ?? existing.content).toString(),
    now(),
    existing.id
  );

  res.json({ ok: true });
});

app.delete("/api/notes/:id", authMiddleware, (req, res) => {
  const me = req.user.userId;
  const existing = db.prepare("SELECT * FROM notes WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Note introuvable" });
  if (existing.owner_id !== me) return res.status(403).json({ error: "Accès refusé" });

  db.prepare("DELETE FROM notes WHERE id = ?").run(existing.id);
  res.json({ ok: true });
});

/* -------- Socket.IO realtime messages -------- */
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: CLIENT_ORIGIN, credentials: true }
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("NON_AUTH"));
    const decoded = verifyToken(token);
    socket.user = decoded;
    next();
  } catch {
    next(new Error("NON_AUTH"));
  }
});

io.on("connection", (socket) => {
  const me = socket.user.userId;
  socket.join(`user:${me}`);

  socket.on("dm:send", (payload, cb) => {
    try {
      const { toUserId, text } = payload || {};
      if (!toUserId || !text || !text.trim()) return cb?.({ ok: false, error: "Message vide" });

      const conv = getOrCreateConversation(me, toUserId);

      const msg = {
        id: uid("m_"),
        conversation_id: conv.id,
        sender_id: me,
        kind: "text",
        body: text.toString(),
        file_id: null,
        created_at: now()
      };

      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender_id, kind, body, file_id, created_at)
        VALUES (@id, @conversation_id, @sender_id, @kind, @body, @file_id, @created_at)
      `).run(msg);

      io.to(`user:${me}`).emit("dm:new", msg);
      io.to(`user:${toUserId}`).emit("dm:new", msg);

      cb?.({ ok: true, msg });
    } catch (e) {
      cb?.({ ok: false, error: "Erreur serveur" });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Serveur OK: http://localhost:${PORT}`);
  console.log(`Client servi depuis: ${clientDir}`);
});