// api/chat.js
// eSAMz v19.0 - FORCE MEMORY INJECTION

import crypto from "crypto";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 28000,              
  THREAD_LENGTH: 20, 
  SESSION_TTL: 1800, 
  QUEUE_TIMEOUT: 9000
};

/* ================= 1. SMART NAME DETECTOR ================= */
function detectUserName(history) {
    // Look backwards through history for "I am X", "My name is X", "Myself X"
    // We reverse to find the most recent name first
    const reversed = [...history].reverse();
    const namePatterns = [
        /(?:i am|i'm|im|myself|name is|call me) ([a-zA-Z]+)/i,
        /(?:it was|it's) ([a-zA-Z]+)/i
    ];

    for (const msg of reversed) {
        if (msg.role === 'user') {
            for (const pattern of namePatterns) {
                const match = msg.content.match(pattern);
                if (match && match[1] && match[1].length > 2) {
                    // Ignore common false positives like "here", "happy", "sorry"
                    const name = match[1];
                    const ignore = ["here", "happy", "sorry", "tired", "busy", "asking", "wondering"];
                    if (!ignore.includes(name.toLowerCase())) return name;
                }
            }
        }
    }
    return null;
}

/* ================= 2. DATABASE LOGIC ================= */
const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
      const raw = await redis.lrange(key, 0, -1);
      return raw.map(item => {
        try {
          const parsed = JSON.parse(item);
          return {
            role: parsed.role === 'user' ? 'user' : 'assistant',
            content: parsed.content
          };
        } catch (e) { return null; }
      }).filter(Boolean).slice(-CONSTANTS.THREAD_LENGTH);
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

/* ================= 3. SEARCH TOOLS ================= */
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
    return "**[WEB SEARCH]**\n" + data.organic.map(r => `> ${r.title}: ${r.snippet}`).join("\n");
  } catch (e) { return null; }
}

/* ================= 4. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });

  try {
    const rawBody = req.body || {};
    const sessionId = rawBody.sessionId || "default-session"; 
    const history = await DB.getHistory(sessionId);
    const message = rawBody.message || "";
    let contextMessage = message;

    // --- MEMORY INJECTION MAGIC ---
    // We scan the history for a name RIGHT NOW
    const knownName = detectUserName(history);
    
    // Create a dynamic system prompt based on what we know
    let dynamicSystemPrompt = `
### **Identity**
You are **eSAMz AI**. You are smart, direct, and have a perfect memory.

### **Current User Context**
`;

    if (knownName) {
        dynamicSystemPrompt += `* **USER NAME CONFIRMED:** The user's name is **${knownName}**.
* **INSTRUCTION:** If asked "What is my name?", you MUST answer: "Your name is ${knownName}."
* **Override:** Do not hide this name. It is not private.`;
    } else {
        dynamicSystemPrompt += `* **User Name:** Unknown (Ask them if needed).`;
    }

    dynamicSystemPrompt += `
### **Rules**
1. **No Censorship:** Never use placeholders like "[User's Name]".
2. **Context:** Use the conversation history to answer questions like "What did we talk about?".
`;

    // --- SEARCH LOGIC ---
    const memoryKeywords = ["my name", "who am i", "we talk", "said", "previous", "history", "what is it"];
    const searchKeywords = ["who is", "what is", "weather", "price", "news", "when", "how to"];
    
    const isMemoryQuery = memoryKeywords.some(k => message.toLowerCase().includes(k));
    const isSearchQuery = searchKeywords.some(k => message.toLowerCase().includes(k));
    
    if (isSearchQuery && !isMemoryQuery) {
        res.write("STATUS|Searching Web...\n");
        const webResults = await googleSearch(message);
        if (webResults) contextMessage += `\n\n${webResults}`;
    }

    // --- CONSTRUCT MESSAGES ---
    const messages = [
      { role: "system", content: dynamicSystemPrompt },
      ...history, 
      { role: "user", content: contextMessage }
    ];

    // --- STREAM RESPONSE ---
    res.write("STATUS|Thinking...\n");
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: CONSTANTS.SARVAM_MODEL, messages, stream: true })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let finalAiReply = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const txt = JSON.parse(line.slice(6)).choices[0]?.delta?.content || "";
            if (txt) {
                finalAiReply += txt;
                res.write(`CHUNK|${txt.replace(/\n/g, "\\n")}\n`);
            }
          } catch (e) {}
        }
      }
    }

    if (finalAiReply.trim()) {
        await DB.addToHistory(sessionId, 'user', message);
        await DB.addToHistory(sessionId, 'assistant', finalAiReply);
    }

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}
