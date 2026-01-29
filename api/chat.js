// api/chat.js
// eSAMz v17.0 - QUEUE MASTER + FILE READER

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_TOKENS: 30096,
  THREAD_LENGTH: 40,
  SESSION_TTL: 1800,
  RATE_LIMIT: 20, 
  RATE_TTL: 60,
  GLOBAL_INTERVAL: 1100, // 1.1s spacing (Queue)
  QUEUE_TIMEOUT: 9000,   // Max wait in queue
  MAX_FILE_CHARS: 25000  // Limit file size to ~25k chars
};

/* ================= 2. SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, an AI digital companion created by Alakmar Teenwala.

Vibe: Casual, confident, and direct.

Creator: Alakmar Teenwala.
`;

/* ================= 3. UTILITIES (Security & Queue) ================= */

function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- THE QUEUE SYSTEM (Global Spin Lock) ---
async function acquireSarvamSlot(res) {
  const start = Date.now();
  while (Date.now() - start < CONSTANTS.QUEUE_TIMEOUT) {
    const acquired = await redis.set("global:sarvam_lock", "1", { nx: true, px: CONSTANTS.GLOBAL_INTERVAL });
    if (acquired === "OK") return true; 

    // Slot taken? Notify user sparingly
    if ((Date.now() - start) % 2000 < 200) { 
        res.write("STATUS|Queue: Waiting for open slot...\n");
    }
    await sleep(250);
  }
  return false;
}

function validateSecurity(req) {
  const origin = req.headers.origin;
  const allowed = ["https://esamz.site", "https://www.esamz.site", "https://esamz-ai.vercel.app"];
  
  if (origin && (origin.includes("localhost") || allowed.includes(origin))) return true;
  
  try {
    const clientKey = req.headers["x-esamz-key"];
    const serverKey = process.env.ESAMZ_INTERNAL_KEY; 
    if (clientKey === serverKey) return true;
  } catch (e) {}
  return false;
}

async function checkRateLimit(identifier) {
  try {
    const key = `ratelimit:${identifier}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, CONSTANTS.RATE_TTL);
    if (count > CONSTANTS.RATE_LIMIT) {
        const ttl = await redis.ttl(key);
        return { allowed: false, ttl: ttl > 0 ? ttl : 60 };
    }
    return { allowed: true, ttl: 0 };
  } catch (e) { return { allowed: true, ttl: 0 }; }
}

const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
      const raw = await redis.lrange(key, 0, -1);
      return raw.map(i => { try { return JSON.parse(i); } catch(e){ return null; } }).filter(x=>x);
    } catch(e) { return []; }
  },
  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    const entry = JSON.stringify({ role, content, ts: Date.now() });
    await redis.rpush(key, entry);
    await redis.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1);
    await redis.expire(key, CONSTANTS.SESSION_TTL);
  }
};

/* ================= 4. FILE PROCESSOR ================= */
// Formats the file into a clear block for the AI
function formatFileContext(fileObj) {
    if (!fileObj || !fileObj.content) return "";
    
    let content = fileObj.content;
    const truncated = content.length > CONSTANTS.MAX_FILE_CHARS;
    
    if (truncated) {
        content = content.substring(0, CONSTANTS.MAX_FILE_CHARS) + "\n\n[...SYSTEM NOTE: File truncated due to length...]";
    }

    return `\n\n--- FILE ATTACHMENT: ${fileObj.name || "Untitled"} ---\n${content}\n--- END OF FILE ---\n`;
}

/* ================= 5. AI ENGINE ================= */
async function streamSarvamChat({ messages, onChunk }) {
  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        model: CONSTANTS.SARVAM_MODEL, 
        messages, 
        temperature: 0.3, // Lower temp for code/file analysis
        max_tokens: CONSTANTS.MAX_TOKENS, 
        stream: true
      })
    });
    
    if (!res.ok) {
        if (res.status === 429) throw new Error("BUSY"); 
        throw new Error(`Sarvam API Error: ${res.status}`);
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
            const txt = JSON.parse(line.slice(6)).choices[0]?.delta?.content || "";
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
    
    // 1. Security
    if (!validateSecurity(req)) {
      res.write(`ERROR|Unauthorized Access.`);
      return res.end();
    }

    // 2. Queue & Rate Check
    const userKey = getUserIdentifier(req, rawBody);
    const limitStatus = await checkRateLimit(userKey);

    if (!limitStatus.allowed) {
        if (limitStatus.ttl <= 5) {
            res.write(`STATUS|Cooling down (${limitStatus.ttl}s)...\n`);
            await sleep(limitStatus.ttl * 1000);
        } else {
            res.write(`QUEUE|${limitStatus.ttl}`);
            return res.end();
        }
    }

    let message = rawBody.message || "";
    const fileData = rawBody.file; // Expecting { name: "script.js", content: "..." }
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    // 3. Queue Lock (Sarvam Protection)
    res.write("STATUS|Waiting for AI slot...\n");
    const gotSlot = await acquireSarvamSlot(res);
    if (!gotSlot) {
        res.write("QUEUE|5"); // Force user retry
        return res.end();
    }

    // 4. Build Context (History + File)
    const history = await DB.getHistory(sessionId);
    let fullMessage = message;
    
    // Inject file if present
    if (fileData) {
        fullMessage += formatFileContext(fileData);
        res.write(`STATUS|Reading ${fileData.name}...\n`);
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
      { role: "user", content: fullMessage }
    ];

    let fullReply = "";
    res.write("STATUS|Thinking...\n");
    
    await streamSarvamChat({
      messages,
      onChunk: (text) => {
        fullReply += text;
        res.write(`CHUNK|${text.replace(/\n/g, "\\n")}\n`);
      }
    });

    // Save to history (excluding massive file content to save Redis space)
    const historyMsg = fileData ? `${message} [Attached File: ${fileData.name}]` : message;
    await DB.addToHistory(sessionId, 'user', historyMsg);
    await DB.addToHistory(sessionId, 'assistant', fullReply);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    if (e.message === "BUSY") res.write("QUEUE|3");
    else res.write(`ERROR|${e.message}`);
    res.end();
  }
}
