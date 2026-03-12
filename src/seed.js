import "dotenv/config";
import bcrypt from "bcryptjs";
import { db, migrate, now, uid } from "./db.js";

migrate();

const users = [
  { username: "agent.alpha", display: "Agent Alpha", password: "Alpha#2026!" },
  { username: "agent.bravo", display: "Agent Bravo", password: "Bravo#2026!" },
  { username: "agent.charlie", display: "Agent Charlie", password: "Charlie#2026!" }
];

const insert = db.prepare(`
  INSERT INTO users (id, username, password_hash, display_name, avatar_path, created_at)
  VALUES (@id, @username, @password_hash, @display_name, @avatar_path, @created_at)
`);

for (const u of users) {
  const password_hash = bcrypt.hashSync(u.password, 12);

  try {
    insert.run({
      id: uid("usr_"),
      username: u.username,
      password_hash,
      display_name: u.display,
      avatar_path: null,
      created_at: now()
    });
    console.log(`OK: créé ${u.username} / ${u.password}`);
  } catch (e) {
    console.log(`SKIP: ${u.username} existe déjà`);
  }
}

console.log("Seed terminé.");