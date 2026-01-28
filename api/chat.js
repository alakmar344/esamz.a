// api/chat.js
// eSAMz v14.9 - FULL STREAMING (Documentation Compliant)

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 4096,
  THREAD_LENGTH: 20,
  SESSION_TTL: 1800,
  RATE_LIMIT: 20,
  RATE_TTL: 60,
  FILE_CHAR_LIMIT: 10000 
};

/* ================= 2. SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, an AI digital companion created by Alakmar Teenwala.
Vibe: Casual, confident, and direct. Partner, not a search engine.
Creator: Alakmar Teenwala.
Negative Constraints: NEVER start responses with "Based on...", "According to...", etc. Just answer.
`;

/* ================= 3. SECURITY & UTILITIES ================= */

function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

function secureCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  }
  return mismatch === 0;
}

function validateSecurity(req) {
  try {
    const clientKey = req.headers["x-esamz-key"];
    const clientHash = req.headers["x-esamz-hash"];
    const serverKey = process.env.ESAMZ_INTERNAL_KEY; 
    const serverHash = process.env.ESAMZ_KEY_HASH;

    if (!serverKey || !serverHash) return "MISSING_ENV";
    if (!clientKey || !clientHash) return false;

    if (clientKey !== serverKey) return false;
    if (!secureCompare(clientHash, serverHash)) return false;

    return true;
  } catch (e) { return false; }
}

async function checkRateLimit(identifier) {
  try {
    const key = `ratelimit:${identifier}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, CONSTANTS.RATE_TTL);
    return count <= CONSTANTS.RATE_LIMIT;
  } catch (e) { return true; }
}

const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
      const raw = await redis.lrange(key, 0, -1);
      return raw.map(item => {
        try { return typeof item === 'object' ? item : JSON.parse(item); }
        catch(e) { return null; }
      }).filter(x => x);
    } catch(e) { return []; }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    try {
      const safeContent = typeof content === 'string' ? content : JSON.stringify(content);
      const entryObj = { role, content: safeContent, ts: Date.now() };
      const pipeline = redis.pipeline();
      pipeline.rpush(key, JSON.stringify(entryObj));
      pipeline.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1); 
      pipeline.expire(key, CONSTANTS.SESSION_TTL); 
      await pipeline.exec();
    } catch (e) { console.error("REDIS ERROR:", e); }
  }
};

/* ================= 4. AI ENGINE (STREAMING IMPLEMENTATION) ================= */
async function streamSarvamChat({ messages, onChunk, wikiGrounding }) {
  const payload = { 
    model: CONSTANTS.SARVAM_MODEL, 
    messages, 
    max_tokens: CONSTANTS.MAX_TOKENS, 
    stream: true
  };

  // Logic from Sarvam Documentation
  if (wikiGrounding) {
    payload.temperature = 0.2;
    payload.wiki_grounding = true;
  } else {
    payload.temperature = 0.7;
    payload.reasoning_effort = "medium"; // Enabling thinking mode
  }

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API ${res.status}: ${errorText}`);
  }
  
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let lines = buffer.split("\n");
    buffer = lines.pop(); 

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ") && !trimmed.includes("[DONE]")) {
        try {
          const json = JSON.parse(trimmed.slice(6));
          const txt = json.choices[0]?.delta?.content || "";
          if (txt) onChunk(txt);
        } catch (e) { /* Partial chunk */ }
      }
    }
  }
}

/* ================= 5. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Content-Type-Options': 'nosniff'
  });

  if (req.method === 'OPTIONS') return res.end();

  try {
    const rawBody = req.body || {};
    const authStatus = validateSecurity(req);
    
    if (authStatus === "MISSING_ENV") {
      res.write("ERROR|Server: Check .env configuration.");
      return res.end();
    }
    if (authStatus === false) {
      res.write("ERROR|Unauthorized: Security credentials invalid.");
      return res.end();
    }

    const message = rawBody.message || "";
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    const userKey = getUserIdentifier(req, rawBody);
    if (!(await checkRateLimit(userKey))) {
      res.write("ERROR|Rate limit exceeded.");
      return res.end();
    }

    const history = await DB.getHistory(sessionId);
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
      { role: "user", content: message }
    ];

    res.write("STATUS|Thinking...\n");

    let fullReply = "";
    let hasStarted = false;

    await streamSarvamChat({
      messages,
      wikiGrounding: false, 
      onChunk: (text) => {
        hasStarted = true;
        fullReply += text;
        res.write(`CHUNK|${text.replace(/\n/g, "\\n")}\n`);
      }
    });

    if (!hasStarted) {
      res.write("ERROR|AI sent no content.");
    } else {
      await DB.addToHistory(sessionId, 'user', message);
      await DB.addToHistory(sessionId, 'assistant', fullReply);
      res.write("DONE|Success");
    }
    
    res.end();

  } catch (e) {
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}
