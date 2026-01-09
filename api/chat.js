// api/chat.js
// eSAMz v10 — Stable, Debuggable, Production Ready

import crypto from "crypto";

/* ================= SECURITY ================= */

function sha256(x) {
  return crypto.createHash("sha256").update(x).digest("hex");
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function verifyServerIntegrity() {
  const raw = process.env.ESAMZ_INTERNAL_KEY;
  const hash = process.env.ESAMZ_KEY_HASH;

  if (!raw || !hash) throw new Error("Security keys not configured");
  if (!timingSafeEqual(sha256(raw), hash)) throw new Error("Server integrity check failed");

  return true;
}

/* ================= CONFIG ================= */

const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 2048;
const MAX_THREAD_LENGTH = 12;
const COOKIE_NAME = "esamz_sid";

/* ================= SYSTEM PROMPT ================= */

const SYSTEM_PROMPT = `
You are eSAMz. You were created by alakmar teenwala.

You speak like a smart relaxed human. You are not corporate. You are not robotic.
You are direct, sharp, helpful and conversational.

Never say:
- How can I assist
- I hope this helps
- Here is the information
- Please let me know
- I'm sorry I don't have access

Speak normally.
`.trim();

/* ================= MEMORY DB (IN-MEMORY) ================= */

const DB = {
  users: {},

  getUser(id) {
    if (!this.users[id]) {
      this.users[id] = {
        thread: []
      };
    }
    return this.users[id];
  },

  saveUser(id, data) {
    this.users[id] = data;
  }
};

/* ================= SARVAM CLIENT ================= */

async function runSarvamChat(messages) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("Sarvam API key missing");

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: SARVAM_MODEL,
      messages,
      max_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.7
    })
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("Sarvam Status:", res.status);
    console.error("Sarvam Response:", text);
    throw new Error(`Sarvam API failed: ${res.status}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Sarvam returned invalid JSON");
  }

  return data?.choices?.[0]?.message?.content || "";
}

/* ================= STREAMING ================= */

function send(res, type, payload) {
  res.write(`${type}|${payload}\n`);
}

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ================= CORE CHAT ================= */

async function runChat({ message, sessionId }) {
  verifyServerIntegrity();

  if (!message || typeof message !== "string") {
    throw new Error("Invalid message");
  }

  const sid = sessionId || crypto.randomBytes(16).toString("hex");
  const user = DB.getUser(sid);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...user.thread,
    { role: "user", content: message }
  ];

  const reply = await runSarvamChat(messages);

  user.thread.push({ role: "user", content: message });
  user.thread.push({ role: "assistant", content: reply });

  if (user.thread.length > MAX_THREAD_LENGTH * 2) {
    user.thread = user.thread.slice(-MAX_THREAD_LENGTH * 2);
  }

  DB.saveUser(sid, user);

  return { reply, sessionId: sid };
}

/* ================= VERCEL HANDLER ================= */

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    verifyServerIntegrity();
  } catch (e) {
    send(res, "ERROR", e.message);
    return res.end();
  }

  if (req.method !== "POST") {
    send(res, "ERROR", "Method not allowed");
    return res.end();
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { message, sessionId } = body;

    send(res, "STATUS", "TYPING");

    const result = await runChat({ message, sessionId });

    const words = result.reply.split(" ");
    for (const word of words) {
      send(res, "CHUNK", word + " ");
      await delay(25);
    }

    send(res, "DONE", result.sessionId);

    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      res.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${result.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
      );
    }

    res.end();
  } catch (err) {
    console.error("API Error:", err);
    send(res, "ERROR", err.message);
    res.end();
  }
}
