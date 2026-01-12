// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v15.1 (The Real System Prompt + Hybrid Memory + Self-Healing)

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIG ================= */
const redis = Redis.fromEnv();
const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_TOKENS: 7048,
  THREAD_LENGTH: 1000,
  SESSION_TTL: 1800, // 1 Year
  COOKIE_NAME: "esamz_id"
};

/* ================= 2. THE ORIGINAL SYSTEM PROMPT (RESTORED) ================= */
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

/* ================= 3. MEMORY LOGIC (SELF-HEALING) ================= */
const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
        const raw = await redis.lrange(key, 0, -1);
        // Self-Healing: Ignore corrupt data from old tests
        return raw.map(item => {
            if (typeof item === 'object' && item !== null) return item;
            try {
                if (typeof item === 'string' && !item.includes("[object Object]")) {
                    return JSON.parse(item);
                }
            } catch(e) {}
            return null;
        }).filter(x => x !== null);
    } catch(e) {
        console.error("Redis Error:", e);
        return [];
    }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    // Force stringify to ensure consistency
    const safeEntry = JSON.stringify({ role, content });
    await redis.rpush(key, safeEntry);
    await redis.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1);
    await redis.expire(key, CONSTANTS.SESSION_TTL);
  }
};

/* ================= 4. TOOLS (SEARCH) ================= */
async function googleSearch(query) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 3 })
    });
    const data = await res.json();
    return data.organic?.map(r => `- ${r.title}: ${r.snippet}`).join("\n");
  } catch (e) { return null; }
}

function shouldSearch(msg) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  const ignore = ["hello", "hi", "code", "html", "write", "rewrite", "convert"];
  if (ignore.some(x => lower.includes(x))) return false;
  return (msg.includes("price") || msg.includes("news") || msg.includes("who is") || (msg.endsWith("?") && msg.length > 15));
}

/* ================= 5. BRAIN (SARVAM) ================= */
async function streamSarvamChat({ messages, onChunk }) {
  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ 
      model: CONSTANTS.SARVAM_MODEL, 
      messages, 
      temperature: 0.5, 
      max_tokens: CONSTANTS.MAX_TOKENS, 
      stream: true 
    })
  });
  if (!res.ok) throw new Error(await res.text());
  
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const txt = JSON.parse(line.slice(6)).choices[0]?.delta?.content || "";
          if (txt) onChunk(txt);
        } catch (e) {}
      }
    }
  }
}

/* ================= 6. MAIN HANDLER (HYBRID SESSION) ================= */
export default async function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked'
  });

  if (req.method !== 'POST') return res.end("ERROR|Method not allowed");

  try {
    const rawBody = req.body || "{}";
    const bodyData = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    const message = bodyData.message || "";
    
    // 1. HYBRID SESSION: Prefer ID from Frontend, Fallback to Cookie
    const cookies = req.headers.cookie || "";
    const cookieId = cookies.match(new RegExp(`${CONSTANTS.COOKIE_NAME}=([^;]+)`))?.[1];
    
    // This is the key logic that makes memory work:
    let sessionId = bodyData.sessionId || cookieId;

    if (!sessionId) {
        sessionId = crypto.randomBytes(16).toString("hex");
    }

    // 2. Load History
    const history = await DB.getHistory(sessionId);
    
    // 3. Search
    let context = "";
    if (shouldSearch(message)) {
      res.write("STATUS|SEARCHING\n");
      const searchRes = await googleSearch(message);
      if (searchRes) context = `\n\n[REAL-TIME DATA]:\n${searchRes}`;
    }
    res.write("STATUS|TYPING\n");

    // 4. Prompt Construction
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
      { role: "user", content: message + context }
    ];

    // 5. Stream
    let fullReply = "";
    await streamSarvamChat({
      messages,
      onChunk: (text) => {
        fullReply += text;
        const safeText = text.replace(/\n/g, "\\n");
        res.write(`CHUNK|${safeText}\n`);
      }
    });

    // 6. Save (Async)
    // We save the response to Redis so the NEXT request sees it.
    await DB.addToHistory(sessionId, 'user', message);
    await DB.addToHistory(sessionId, 'assistant', fullReply);

    res.write("DONE|Done");
    res.end();

  } catch (e) {
    console.error(e);
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}
