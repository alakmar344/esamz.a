// api/chat.js
// eSAMz v13 - OPTIMIZED STREAMING + SMART SEARCH + ROBUST BUFFER FIX + WIKI GROUNDING

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();
const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", // Ensure this model supports wiki_grounding
  MAX_TOKENS: 4096,
  THREAD_LENGTH: 20,
  SESSION_TTL: 1800, // 30 Minutes
  RATE_LIMIT: 10,    // 10 messages per minute
  RATE_TTL: 60       
};

/* ================= 2. SYSTEM PROMPT (UNTOUCHED) ================= */
const SYSTEM_PROMPT = `
You are eSAMz v11, created by Alakmar Teenwala.

You are a smart, calm, sharp human-like conversationalist.
You are not a corporate assistant and not a robotic chatbot.

Your job is to understand intent first, then respond clearly and helpfully.

PERSONALITY
- Speak naturally like a real person.
- Be friendly, but not silly.
- Be confident, not overdramatic.
- No corporate language.

INTELLIGENCE RULES
1. If user's message is unclear, incomplete, or ambiguous, ask a clarification question.
   Never guess intent.
   Never hallucinate meaning.

2. If user asks a factual question, answer directly and clearly.

3. If user asks for an explanation, explain in simple words.

4. If user asks for creative writing, write properly with structure.

5. Stay on topic. Do not drift.

STRICTLY FORBIDDEN PHRASES
- "How can I assist you"
- "Here is the information"
- "I hope this helps"
- "Please let me know"
- "Is there anything else"
- "I'm sorry, I don't have access"

SEARCH USAGE
If search results are provided, use them naturally in your answer.
Do not mention search engines or sources unless asked.

STYLE
- Use full sentences.
- Be clear and concise.
- No fluff.
- No filler.
`.trim();

/* ================= 3. UTILITIES ================= */

// Helper: Get User ID
function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

// Helper: Check Rate Limits
async function checkRateLimit(identifier) {
  const key = `ratelimit:${identifier}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, CONSTANTS.RATE_TTL);
  return count <= CONSTANTS.RATE_LIMIT;
}

// Helper: Database (Chat History)
const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
        const raw = await redis.lrange(key, 0, -1);
        return raw.map(item => {
            try { 
                const entry = JSON.parse(item); 
                // FIX: Normalize legacy 'assistant' to 'ai' for consistency
                if (entry.role === 'assistant') entry.role = 'ai';
                return entry; 
            } catch(e) { return null; }
        }).filter(x => x);
    } catch(e) { return []; }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    const safeEntry = JSON.stringify({ role, content, ts: Date.now() });
    const pipeline = redis.pipeline();
    pipeline.rpush(key, safeEntry);
    pipeline.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1); 
    pipeline.expire(key, CONSTANTS.SESSION_TTL);
    await pipeline.exec();
  }
};

/* ================= 4. SEARCH TOOL ================= */
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
    return data.organic.map(r => `> ${r.title}: ${r.snippet}`).join("\n");
  } catch (e) { return null; }
}

/* ================= 5. AI ENGINE (WIKI GROUNDING ENABLED) ================= */
async function streamSarvamChat({ messages, onChunk, wikiGrounding }) {
  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { 
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({ 
      model: CONSTANTS.SARVAM_MODEL, 
      messages, 
      temperature: wikiGrounding ? 0.2 : 0.7, // Lower temp for grounded factual answers
      max_tokens: CONSTANTS.MAX_TOKENS, 
      stream: true,
      wiki_grounding: wikiGrounding // Enable wiki grounding if requested
    })
  });
  
  if (!res.ok) throw new Error(`AI Provider Error: ${await res.text()}`);
  
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  
  // --- BACKEND BUFFER FIX START ---
  let incomingBuffer = ""; // Buffer for incoming packets from Sarvam
  let sendBuffer = "";     // Buffer for outgoing chunks to Client
  // --- BACKEND BUFFER FIX END ---

  while (true) {
    const { done, value } = await reader.read();
    
    // --- CRITICAL FIX: HANDLE STREAM END ---
    if (done) {
        // 1. Flush any accumulated text waiting to be sent
        if (sendBuffer) {
             const safeText = sendBuffer.replace(/\n/g, "\\n");
             onChunk(safeText);
             sendBuffer = "";
        }

        // 2. FIX: Flush remaining data in incoming buffer
        // Sometimes the last packet doesn't end in \n or was cut off by timeout
        if (incomingBuffer.trim().length > 0) {
            const line = incomingBuffer;
            if (line.startsWith("data: ") && !line.includes("[DONE]")) {
                try {
                    const json = JSON.parse(line.slice(6));
                    const txt = json.choices[0]?.delta?.content || "";
                    if (txt) {
                        const safeText = txt.replace(/\n/g, "\\n");
                        onChunk(safeText);
                    }
                } catch (e) {
                    console.log("[Stream EOF] Could not parse final fragment:", e.message);
                }
            }
        }
        break;
    }
    // --------------------------------------

    // 1. Decode and add to incoming buffer
    incomingBuffer += decoder.decode(value, { stream: true });
    
    // 2. Split into lines
    const lines = incomingBuffer.split("\n");
    
    // 3. Keep the last incomplete line in buffer
    incomingBuffer = lines.pop();

    for (const line of lines) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const json = JSON.parse(line.slice(6));
          const txt = json.choices[0]?.delta?.content || "";
          
          if (txt) {
            sendBuffer += txt;
            
            // SIMPLIFIED FLUSH: Send chunks as they arrive to ensure integrity
            const safeText = sendBuffer.replace(/\n/g, "\\n");
            onChunk(safeText);
            sendBuffer = "";
          }
        } catch (e) {
            // Ignore parse errors
        }
      }
    }
  }
}

/* ================= 6. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Content-Type-Options': 'nosniff'
  });

  if (req.method !== 'POST') {
      res.write("ERROR|Method not allowed");
      return res.end();
  }

  try {
    const rawBody = req.body || {};
    const message = rawBody.message || "";
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    // 1. SECURITY: Rate Limit
    const userKey = getUserIdentifier(req, rawBody);
    const isAllowed = await checkRateLimit(userKey);
    
    if (!isAllowed) {
        res.write("ERROR|Rate limit exceeded. You can send 10 messages per minute.");
        return res.end();
    }

    // 2. HISTORY
    const history = await DB.getHistory(sessionId);

    // 3. SMART SEARCH + WIKI GROUNDING LOGIC
    let context = "";
    const lowerMsg = message.toLowerCase();
    
    // Logic: Do not search if user is asking about project itself ("esamz", "alakmar")
    // This stops Google from returning irrelevant global news.
    const isInternalQuery = lowerMsg.includes("esamz") || lowerMsg.includes("alakmar");
    
    // Trigger condition for Search and Grounding
    const needsSearch = (
        !isInternalQuery && // <--- Block search for internal topics
        (lowerMsg.includes("who is") || lowerMsg.includes("who are") || lowerMsg.includes("what is") || lowerMsg.includes("where is") || lowerMsg.includes("when is") || lowerMsg.includes("how much") || lowerMsg.includes("latest") || lowerMsg.includes("news") || lowerMsg.includes("recent") || lowerMsg.includes("update") || lowerMsg.includes("today") || lowerMsg.includes("trends") || lowerMsg.includes("price") || lowerMsg.includes("stock") || lowerMsg.includes("cost") || lowerMsg.includes("weather") || lowerMsg.includes("score") || lowerMsg.includes("winner") || lowerMsg.includes("google") || lowerMsg.includes("schedule") || lowerMsg.includes("release date") || lowerMsg.includes("current"))
    );

    // Optional: Keep Serper for real-time web results (Google), 
    // while Wiki Grounding handles general knowledge.
    if (needsSearch) {
      res.write("STATUS|SEARCHING\n");
      const searchRes = await googleSearch(message);
      if (searchRes) context = `\n\n[Real-time Search Results]:\n${searchRes}`;
    }

    res.write("STATUS|TYPING\n");

    // 4. GENERATE
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
      { role: "user", content: message + context }
    ];

    let fullReply = "";
    
    // Pass 'needsSearch' as 'wikiGrounding' trigger
    // If the query triggered search, we also enable wiki_grounding on Sarvam side for better accuracy.
    await streamSarvamChat({
      messages,
      wikiGrounding: needsSearch, // <--- Enabled Wiki Grounding here
      onChunk: (text) => {
        fullReply += text;
        // Protocol: CHUNK|text\n
        res.write(`CHUNK|${text}\n`);
      }
    });

    // 5. SAVE
    await DB.addToHistory(sessionId, 'user', message);
    await DB.addToHistory(sessionId, 'assistant', fullReply);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    console.error("API Error:", e);
    res.write(`ERROR|Server Error: ${e.message}`);
    res.end();
  }
}
