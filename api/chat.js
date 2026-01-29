// api/chat.js
// eSAMz v15.3 - STRICT SECURITY (Anti-Spoofing)

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_TOKENS: 30096,
  THREAD_LENGTH: 40,
  SESSION_TTL: 1800,
  RATE_LIMIT: 10, // Max 20 msgs per minute per IP
  RATE_TTL: 60,
  FILE_CHAR_LIMIT: 20000 
};

/* ================= 2. SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, an AI digital companion created by Alakmar Teenwala.
Vibe: Casual, confident, and direct.
Creator: Alakmar Teenwala.
`;

/* ================= 3. SECURITY UTILITIES ================= */

function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

// --- STRICT ORIGIN CHECK ---
function isTrustedOrigin(req) {
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    
    // 1. Define Exact Allowed Domains (No partial matches!)
    const allowedDomains = [
        "https://esamz.site",
        "https://www.esamz.site",
        "https://esamz-ai.vercel.app" // Add your Vercel URL if you have one
    ];

    // 2. Allow Localhost for testing
    if (origin && (origin.includes("localhost") || origin.includes("127.0.0.1"))) return true;

    // 3. Strict Check: Origin MUST be in the list
    if (origin && allowedDomains.includes(origin)) return true;

    // 4. Fallback: If Origin is missing (some browsers), check Referer
    if (!origin && referer) {
        return allowedDomains.some(domain => referer.startsWith(domain));
    }

    return false;
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
  // 1. TRUSTED ORIGIN (Strict Check)
  if (isTrustedOrigin(req)) return true;

  // 2. KEY FALLBACK (For Apps/Curl)
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

/* ================= 4. EXTERNAL TOOLS ================= */
// (Same as before - keeping it clean)
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

/* ================= 5. AI ENGINE ================= */
async function streamSarvamChat({ messages, onChunk, wikiGrounding }) {
  try {
    const payload = { 
        model: CONSTANTS.SARVAM_MODEL, 
        messages, 
        temperature: wikiGrounding ? 0.3 : 0.7,
        max_tokens: CONSTANTS.MAX_TOKENS, 
        stream: true
    };

    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Sarvam API (${res.status}): ${err}`);
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
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const json = JSON.parse(line.slice(6));
            const txt = json.choices[0]?.delta?.content || "";
            if (txt) onChunk(txt);
          } catch (e) { }
        }
      }
    }
  } catch (e) { throw e; }
}

/* ================= 6. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Content-Type-Options': 'nosniff'
  });

  if (req.method === 'OPTIONS') return res.end();

  try {
    const rawBody = req.body || {};
    
    // --- SECURITY CHECK ---
    const authStatus = validateSecurity(req);
    
    if (authStatus === "MISSING_ENV") {
       res.write("ERROR|Server: Keys missing in .env");
       return res.end();
    }
    if (authStatus === false) {
      // Don't tell hackers WHY they failed, just say Unauthorized
      res.write(`ERROR|Unauthorized Access.`);
      return res.end();
    }

    // --- RATE LIMIT CHECK (Vital Defense) ---
    const userKey = getUserIdentifier(req, rawBody);
    if (!(await checkRateLimit(userKey))) {
      res.write("ERROR|Rate limit exceeded (20/min). Try again later.");
      return res.end();
    }

    let message = rawBody.message || "";
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    // --- SEARCH LOGIC ---
    const history = await DB.getHistory(sessionId);
    let context = "";
    if (message.includes("who") || message.includes("news")) {
        res.write("STATUS|Searching...\n");
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
    
    await streamSarvamChat({
      messages,
      wikiGrounding: !!context, 
      onChunk: (text) => {
        fullReply += text;
        res.write(`CHUNK|${text.replace(/\n/g, "\\n")}\n`);
      }
    });

    await DB.addToHistory(sessionId, 'user', message);
    await DB.addToHistory(sessionId, 'assistant', fullReply);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}
