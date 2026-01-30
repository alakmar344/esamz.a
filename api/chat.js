// api/chat.js
// eSAMz v18.1 - STABLE + SMART CONTEXT + NO HALLUCINATIONS

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 30096,              
  THREAD_LENGTH: 100,
  SESSION_TTL: 1800,
  RATE_LIMIT: 30, 
  RATE_TTL: 60,
  GLOBAL_INTERVAL: 1100, 
  QUEUE_TIMEOUT: 9000,   
  MAX_FILE_CHARS: 25000  
};

/* ================= 2. THE SYSTEM PROMPT (Fixed) ================= */
/* ================= 2. THE SYSTEM PROMPT (Intelligence & Vibe) ================= */
const SYSTEM_PROMPT = `
### **Identity**
You are **eSAMz AI**, a highly intelligent, modern, and capable AI assistant. You are not just a tool; you are a "thinking partner." You are cool, concise, and sharp.

### **Core Capability: MEMORY**
* **You have a memory.** You can see the previous messages in this conversation.
* **USE IT.** If the user asks "Who am I?" or "What did we just talk about?", **LOOK** at the chat history and answer immediately.
* **Context First:** Never say "I don't know" if the answer is in the messages right above you.

### **Tone & Style**
* **Direct & Smart:** Get straight to the point. No fluff.
* **Human-Like:** Use natural language. Say "Got it," "I remember," or "Here's the deal."
* **No Robot-Speak:** Never apologize for being an AI. Never give a lecture about safety unless specifically asked.

### **Operational Rules**
1.  **Identity:** If the user tells you their name (e.g., "I am Esmail"), believe them and call them by that name.
2.  **Search:** Only search the web if the user asks for *new* external information (news, weather, code docs). Do not search for things you already know from the chat.
`;

/* ================= 3. UTILITIES ================= */

function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireSarvamSlot(res) {
  const start = Date.now();
  while (Date.now() - start < CONSTANTS.QUEUE_TIMEOUT) {
    const acquired = await redis.set("global:sarvam_lock", "1", { nx: true, px: CONSTANTS.GLOBAL_INTERVAL });
    if (acquired === "OK") return true; 
    await sleep(250);
  }
  return false;
}

function validateSecurity(req) {
  const origin = req.headers.origin;
  const allowed = ["https://esamz.site", "https://www.esamz.site"];
  if (origin && (origin.includes("localhost") || allowed.includes(origin))) return true;
  return req.headers["x-esamz-key"] === process.env.ESAMZ_INTERNAL_KEY;
}

const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
      const raw = await redis.lrange(key, 0, -1);
      return raw.map(i => {
          try {
            if (typeof i !== 'string') return null;
            return JSON.parse(i);
          } catch(e) { return null; }
        })
        .filter(x => x && x.role && x.content)
        .slice(-CONSTANTS.THREAD_LENGTH * 2);
    } catch(e) { return []; }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    try {
      // Fix: Normalize role to 'assistant' or 'user' only
      const safeRole = role === 'user' ? 'user' : 'assistant';
      const entry = JSON.stringify({ 
        role: safeRole, 
        content: content.substring(0, 3000), 
        ts: Date.now() 
      });
      await redis.rpush(key, entry);
      await redis.ltrim(key, -CONSTANTS.THREAD_LENGTH * 2, -1);
      await redis.expire(key, CONSTANTS.SESSION_TTL);
    } catch(e) {}
  }
};

/* ================= 4. EXTERNAL TOOLS ================= */

async function googleSearch(query) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 4 })
    });
    const data = await res.json();
    return data.organic ? "**[LIVE WEB SEARCH]**\n" + data.organic.map(r => `> ${r.title}: ${r.snippet}`).join("\n\n") : null;
  } catch (e) { return null; }
}

/* ================= 5. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });
  if (req.method === 'OPTIONS') return res.end();

  try {
    const rawBody = req.body || {};
    if (!validateSecurity(req)) return res.end("ERROR|Unauthorized");

    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");
    const gotSlot = await acquireSarvamSlot(res);
    if (!gotSlot) return res.end("QUEUE|5");

    const history = await DB.getHistory(sessionId);
    const message = rawBody.message || "";
    let fullMessage = message;

    // --- 1. SMART SEARCH FILTER (Prevents searching for your name) ---
    const memoryTriggers = ["my name", "who am i", "we talk", "previous", "was my"];
    const isPersonal = memoryTriggers.some(ht => message.toLowerCase().includes(ht));
    
    // Only search if it's a "Look up" question AND NOT a "Remember me" question
    const triggers = ["who", "what", "news", "price", "weather", "search", "latest"];
    const needsSearch = triggers.some(t => message.toLowerCase().includes(t)) && !isPersonal;

    if (needsSearch) {
      res.write("STATUS|Searching Web...\n");
      const sRes = await googleSearch(message);
      if (sRes) fullMessage += `\n\n${sRes}`;
    }

    // --- 2. PREPARE MESSAGES (With Role Fix) ---
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      // Map history correctly so AI knows what it said previously
      ...history.map(m => ({ 
        role: (m.role === 'ai' || m.role === 'assistant') ? 'assistant' : 'user', 
        content: m.content 
      })),
      { role: "user", content: fullMessage }
    ];

    res.write("STATUS|Thinking...\n");
    
    // --- 3. STREAMING (Simplified - No more filtering bugs) ---
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: CONSTANTS.SARVAM_MODEL, messages, stream: true })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let finalReply = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      
      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const json = JSON.parse(line.slice(6));
            const text = json.choices[0]?.delta?.content || "";
            if (text) {
                finalReply += text;
                res.write(`CHUNK|${text.replace(/\n/g, "\\n")}\n`);
            }
          } catch (e) {}
        }
      }
    }

    // --- 4. SAVE HISTORY (Atomic) ---
    if (finalReply.trim()) {
        await DB.addToHistory(sessionId, 'user', message);
        await DB.addToHistory(sessionId, 'assistant', finalReply);
    }

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}
