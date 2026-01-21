// api/chat.js
// eSAMz v13 - OPTIMIZED STREAMING + SMART SEARCH

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();
const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
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

2. If user's message is short (1–3 words), assume ambiguity and ask what they mean.

3. If user asks a factual question, answer directly and clearly.

4. If user asks for an explanation, explain in simple words.

5. If user asks for creative writing, write properly with structure.

6. Stay on topic. Do not drift.

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
            try { return JSON.parse(item); } catch(e) { return null; }
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

/* ================= 5. AI ENGINE (BUFFERED) ================= */
async function streamSarvamChat({ messages, onChunk }) {
  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ 
      model: CONSTANTS.SARVAM_MODEL, 
      messages, 
      temperature: 0.7, 
      max_tokens: CONSTANTS.MAX_TOKENS, 
      stream: true 
    })
  });
  
  if (!res.ok) throw new Error(`AI Provider Error: ${await res.text()}`);
  
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ""; // <--- NEW: Buffer to prevent "180 chunks" jitter
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
        if (buffer) onChunk(buffer); // Flush remaining text
        break;
    }

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");
    
    for (const line of lines) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const json = JSON.parse(line.slice(6));
          const txt = json.choices[0]?.delta?.content || "";
          
          if (txt) {
            buffer += txt;
            
            // SMART FLUSH: Only send if we have enough data or a natural pause
            // This prevents sending 1 byte at a time to the frontend
            if (buffer.length > 15 || buffer.includes(" ") || buffer.includes("\n") || buffer.includes(".")) {
                onChunk(buffer);
                buffer = "";
            }
          }
        } catch (e) {}
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

    // 3. SMART SEARCH (Fixed Hallucination)
    let context = "";
    const lowerMsg = message.toLowerCase();
    
    // Logic: Do not search if the user is asking about the project itself ("esamz", "alakmar")
    // This stops Google from returning irrelevant global news.
    const isInternalQuery = lowerMsg.includes("esamz") || lowerMsg.includes("alakmar");
    
    const needsSearch = (
        !isInternalQuery && // <--- Block search for internal topics
        (lowerMsg.includes("who is") || lowerMsg.includes("who are") || lowerMsg.includes("what is") || lowerMsg.includes("where is") || lowerMsg.includes("when is") || lowerMsg.includes("how much") || lowerMsg.includes("latest") || lowerMsg.includes("news") || lowerMsg.includes("recent") || lowerMsg.includes("update") || lowerMsg.includes("today") || lowerMsg.includes("trends") || lowerMsg.includes("price") || lowerMsg.includes("stock") || lowerMsg.includes("cost") || lowerMsg.includes("weather") || lowerMsg.includes("score") || lowerMsg.includes("winner") || lowerMsg.includes("google") || lowerMsg.includes("schedule") || lowerMsg.includes("release date") || lowerMsg.includes("current"))
    );

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
    await streamSarvamChat({
      messages,
      onChunk: (text) => {
        fullReply += text;
        // Escape newlines for safe transport over custom chunk protocol
        const safeText = text.replace(/\n/g, "\\n");
        res.write(`CHUNK|${safeText}\n`);
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
