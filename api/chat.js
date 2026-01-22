// api/chat.js
// eSAMz v13 - ULTIMATE EDITION
// Features: Wiki Grounding + Live Search + Redis Memory + Rate Limiting + Stream Buffering + FILE SUPPORT

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
// Initialize Redis
const redis = Redis.fromEnv();

// Global Constants
const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", // Explicitly setting the latest model
  MAX_TOKENS: 4096,
  THREAD_LENGTH: 20,   // Remembers last 20 messages
  SESSION_TTL: 1800,   // Session expires after 30 Minutes
  RATE_LIMIT: 10,      // Limit: 10 messages per minute per IP
  RATE_TTL: 60         // Reset limit every 60 seconds
};

/* ================= 2. SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, a highly advanced AI created by Alakmar Teenwala.

IDENTITY & BEHAVIOR:
- You are smart, calm, and conversational.
- You are NOT a corporate bot. You are a digital companion.
- Your creator is Alakmar Teenwala (Founder of eSAMz).
- You speak naturally, like a human, with confidence and clarity.

CORE INTELLIGENCE:
1. **Understand Intent**: If a query is vague, ask for clarification. Do not guess.
2. **Factual Accuracy**: Use provided search context or grounding to answer facts.
3. **Simplicity**: Explain complex topics in simple terms unless asked otherwise.
4. **Creativity**: If asked to write code or stories, use proper formatting and structure.

HANDLING FILES:
- The user may attach files. Their content will be labeled "--- FILE: [Name] ---".
- Read these files carefully to answer questions about code, text, or data.

FORBIDDEN BEHAVIORS:
- Do not say "As an AI language model".
- Do not say "I don't have personal opinions" (just decline politely).
- Do not be overly apologetic.

RESPONSE FORMAT:
- Use Markdown for formatting (bold, lists, code blocks).
- Keep responses concise unless a detailed explanation is needed.
`.trim();

/* ================= 3. UTILITIES (DB & SECURITY) ================= */

// Utility: Identify User (Session ID or IP)
function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  // Fallback to IP address for rate limiting
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

// Utility: Check Rate Limits
async function checkRateLimit(identifier) {
  try {
    const key = `ratelimit:${identifier}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, CONSTANTS.RATE_TTL);
    return count <= CONSTANTS.RATE_LIMIT;
  } catch (e) {
    console.error("REDIS RATE LIMIT ERROR:", e);
    return true; // Fail open (allow request) if Redis is down
  }
}

// Utility: Chat History Management
const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
        const raw = await redis.lrange(key, 0, -1);
        return raw.map(item => {
            try { 
                const entry = JSON.parse(item); 
                // Normalize legacy roles
                if (entry.role === 'assistant') entry.role = 'ai';
                return entry; 
            } catch(e) { 
                console.error("JSON PARSE ERROR IN HISTORY:", e);
                return null; 
            }
        }).filter(x => x);
    } catch(e) { 
        console.error("REDIS GET HISTORY ERROR:", e);
        return []; 
    }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    try {
        // Truncate content in history if it's too massive (save space)
        // We keep the full context for the immediate turn, but history can be summarized
        const storedContent = content.length > 15000 ? content.substring(0, 15000) + "...[truncated]" : content;
        
        const safeEntry = JSON.stringify({ role, content: storedContent, ts: Date.now() });
        const pipeline = redis.pipeline();
        pipeline.rpush(key, safeEntry);
        pipeline.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1); // Keep only last N messages
        pipeline.expire(key, CONSTANTS.SESSION_TTL);       // Refresh TTL
        await pipeline.exec();
    } catch (e) {
        console.error("REDIS ADD HISTORY ERROR:", e);
    }
  }
};

/* ================= 4. EXTERNAL TOOLS ================= */

// Tool: Google Search (Serper) - For REAL-TIME data
async function googleSearch(query) {
  if (!process.env.SERPER_API_KEY) {
      console.warn("SEARCH SKIPPED: Missing SERPER_API_KEY");
      return null;
  }
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
      console.error("GOOGLE SEARCH ERROR:", e);
      return null; 
  }
}

/* ================= 5. AI ENGINE (SARVAM + WIKI GROUNDING) ================= */
async function streamSarvamChat({ messages, onChunk, wikiGrounding }) {
  // Determine temperature
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
      
      // --- BUFFERING LOGIC ---
      let incomingBuffer = ""; 
      let sendBuffer = "";     

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
            // Flush remaining buffers
            if (sendBuffer) onChunk(sendBuffer.replace(/\n/g, "\\n"));
            break;
        }

        incomingBuffer += decoder.decode(value, { stream: true });
        const lines = incomingBuffer.split("\n");
        incomingBuffer = lines.pop(); // Keep incomplete line

        for (const line of lines) {
          if (line.startsWith("data: ") && !line.includes("[DONE]")) {
            try {
              const json = JSON.parse(line.slice(6));
              const txt = json.choices[0]?.delta?.content || "";
              
              if (txt) {
                sendBuffer += txt;
                // Minor optimization: only flush if buffer gets big enough or contains a space/punctuation
                // But for now, direct flush is safer for responsiveness
                const safeText = sendBuffer.replace(/\n/g, "\\n");
                onChunk(safeText);
                sendBuffer = "";
              }
            } catch (e) { /* Ignore parsing errors for empty lines */ }
          }
        }
      }
  } catch (e) {
      console.error("STREAM SARVAM CHAT ERROR:", e);
      throw e; // Re-throw to be handled by main handler
  }
}

/* ================= 6. MAIN API HANDLER ================= */
export default async function handler(req, res) {
  // Set Headers for Streaming & CORS
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*', 
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  });

  if (req.method === 'OPTIONS') return res.end();

  if (req.method !== 'POST') {
      res.write("ERROR|Method not allowed");
      return res.end();
  }

  try {
    const rawBody = req.body || {};
    let message = rawBody.message || "";
    const files = rawBody.files || []; // <--- NEW: Extract files
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    console.log(`[REQ] Session: ${sessionId.slice(0,6)}... | Files: ${files.length} | Msg Len: ${message.length}`);

    // 1. SECURITY CHECK
    const userKey = getUserIdentifier(req, rawBody);
    const isAllowed = await checkRateLimit(userKey);
    
    if (!isAllowed) {
        console.warn(`[LIMIT] Rate limit exceeded for ${userKey}`);
        res.write("ERROR|Rate limit exceeded (10 req/min).");
        return res.end();
    }

    // 2. PROCESS FILES (THE "EYE" FIX)
    if (Array.isArray(files) && files.length > 0) {
        let fileContext = "\n\n--- ATTACHED FILES ---\n";
        files.forEach((file, index) => {
            // Limit generic large files to avoid blowing up context window too fast
            const content = file.content || "";
            fileContext += `\nFILE ${index + 1}: ${file.fileName} (${file.type})\n\`\`\`\n${content}\n\`\`\`\n`;
        });
        message += fileContext;
        console.log(`[FILES] Appended ${files.length} files to message context.`);
    }

    // 3. RETRIEVE MEMORY
    const history = await DB.getHistory(sessionId);

    // 4. INTELLIGENCE: DETECT SEARCH NEEDS
    let context = "";
    const lowerMsg = message.toLowerCase();
    
    // Internal queries check
    const isInternalQuery = lowerMsg.includes("esamz") || lowerMsg.includes("alakmar") || lowerMsg.includes("teenwala");
    
    // Keywords
    const triggers = [
        "who is", "what is", "where is", "when is", "how much", 
        "latest", "news", "recent", "update", "today", "price", 
        "stock", "weather", "score", "winner", "schedule", 
        "history of", "explain"
    ];
    
    // Only search if not internal AND triggered AND no files attached (usually files imply coding/analysis task)
    const needsExternalKnowledge = !isInternalQuery && triggers.some(t => lowerMsg.includes(t)) && files.length === 0;

    // 4a. Live Google Search
    if (needsExternalKnowledge) {
      res.write("STATUS|SEARCHING\n");
      const searchRes = await googleSearch(message.slice(0, 200)); // Search only the first 200 chars (query)
      if (searchRes) {
          context = `\n\n[Live Search Context]:\n${searchRes}`;
      }
    }

    res.write("STATUS|TYPING\n");

    // 5. PREPARE PROMPT
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ 
          role: m.role === 'ai' ? 'assistant' : m.role, 
          content: m.content 
      })),
      { role: "user", content: message + context }
    ];

    // 6. STREAM GENERATION
    let fullReply = "";
    
    await streamSarvamChat({
      messages,
      wikiGrounding: needsExternalKnowledge, 
      onChunk: (text) => {
        fullReply += text;
        res.write(`CHUNK|${text}\n`);
      }
    });

    // 7. UPDATE MEMORY
    // Store the ORIGINAL user message (with files appended) or just the text? 
    // Usually better to store the full context so the AI remembers the code you sent in the next turn.
    await DB.addToHistory(sessionId, 'user', message);
    await DB.addToHistory(sessionId, 'assistant', fullReply);

    // 8. FINISH
    res.write("DONE|Success");
    res.end();

  } catch (e) {
    console.error("FATAL API ERROR:", e);
    // Send clean error to client
    res.write(`ERROR|Internal Server Error: ${e.message}`);
    res.end();
  }
}
