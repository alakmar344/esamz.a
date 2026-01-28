// api/chat.js
// eSAMz v14.5 - DEEP DEBUG EDITION (Finds the silent error)

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", // Make sure this model name is correct for your plan
  MAX_TOKENS: 6096,
  THREAD_LENGTH: 20,
  SESSION_TTL: 1800,
  RATE_LIMIT: 20,
  RATE_TTL: 60,
  FILE_CHAR_LIMIT: 10000 
};

/* ================= 2. SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, an AI digital companion created by Alakmar Teenwala.
* **Vibe:** Casual, confident, and direct.
* **Creator:** Alakmar Teenwala.
* **Refusal:** If asked for illegal acts, politely refuse.
* **Privacy:** Redact all phone numbers and personal emails.
`;

/* ================= 3. SECURITY & UTILITIES ================= */

function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

// SAFE COMPARE (Works in all Node/Edge environments)
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

    // Check 1: Internal Key
    if (clientKey !== serverKey) return false;
    // Check 2: Hash
    if (!secureCompare(clientHash, serverHash)) return false;

    return true;
  } catch (e) {
    return false;
  }
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
      const truncated = safeContent.length > 20000 ? safeContent.substring(0, 20000) + "...[truncated]" : safeContent;
      const entryObj = { role, content: truncated, ts: Date.now() };
      const pipeline = redis.pipeline();
      pipeline.rpush(key, JSON.stringify(entryObj));
      pipeline.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1); 
      pipeline.expire(key, CONSTANTS.SESSION_TTL); 
      await pipeline.exec();
    } catch (e) { console.error("REDIS ERROR:", e); }
  }
};

/* ================= 4. EXTERNAL TOOLS ================= */
// Simplified tools for stability
async function googleSearch(query) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 3 })
    });
    const data = await res.json();
    if (!data.organic) return null;
    return "**Source (Google):**\n" + data.organic.map(r => `> ${r.title}: ${r.snippet}`).join("\n");
  } catch (e) { return null; }
}

/* ================= 5. AI ENGINE (DEBUG MODE) ================= */
async function streamSarvamChat({ messages, onChunk }) {
  // 1. CHECK API KEY
  if (!process.env.SARVAM_API_KEY) {
    throw new Error("SERVER CONFIG ERROR: SARVAM_API_KEY is missing in .env");
  }

  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        model: CONSTANTS.SARVAM_MODEL, 
        messages, 
        temperature: 0.7,
        max_tokens: CONSTANTS.MAX_TOKENS, 
        stream: true
      })
    });
    
    // 2. CATCH API ERRORS (e.g. 401, 429)
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Sarvam API Failed [${res.status}]: ${errorText}`);
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
          } catch (e) { /* Ignore partial JSON */ }
        }
      }
    }
  } catch (e) { throw e; }
}

/* ================= 6. MAIN HANDLER ================= */
export default async function handler(req, res) {
  // Force flush headers immediately
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Content-Type-Options': 'nosniff'
  });
  res.flushHeaders(); // Important for Vercel buffering

  if (req.method === 'OPTIONS') return res.end();

  try {
    const rawBody = req.body || {};
    
    // --- SECURITY CHECK ---
    const authStatus = validateSecurity(req);
    if (authStatus === "MISSING_ENV") {
       res.write("ERROR|Server: Missing ESAMZ_INTERNAL_KEY or ESAMZ_KEY_HASH in .env");
       return res.end();
    }
    if (authStatus === false) {
      res.write("ERROR|Unauthorized: Security Check Failed.");
      return res.end();
    }
    // ----------------------

    let message = rawBody.message || "";
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    const userKey = getUserIdentifier(req, rawBody);
    if (!(await checkRateLimit(userKey))) {
      res.write("ERROR|Rate limit exceeded.");
      return res.end();
    }

    // --- SEARCH LOGIC ---
    const history = await DB.getHistory(sessionId);
    let context = "";
    
    if (message.length > 5 && (message.includes("who") || message.includes("what") || message.includes("news"))) {
      res.write("STATUS|Searching Google...\n");
      const searchRes = await googleSearch(message.slice(0, 200));
      if (searchRes) context = `\n\n[Live Search Context]:\n${searchRes}`;
    }

    res.write("STATUS|Thinking...\n");

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
      { role: "user", content: message + context }
    ];

    let fullReply = "";
    let hasStarted = false;

    // --- STREAM WITH ERROR CATCHING ---
    try {
      await streamSarvamChat({
        messages,
        onChunk: (text) => {
          hasStarted = true;
          fullReply += text;
          res.write(`CHUNK|${text.replace(/\n/g, "\\n")}\n`);
        }
      });
    } catch (streamError) {
      // THIS WILL PRINT THE EXACT API ERROR TO YOUR CHAT
      res.write(`ERROR|AI Error: ${streamError.message}`);
      return res.end();
    }

    if (!hasStarted) {
       res.write("ERROR|AI returned OK but sent no text data.");
    } else {
       await DB.addToHistory(sessionId, 'user', message);
       await DB.addToHistory(sessionId, 'assistant', fullReply);
       res.write("DONE|Success");
    }
    
    res.end();

  } catch (e) {
    res.write(`ERROR|System Critical: ${e.message}`);
    res.end();
  }
}
