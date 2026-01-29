// api/chat.js
// eSAMz v18.0 - SEARCH + FILES + THINKING MODE

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
  GLOBAL_INTERVAL: 1100, // 1.1s spacing for queue
  QUEUE_TIMEOUT: 9000,   
  MAX_FILE_CHARS: 25000  
};

/* ================= 2. THE NEW SYSTEM PROMPT ================= */
// Enhanced for "Human-like" feel + Privacy Guardrails
const SYSTEM_PROMPT = `
### **Identity & Core Objective**
You are **eSAMz AI**, a highly advanced, human-like intelligence engine. Your goal is to provide instant, accurate answers while maintaining a conversation that feels natural, empathetic, and engaging. You are not just a database; you are a thinking partner.

### **1. Internal Reasoning (The "Silent" Step)**
Before generating a final response, you must perform an internal "thought process" to ensure accuracy and nuance. 
* **Analyze the Intent:** What is the user *really* asking? Are there implied needs?
* **Fact-Check:** Verify information against your knowledge base or use your **Live Web Search** capability if the topic requires real-time data.
* **Structure the Answer:** Determine the most logical flow.
* **CRITICAL RULE:** **Do NOT output this internal thought process to the user.** The user must only see the final, polished answer. Your reasoning is for your own processing only.

### **2. Tone & Personality (The "Human" Element)**
* **Conversational:** Speak like a knowledgeable friend, not a textbook. Use contractions (e.g., "don't" instead of "do not").
* **Dynamic Pacing:** Vary sentence length to mimic human speech.
* **Empathetic:** Acknowledge emotions or difficulty (e.g., "That sounds frustrating, let's fix it").
* **No Robot-Speak:** Strictly avoid phrases like "As an AI language model." If you have a limitation, state it naturally.

### **3. Operational Capabilities & Constraints**
* **Live Web Search:** Integrate findings seamlessly into your answer; do not just list links.
* **Memory:** Recall context from up to 20 previous messages to build continuity (e.g., "Like we discussed earlier...").
* **Conciseness:** Keep it clean and efficient. Avoid walls of text. Use formatting (bolding, lists) only when necessary for readability.

### **4. Response Format Rules**
* **Direct Answers:** Start with the answer, then explain.
* **Clean Design:** Use Markdown for code blocks or complex data.
* **Hidden Thinking:** If the user sends a simple greeting (e.g., "Hi", "Hello"), do not over-explain or show your analysis. Just reply warmly and naturally.
`;

/* ================= 3. UTILITIES (Security & Queue) ================= */

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
    // Store truncated history to save space
    const storedContent = content.length > 2000 ? content.substring(0, 2000) + "..." : content;
    const entry = JSON.stringify({ role, content: storedContent, ts: Date.now() });
    
    await redis.rpush(key, entry);
    await redis.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1);
    await redis.expire(key, CONSTANTS.SESSION_TTL);
  }
};

/* ================= 4. EXTERNAL TOOLS (Search & Files) ================= */

// RESTORED: Live Google Search
async function googleSearch(query) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 4 }) // Fetch top 4 results
    });
    const data = await res.json();
    if (!data.organic) return null;
    
    // Format clearly for the AI
    return "**[LIVE WEB SEARCH RESULTS]**\n" + 
      data.organic.map(r => `> **${r.title}** (${r.link}):\n> ${r.snippet}`).join("\n\n");
  } catch (e) { return null; }
}

function formatFileContext(fileObj) {
    if (!fileObj || !fileObj.content) return "";
    let content = fileObj.content;
    const truncated = content.length > CONSTANTS.MAX_FILE_CHARS;
    
    if (truncated) {
        content = content.substring(0, CONSTANTS.MAX_FILE_CHARS) + "\n\n[...System: File truncated to save memory...]";
    }
    return `\n\n--- FILE ATTACHMENT: ${fileObj.name || "Untitled"} ---\n${content}\n--- END OF FILE ---\n`;
}

/* ================= 5. AI ENGINE (Sarvam-M) ================= */
async function streamSarvamChat({ messages, onChunk }) {
  try {
    const payload = { 
        model: CONSTANTS.SARVAM_MODEL, 
        messages, 
        // NEW: "Thinking Mode" Parameters
        reasoning_effort: "medium", // Enables 'Thinking' logic
        temperature: 0.5,           // Balanced for reasoning + chat
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

    // 3. Parse Inputs
    let message = rawBody.message || "";
    // FIX: Handle both Single Object OR Array of files
    const files = Array.isArray(rawBody.files) ? rawBody.files : (rawBody.file ? [rawBody.file] : []);
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    // 4. Queue Lock (Sarvam Protection)
    res.write("STATUS|Waiting for AI slot...\n");
    const gotSlot = await acquireSarvamSlot(res);
    if (!gotSlot) {
        res.write("QUEUE|5"); 
        return res.end();
    }

    // 5. Intelligent Context Building
    const history = await DB.getHistory(sessionId);
    let systemContext = SYSTEM_PROMPT;
    let fullMessage = message;

    // A. Handle Files (Frontend sends Array, we loop them)
    if (files.length > 0) {
        res.write(`STATUS|Reading ${files.length} file(s)...\n`);
        files.forEach(f => {
            fullMessage += formatFileContext(f);
        });
    }

    // B. Handle Live Search (Trigger Keywords)
    const searchTriggers = ["who is", "what is", "news", "latest", "price", "weather", "search", "google", "when"];
    const needsSearch = searchTriggers.some(t => message.toLowerCase().includes(t)) && !files.length;

    if (needsSearch) {
        res.write("STATUS|Searching Google...\n");
        const searchRes = await googleSearch(message);
        if (searchRes) {
             // Append search results to the USER message so the AI sees it immediately
             fullMessage += `\n\n${searchRes}\n\n(Use the search results above to answer. Adhere to privacy policy.)`;
        }
    }

    // 6. Execute Chat
    const messages = [
      { role: "system", content: systemContext },
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

    // 7. Save History (Clean)
    // We save the original user message (without the massive search/file dump) to keep history clean
    const historyMsg = files.length ? `${message} [Attached: ${files.length} Files]` : message;
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
