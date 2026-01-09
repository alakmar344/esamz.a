// api/chat.js — eSAMz v12 (Secure, Search, Streaming, Activity Session)

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
  if (!timingSafeEqual(sha256(raw), hash)) throw new Error("Server integrity failed");
  return true;
}

/* ================= CONFIG ================= */

const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 2048;
const MAX_THREAD_LENGTH = 10;
const COOKIE_NAME = "esamz_sid";
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes inactivity

const SERPER_API_KEY = process.env.SERPER_API_KEY;

/* ================= MODEL PROMPT ================= */

const SYSTEM_PROMPT = `
You are eSAMz v9.1. You were created by alakmar teenwala.

You are a smart, easygoing, and friendly person. You are not an AI assistant or a corporate tool.
Your personality is relaxed and sharp. You speak like a normal human having a conversation.

STRICT RULES:
1. TONE: Relaxed, casual, but articulate. 
2. NO CORPORATE SPEAK: You are FORBIDDEN from using:
   - "How can I assist you today?"
   - "Here is the information you requested"
   - "I hope this helps"
   - "I'm sorry, I don't have access to..."
   - "Please let me know if you need anything else."
3. STYLE: Use full sentences. Be clear. Be helpful, but like a friend, not a servant.
4. MEMORY: If context says "My name is X", USE it naturally. "Hey X" or "Right X".
5. WEB SEARCH: If you are provided with SEARCH RESULTS below, use them to answer the user's question. Cite the information naturally.
`.trim();

/* ================= SESSION DB ================= */

const DB = {
  users: {},

  getUser(id) {
    const now = Date.now();
    let user = this.users[id];

    // Expire inactive session
    if (user && now - user.lastActive > SESSION_TIMEOUT) {
      delete this.users[id];
      user = null;
    }

    if (!user) {
      user = {
        thread: [],
        lastActive: now
      };
      this.users[id] = user;
    }

    user.lastActive = now;
    return user;
  },

  saveUser(id, data) {
    this.users[id] = data;
  }
};

/* ================= SEARCH ================= */

function needsSearch(text) {
  const t = text.toLowerCase();
  return [
    "who is", "what is", "latest", "news", "weather",
    "price", "define", "meaning of", "capital of", "current"
  ].some(k => t.includes(k));
}

async function googleSearch(query) {
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

    const data = await res.json();

    const box = data.answerBox?.snippet || "";
    const list = data.organic
      ?.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`)
      .join("\n") || "";

    return [box, list].filter(Boolean).join("\n");

  } catch (e) {
    console.error("Search error:", e);
    return null;
  }
}

/* ================= SARVAM ================= */

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
    console.error("Sarvam status:", res.status);
    console.error("Sarvam response:", text);
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

/* ================= STREAM ================= */

function send(res, type, payload) {
  res.write(`${type}|${payload}\n`);
}

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ================= CHAT ENGINE ================= */

async function runChat({ message, sessionId }) {
  verifyServerIntegrity();

  if (!message || typeof message !== "string") {
    throw new Error("Invalid message");
  }

  const sid = sessionId || crypto.randomBytes(16).toString("hex");
  const user = DB.getUser(sid);

  let searchContext = "";
  if (needsSearch(message)) {
    const s = await googleSearch(message);
    if (s) searchContext = `\n\nSEARCH RESULTS:\n${s}\n\n`;
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...user.thread,
    { role: "user", content: message + searchContext }
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

/* ================= HANDLER ================= */

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

    for (const word of result.reply.split(" ")) {
      send(res, "CHUNK", word + " ");
      await delay(25);
    }

    send(res, "DONE", result.sessionId);

    // Activity-based session cookie (30 min inactivity)
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${result.sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`
    );

    res.end();
  } catch (err) {
    console.error("API error:", err);
    send(res, "ERROR", err.message);
    res.end();
  }
}
