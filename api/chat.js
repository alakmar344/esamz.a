import crypto from "crypto";

/* ================= CONFIG ================= */

const COOKIE_NAME = "esamz_sid";
const SESSION_TIMEOUT = 1800; // 30 min inactivity
const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 2048;
const MAX_THREAD_LENGTH = 10;

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

/* ================= MODEL PROMPT ================= */

const SYSTEM_PROMPT = `
You are eSAMz v9.1. You were created by alakmar teenwala.

You are a smart, easygoing, and friendly person. You are not an AI assistant or a corporate tool.
Your personality is relaxed and sharp. You speak like a normal human having a conversation.

STRICT RULES:
1. TONE: Relaxed, casual, but articulate. 
2. NO CORPORATE SPEAK
3. STYLE: Friendly and direct
4. MEMORY: Use past info naturally
5. WEB SEARCH: Use search results when provided
`.trim();

/* ================= REDIS CLIENT ================= */

async function redis(cmd, args = []) {
  const res = await fetch(`${REDIS_URL}/${cmd}/${args.join("/")}`, {
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`
    }
  });

  const json = await res.json();
  return json?.result;
}

async function getSession(id) {
  const data = await redis("get", [id]);
  if (!data) return { thread: [] };
  return JSON.parse(data);
}

async function saveSession(id, session) {
  await redis("setex", [id, SESSION_TIMEOUT, JSON.stringify(session)]);
}

/* ================= SEARCH ================= */

function needsSearch(text) {
  const t = text.toLowerCase();
  return [
    "who is", "what is", "latest", "news",
    "price", "weather", "define", "meaning of"
  ].some(k => t.includes(k));
}

async function googleSearch(query) {
  if (!SERPER_API_KEY) return "";

  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q: query, num: 5 })
  });

  if (!res.ok) return "";

  const data = await res.json();

  const box = data.answerBox?.snippet || "";
  const list = data.organic?.map(r => `${r.title}: ${r.snippet}`).join("\n") || "";

  return [box, list].filter(Boolean).join("\n");
}

/* ================= SARVAM ================= */

async function runSarvam(messages) {
  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: SARVAM_MODEL,
      messages,
      max_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Sarvam error:", err);
    throw new Error("Sarvam API failed");
  }

  const json = await res.json();
  return json.choices[0].message.content;
}

/* ================= HANDLER ================= */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("ERROR|Method not allowed");
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const { message, sessionId } = body;

  if (!message) return res.end("ERROR|No message");

  // Session ID from AI cookie or frontend
  let sid = sessionId || req.cookies?.[COOKIE_NAME];
  if (!sid) sid = crypto.randomBytes(16).toString("hex");

  // Load memory
  let session = await getSession(sid);

  // Optional search
  let searchContext = "";
  if (needsSearch(message)) {
    const s = await googleSearch(message);
    if (s) searchContext = `\n\nSEARCH RESULTS:\n${s}`;
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...session.thread,
    { role: "user", content: message + searchContext }
  ];

  const reply = await runSarvam(messages);

  // Update memory
  session.thread.push({ role: "user", content: message });
  session.thread.push({ role: "assistant", content: reply });

  if (session.thread.length > MAX_THREAD_LENGTH * 2) {
    session.thread = session.thread.slice(-MAX_THREAD_LENGTH * 2);
  }

  // Save memory with expiry
  await saveSession(sid, session);

  // AI-only session cookie
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TIMEOUT}`
  );

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(reply);
}
