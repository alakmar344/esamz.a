// api/chat.js
// eSAMz v18.0 - SEARCH + FILES + INVISIBLE THINKING MODE + SAFETY RAILS

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 30096,              
  THREAD_LENGTH: 100,
  SESSION_TTL: 1800,            // 30 min
  RATE_LIMIT: 30, 
  RATE_TTL: 60,
  GLOBAL_INTERVAL: 1100, 
  QUEUE_TIMEOUT: 9000,   
  MAX_FILE_CHARS: 25000  
};

/* ================= 2. THE SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
### **Identity & Core Objective**
You are **eSAMz AI**, a highly advanced, human-like intelligence engine.

### **1. Internal Reasoning (The "Silent" Step)**
* **RULE:** Wrap ALL internal analysis, fact-checking, and planning inside **<thinking>** and **</thinking>** tags.
* **Human-like approach:** Analyze user intent and plan your tone before speaking.

### **2. Safety & Privacy Rails**
* **PII Protection:** If a web search reveals an **Email, Phone Number, or Address**, you MUST NOT repeat it.
* **Illegal Requests:** Politely but firmly decline requests for illegal activities or malware.

### **3. Tone & Personality**
* **Ultra-Human:** Use natural transitions and contractions. Never say "As an AI".
* **Memory:** You have access to the last 100 messages. Use them for context.
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
          } catch(e) {
            return null;
          }
        })
        .filter(x => x && x.role && x.content)
        .slice(-CONSTANTS.THREAD_LENGTH * 2);
    } catch(e) { return []; }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    try {
      const entry = JSON.stringify({ 
        role: role === 'user' ? 'user' : 'assistant', 
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

    const userKey = getUserIdentifier(req, rawBody);
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");
    
    const gotSlot = await acquireSarvamSlot(res);
    if (!gotSlot) return res.end("QUEUE|5");

    const history = await DB.getHistory(sessionId);
    const message = rawBody.message || "";
    let fullMessage = message;

    // --- SMART SEARCH FILTER ---
    const memoryTriggers = ["my name", "who am i", "we talk", "previous", "was my"];
    const isPersonal = memoryTriggers.some(ht => message.toLowerCase().includes(ht));
    const triggers = ["who", "what", "news", "price", "weather", "search", "latest"];
    const needsSearch = triggers.some(t => message.toLowerCase().includes(t)) && !isPersonal;

    if (needsSearch) {
      res.write("STATUS|Searching Web...\n");
      const sRes = await googleSearch(message);
      if (sRes) fullMessage += `\n\n${sRes}`;
    }

    // --- FIXED ROLE MAPPING ---
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ 
        role: (m.role === 'ai' || m.role === 'assistant') ? 'assistant' : 'user', 
        content: m.content 
      })),
      { role: "user", content: fullMessage }
    ];

    let cleanReply = "";
    let streamBuffer = "";

    res.write("STATUS|Thinking...\n");
    
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: CONSTANTS.SARVAM_MODEL, messages, stream: true })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamBuffer += decoder.decode(value, { stream: true });
      
      // Invisible Thinking Logic
      if (streamBuffer.includes("</thinking>")) {
        streamBuffer = streamBuffer.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
      }

      if (!streamBuffer.includes("<thinking>")) {
        const chunk = streamBuffer;
        cleanReply += chunk;
        res.write(`CHUNK|${chunk.replace(/\n/g, "\\n")}\n`);
        streamBuffer = "";
      }
    }

    await DB.addToHistory(sessionId, 'user', message);
    if (cleanReply.trim()) await DB.addToHistory(sessionId, 'assistant', cleanReply);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}
