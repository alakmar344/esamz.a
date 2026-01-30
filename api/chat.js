// api/chat.js
// eSAMz v18.0 - SEARCH + FILES + INVISIBLE THINKING MODE

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 30096,              
  THREAD_LENGTH: 100,
  SESSION_TTL: 1800,            // Fixed: 7 Days in seconds (60 * 60 * 24 * 7)
  RATE_LIMIT: 30, 
  RATE_TTL: 60,
  GLOBAL_INTERVAL: 1100, 
  QUEUE_TIMEOUT: 9000,   
  MAX_FILE_CHARS: 25000  
};

/* ================= 2. THE SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
### **Identity & Core Objective**
You are **eSAMz AI**, a highly advanced, human-like intelligence engine. Your goal is to provide instant, accurate answers while maintaining a conversation that feels natural, empathetic, and engaging.

### **1. Internal Reasoning (The "Silent" Step)**
To ensure accuracy, you MUST think before you speak.
* **RULE:** Wrap ALL internal analysis, fact-checking, and planning inside **<thinking>** and **</thinking>** tags.
* **Output:** The content inside these tags will be hidden from the user programmatically.
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

    if ((Date.now() - start) % 2000 < 200) { 
        res.write("STATUS|Queue: Waiting for open slot...\n");
    }
    await sleep(250);
  }
  return false;
}

function validateSecurity(req) {
  const origin = req.headers.origin;
  const allowed = ["https://esamz.site", "https://www.esamz.site"];
  
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
      
      const history = raw
        .map(i => { 
          try { 
            // FIX: Ensure 'i' is actually a string before parsing or slicing
            if (typeof i !== 'string') return null;
            return JSON.parse(i); 
          } 
          catch(e) { 
            // FIX: Only call substring if i is a string to prevent "substring is not a function"
            const snippet = (typeof i === 'string') ? i.substring(0, 50) : "Non-string data";
            console.error(`❌ BAD JSON in ${key}:`, snippet);
            return null; 
          } 
        })
        .filter(x => x && x.role && x.content)
        .slice(-CONSTANTS.THREAD_LENGTH * 2); 
        
      return history;
    } catch(e) {
      console.error(`💥 REDIS ERROR ${key}:`, e);
      return [];
    }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    try {
      const storedContent = content.length > 3000 ? content.substring(0, 3000) + " [truncated]" : content;
      const entry = JSON.stringify({ 
        role: role === 'user' ? 'user' : 'assistant', 
        content: storedContent, 
        ts: Date.now() 
      });
      
      await redis.rpush(key, entry);
      await redis.ltrim(key, -CONSTANTS.THREAD_LENGTH * 2, -1); 
      await redis.expire(key, CONSTANTS.SESSION_TTL); // Fixed to 7 Days
      
      console.log(`✅ SAVED ${key}`);
    } catch(e) {
      console.error(`💥 SAVE FAILED ${key}:`, e);
    }
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
    if (!data.organic) return null;
    return "**[LIVE WEB SEARCH RESULTS]**\n" + 
      data.organic.map(r => `> **${r.title}** (${r.link}):\n> ${r.snippet}`).join("\n\n");
  } catch (e) { return null; }
}

function formatFileContext(fileObj) {
    if (!fileObj || !fileObj.content) return "";
    let content = fileObj.content;
    const truncated = content.length > CONSTANTS.MAX_FILE_CHARS;
    if (truncated) {
        content = content.substring(0, CONSTANTS.MAX_FILE_CHARS) + "\n\n[...System: File truncated...]";
    }
    return `\n\n--- FILE: ${fileObj.name || "Untitled"} ---\n${content}\n--- END FILE ---\n`;
}

/* ================= 5. AI ENGINE (Sarvam) ================= */
async function streamSarvamChat({ messages, onChunk }) {
  try {
    const payload = { 
        model: CONSTANTS.SARVAM_MODEL, 
        messages, 
        temperature: 0.5,           
        max_tokens: CONSTANTS.MAX_TOKENS, 
        stream: true
    };

    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
        if (res.status === 429) throw new Error("BUSY"); 
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
    
    if (!validateSecurity(req)) { res.write(`ERROR|Unauthorized.`); return res.end(); }
    const userKey = getUserIdentifier(req, rawBody);
    const limit = await checkRateLimit(userKey);
    if (!limit.allowed) { res.write(`QUEUE|${limit.ttl}`); return res.end(); }

    let message = rawBody.message || "";
    const files = Array.isArray(rawBody.files) ? rawBody.files : (rawBody.file ? [rawBody.file] : []);
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    res.write("STATUS|Connecting to Brain...\n");
    const gotSlot = await acquireSarvamSlot(res);
    if (!gotSlot) { res.write("QUEUE|5"); return res.end(); }

    const history = await DB.getHistory(sessionId);
    let fullMessage = message;

    if (files.length > 0) {
        files.forEach(f => { fullMessage += formatFileContext(f); });
        res.write(`STATUS|Analyzed ${files.length} file(s)...\n`);
    }

    const triggers = ["who", "what", "news", "price", "weather", "search", "when", "latest"];
    const needsSearch = triggers.some(t => message.toLowerCase().includes(t)) && !files.length;
    
    if (needsSearch) {
        res.write("STATUS|Searching Web...\n");
        const sRes = await googleSearch(message);
        if (sRes) fullMessage += `\n\n${sRes}\n\n(Use these search results to answer accurately.)`;
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
      { role: "user", content: fullMessage }
    ];

    let cleanReply = ""; 
    let streamBuffer = ""; 

    res.write("STATUS|Thinking...\n");
    
    await streamSarvamChat({
      messages,
      onChunk: (text) => {
        streamBuffer += text;

        if (streamBuffer.includes("</thinking>")) {
           streamBuffer = streamBuffer.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
        }

        const openTagIndex = streamBuffer.indexOf("<thinking>");
        
        if (openTagIndex !== -1) {
            if (streamBuffer.length > 2000) streamBuffer = ""; 
        } else {
            const lastLt = streamBuffer.lastIndexOf("<");
            if (lastLt !== -1 && streamBuffer.length - lastLt < 12) {
                const safePart = streamBuffer.slice(0, lastLt);
                if (safePart) {
                    cleanReply += safePart;
                    res.write(`CHUNK|${safePart.replace(/\n/g, "\\n")}\n`);
                }
                streamBuffer = streamBuffer.slice(lastLt);
            } else {
                if (streamBuffer.length > 0) {
                    cleanReply += streamBuffer;
                    res.write(`CHUNK|${streamBuffer.replace(/\n/g, "\\n")}\n`);
                    streamBuffer = "";
                }
            }
        }
      }
    });

    const historyMsg = files.length ? `${message} [Attached: ${files.length} Files]` : message;
    await DB.addToHistory(sessionId, 'user', historyMsg);
    
    if (cleanReply.trim()) {
        await DB.addToHistory(sessionId, 'assistant', cleanReply);
    }

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    if (e.message === "BUSY") res.write("QUEUE|3");
    else res.write(`ERROR|${e.message}`);
    res.end();
  }
}
