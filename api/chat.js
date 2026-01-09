// api/chat.js — eSAMz v11
const crypto = require("crypto");
const fetch = require("node-fetch");

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
  if (!timingSafeEqual(sha256(raw), hash)) throw new Error("Server integrity failed");
  return true;
}

/* ================= CONFIG ================= */

const SYSTEM_PROMPT = `
You are eSAMz. Created by alakmar teenwala.
Speak like a smart relaxed human.
No corporate speak. No “How can I assist”.
`.trim();

const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 8048;
const MAX_THREAD_LENGTH = 10;
const COOKIE_NAME = "esamz_sid";

const SERPER_API_KEY = process.env.SERPER_API_KEY;

/* ================= IN-MEMORY DB ================= */

const DB = {
  users: {},
  getUser(id) {
    if (!this.users[id]) this.users[id] = { thread: [] };
    return this.users[id];
  },
  saveUser(id, data) {
    this.users[id] = data;
  }
};

/* ================= WEB SEARCH ================= */

async function doGoogleSearch(query) {
  if (!SERPER_API_KEY) return null;

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query, num: 5 })
    });

    if (!res.ok) return null;
    const json = await res.json();

    const best = json.answerBox?.snippet || "";
    const list = json.organic
      ?.map((item, i) => `${i + 1}. ${item.title} — ${item.snippet}`)
      .join("\n") || "";

    return [best, list].filter(Boolean).join("\n");
  } catch (e) {
    console.error("Search error:", e);
    return null;
  }
}

function needsSearch(text) {
  const lower = text.toLowerCase();
  const triggers = [
    "who is", "what is", "latest", "news", "weather", "price",
    "search for", "current", "define ", "meaning of", "capital of"
  ];
  return triggers.some(t => lower.includes(t));
}

/* ================= SARVAM CLIENT ================= */

async function runSarvamChat(messages) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error("Sarvam API key missing");

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: SARVAM_MODEL,
      messages,
      max_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.72
    })
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("Sarvam status:", res.status, text);
    throw new Error(`Sarvam failed: ${res.status}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Sarvam invalid JSON");
  }

  return data?.choices?.[0]?.message?.content || "";
}

/* ================= STREAMING HELPERS ================= */

function send(res, type, payload) {
  res.write(`${type}|${payload}\n`);
}

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ================= CHAT ENGINE ================= */

async function runChat({ message, sessionId }) {
  verifyServerIntegrity();

  const sid = sessionId || crypto.randomBytes(16).toString("hex");
  const user = DB.getUser(sid);

  let searchContext = "";
  if (needsSearch(message)) {
    const sr = await doGoogleSearch(message);
    if (sr) searchContext = `\n\nSEARCH:\n${sr}\n\n`;
  }

  const history = [
    { role: "system", content: SYSTEM_PROMPT },
    ...user.thread
  ];

  history.push({ role: "user", content: message + searchContext });

  const reply = await runSarvamChat(history);

  user.thread.push({ role: "user", content: message });
  user.thread.push({ role: "assistant", content: reply });

  if (user.thread.length > MAX_THREAD_LENGTH * 2) {
    user.thread = user.thread.slice(-MAX_THREAD_LENGTH * 2);
  }

  DB.saveUser(sid, user);

  return { reply, sessionId: sid };
}

/* ================= VERCEL HANDLER ================= */

module.exports = async function handler(req, res) {
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

    for (const word of result.reply.split(" ")) {
      send(res, "CHUNK", word + " ");
      await delay(30);
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
    console.error("API error:", err);
    send(res, "ERROR", err.message);
    res.end();
  }
};
