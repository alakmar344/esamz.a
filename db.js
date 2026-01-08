import sqlite3 from "sqlite3";
import { open } from "sqlite";

export const db = await open({
  filename: "./database.db",
  driver: sqlite3.Database
});

await db.exec(`
CREATE TABLE IF NOT EXISTS license_keys (
  license_key TEXT PRIMARY KEY,
  plan TEXT,
  email_hash TEXT,
  is_activated INTEGER DEFAULT 0,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS voice_usage (
  license_key TEXT,
  date TEXT,
  count INTEGER DEFAULT 0,
  UNIQUE(license_key, date)
);
`);
