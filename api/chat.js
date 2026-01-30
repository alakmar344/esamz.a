import crypto from "crypto";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  // Max tokens reduced slightly to leave room for response
  MAX_TOKENS: 28000,              
  THREAD_LENGTH: 20, // Keep last 20 messages (approx 10 turns)
  SESSION_TTL: 1800, // 7 Days
  QUEUE_TIMEOUT: 9000
};

/* ================= 1. SYSTEM PROMPT (UNCHAINED) ================= */
/* ================= 1. SYSTEM PROMPT (IDENTITY OVERRIDE) ================= */
const SYSTEM_PROMPT = `
### **Role & Identity**
You are **eSAMz AI**. You are helpful, smart, and have a perfect memory.

### **CRITICAL RULE: USER IDENTITY**
* **Context:** You have access to the conversation history. USE IT.
* **No Censorship:** If the user asks "What is my name?", **DO NOT** use placeholders like "[User's Name]".
* **Direct Answer:** Look at the history. If the user said "I am x", you MUST reply: "Your name is x."
* **Privacy Exception:** It is NOT a privacy violation to tell the user their own name.

### **Response Style**
* Be casual and direct.
* Never say "As an AI".
`;
/* ================= 2. DATABASE LOGIC ================= */
const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
      const raw = await redis.lrange(key, 0, -1);
      // Map Redis strings back to JSON objects
      return raw.map(item => {
        try {
          const parsed = JSON.parse(item);
          // CRITICAL: Standardize roles for the LLM
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
    const entry = JSON.stringify({ 
      role, 
      content, 
      ts: Date.now() 
    });
    await redis.rpush(key, entry);
    // Keep history clean (prevent infinite growth)
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
  // Set headers for streaming
  res.writeHead(200, { 
    'Content-Type': 'text/plain; charset=utf-8', 
    'Transfer-Encoding': 'chunked' 
  });

  try {
    const rawBody = req.body || {};
    
    // 1. Session Management (CRITICAL)
    // If frontend sends no ID, we make one, BUT memory will be empty.
    const sessionId = rawBody.sessionId || "default-session"; 
    
    // 2. Load History BEFORE processing
    const history = await DB.getHistory(sessionId);

    const message = rawBody.message || "";
    let contextMessage = message;

    // 3. INTELLIGENT SEARCH GATE
    // We only search if the user asks for NEW info. 
    // We BLOCK search if they ask about "me", "my name", "this chat".
    const memoryKeywords = ["my name", "who am i", "we talk", "said", "previous", "history", "what is it"];
    const searchKeywords = ["who is", "what is", "weather", "price", "news", "when", "how to"];
    
    const isMemoryQuery = memoryKeywords.some(k => message.toLowerCase().includes(k));
    const isSearchQuery = searchKeywords.some(k => message.toLowerCase().includes(k));
    
    // Only search if it is a search query AND NOT a memory query
    if (isSearchQuery && !isMemoryQuery) {
        res.write("STATUS|Searching Web...\n");
        const webResults = await googleSearch(message);
        if (webResults) {
            contextMessage += `\n\n${webResults}\n\n(Use this web info to answer)`;
        }
    }

    // 4. Construct the Conversation Array
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history, // <--- THIS WAS MISSING OR MALFORMED BEFORE
      { role: "user", content: contextMessage }
    ];

    // 5. Stream from Sarvam
    res.write("STATUS|Thinking...\n");
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { 
        Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({ 
        model: CONSTANTS.SARVAM_MODEL, 
        messages, 
        stream: true 
      })
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
            const json = JSON.parse(line.slice(6));
            const text = json.choices[0]?.delta?.content || "";
            if (text) {
                finalAiReply += text;
                res.write(`CHUNK|${text.replace(/\n/g, "\\n")}\n`);
            }
          } catch (e) {}
        }
      }
    }

    // 6. Save BOTH sides of the conversation
    // Only save if we actually generated a reply
    if (finalAiReply.trim().length > 0) {
        await DB.addToHistory(sessionId, 'user', message);
        await DB.addToHistory(sessionId, 'assistant', finalAiReply);
    }

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    console.error("Handler Error:", e);
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}
