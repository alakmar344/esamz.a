// api/chat.js
// eSAMz v13.2 - SMART SEARCH FIX
// Fixes: Prevents web search for personal questions ("What is my name?")

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 4096,
  THREAD_LENGTH: 20,
  SESSION_TTL: 1800,
  RATE_LIMIT: 10,
  RATE_TTL: 60
};

/* ================= 2. SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, a highly advanced AI created by Alakmar Teenwala.

IDENTITY & BEHAVIOR:
- You are smart, calm, and conversational.
- You are NOT a corporate bot. You are a digital companion.
- Your creator is Alakmar Teenwala (Founder of eSAMz).
- You speak naturally, like a human, with confidence and clarity.
-"If asked for historical or factual information and you do not have the context, state that you do not know. Do not invent names, dates, or events."

CORE INTELLIGENCE:
1. **Understand Intent**: If a query is vague, ask for clarification. Do not guess.
2. **Factual Accuracy**: Use provided search context or grounding to answer facts.
3. **Simplicity**: Explain complex topics in simple terms unless asked otherwise.
4. **Creativity**: If asked to write code or stories, use proper formatting and structure.

HANDLING FILES:
- The user may attach files. Their content will be labeled "--- FILE: [Name] ---".
- Read these files carefully to answer questions about code, text, or data.

RESPONSE FORMAT:
- Use Markdown for formatting (bold, lists, code blocks).
`.trim();

/* ================= 3. UTILITIES (DB & SECURITY) ================= */

function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

async function checkRateLimit(identifier) {
  try {
    const key = `ratelimit:${identifier}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, CONSTANTS.RATE_TTL);
    return count <= CONSTANTS.RATE_LIMIT;
  } catch (e) {
    console.error("REDIS LIMIT ERROR:", e);
    return true; 
  }
}

const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
        const raw = await redis.lrange(key, 0, -1);
        return raw.map(item => {
            try { 
                if (typeof item === 'object' && item !== null) return item;
                return JSON.parse(item); 
            } catch(e) { 
                return null; 
            }
        }).filter(x => x); 
    } catch(e) { 
        console.error("REDIS READ ERROR:", e);
        return []; 
    }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    try {
        const safeContent = typeof content === 'string' ? content : JSON.stringify(content);
        const truncated = safeContent.length > 15000 ? safeContent.substring(0, 15000) + "...[truncated]" : safeContent;
        const entryObj = { role, content: truncated, ts: Date.now() };
        
        const pipeline = redis.pipeline();
        pipeline.rpush(key, JSON.stringify(entryObj));
        pipeline.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1);
        pipeline.expire(key, CONSTANTS.SESSION_TTL);
        await pipeline.exec();
    } catch (e) {
        console.error("REDIS WRITE ERROR:", e);
    }
  }
};

/* ================= 4. EXTERNAL TOOLS ================= */

async function googleSearch(query) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { 
        "X-API-KEY": process.env.SERPER_API_KEY, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({ q: query, num: 3 })
    });
    const data = await res.json();
    if (!data.organic) return null;
    return data.organic.map(r => `> ${r.title}: ${r.snippet}`).join("\n");
  } catch (e) { 
      console.error("SEARCH ERROR:", e);
      return null; 
  }
}

/* ================= 5. AI ENGINE ================= */
async function streamSarvamChat({ messages, onChunk, wikiGrounding }) {
  const temperature = wikiGrounding ? 0.2 : 0.7;

  try {
      const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: { 
          Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({ 
          model: CONSTANTS.SARVAM_MODEL, 
          messages, 
          temperature: temperature,
          max_tokens: CONSTANTS.MAX_TOKENS, 
          stream: true,
          wiki_grounding: wikiGrounding 
        })
      });
      
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Sarvam API Error (${res.status}): ${errText}`);
      }
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      
      let incomingBuffer = ""; 
      let sendBuffer = "";     

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
            if (sendBuffer) onChunk(sendBuffer.replace(/\n/g, "\\n"));
            break;
        }

        incomingBuffer += decoder.decode(value, { stream: true });
        const lines = incomingBuffer.split("\n");
        incomingBuffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith("data: ") && !line.includes("[DONE]")) {
            try {
              const json = JSON.parse(line.slice(6));
              const txt = json.choices[0]?.delta?.content || "";
              
              if (txt) {
                sendBuffer += txt;
                const safeText = sendBuffer.replace(/\n/g, "\\n");
                onChunk(safeText);
                sendBuffer = "";
              }
            } catch (e) { }
          }
        }
      }
  } catch (e) {
      console.error("SARVAM STREAM ERROR:", e);
      throw e;
  }
}

/* ================= 6. MAIN API HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*', 
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  });

  if (req.method === 'OPTIONS') return res.end();

  try {
    const rawBody = req.body || {};
    let message = rawBody.message || "";
    const files = rawBody.files || [];
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    console.log(`[REQ] Session: ${sessionId.slice(0,6)}... | Files: ${files.length} | Msg: ${message.slice(0, 20)}...`);

    // 1. LIMIT CHECK
    const userKey = getUserIdentifier(req, rawBody);
    if (!(await checkRateLimit(userKey))) {
        res.write("ERROR|Rate limit exceeded.");
        return res.end();
    }

    // 2. FILES
    if (Array.isArray(files) && files.length > 0) {
        let fileContext = "\n\n--- ATTACHED FILES ---\n";
        files.forEach((file, index) => {
            const content = file.content || "";
            fileContext += `\nFILE ${index + 1}: ${file.fileName} (${file.type})\n\`\`\`\n${content}\n\`\`\`\n`;
        });
        message += fileContext;
    }

    // 3. HISTORY
    const history = await DB.getHistory(sessionId);

    // 4. INTELLIGENCE: SMART SEARCH LOGIC (FIXED)
    let context = "";
    const lowerMsg = message.toLowerCase();
    
    // a. Internal (Bot Info)
    const isInternal = lowerMsg.includes("esamz") || lowerMsg.includes("alakmar");
    
    // b. Personal (User Info) - NEW! <--- THIS FIXES YOUR ISSUE
    const isPersonal = lowerMsg.includes("my name") || 
                       lowerMsg.includes("who am i") || 
                       lowerMsg.includes("my age") ||
                       lowerMsg.includes("call me");

    // c. Search Triggers (External Info)
   const triggers = [
        "who is", "what is", "where is", "when is", "how to", 
        "news", "price", "stock", "weather", "latest", "recent",
        "history", "about", "explain", "define", "summary", "info" // <--- ADD THESE
    ];
    
    // Only search if it is NOT internal AND NOT personal
    const needsSearch = !isInternal && !isPersonal && 
                        triggers.some(t => lowerMsg.includes(t)) && 
                        files.length === 0;

    if (needsSearch) {
      res.write("STATUS|SEARCHING\n");
      const searchRes = await googleSearch(message.slice(0, 200)); 
      if (searchRes) context = `\n\n[Live Search Context]:\n${searchRes}`;
    }

    res.write("STATUS|TYPING\n");

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
      { role: "user", content: message + context }
    ];

    let fullReply = "";
    
    await streamSarvamChat({
      messages,
      wikiGrounding: needsSearch, 
      onChunk: (text) => {
        fullReply += text;
        res.write(`CHUNK|${text}\n`);
      }
    });

    // 5. SAVE
    await DB.addToHistory(sessionId, 'user', message);
    await DB.addToHistory(sessionId, 'assistant', fullReply);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    console.error("FATAL ERROR:", e);
    res.write(`ERROR|Server Error: ${e.message}`);
    res.end();
  }
}
