// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v13.1 (Original "Human-Like" Persona + Self-Healing Memory)

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIG ================= */
const redis = Redis.fromEnv();
const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_TOKENS: 6048,
  THREAD_LENGTH: 100, 
  SESSION_TTL: 1800, 
  CHAT_LIMIT: 40     
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

/* ================= 3. ROBUST DATABASE (SELF-HEALING) ================= */
const DB = {
  async getHistory(sessionId) {
    const key = `chat:${sessionId}`;
    const raw = await redis.lrange(key, 0, -1);
    
    // Self-Healing: Filter out corrupt data from old tests
    return raw.map(item => {
      try {
        // If it's not a string or looks like "[object Object]", skip it
        if (typeof item !== 'string' || item === "[object Object]") return null;
        return JSON.parse(item);
      } catch (e) { return null; }
    }).filter(item => item !== null);
  },

  async addToHistory(sessionId, role, content) {
    const key = `chat:${sessionId}`;
    // Always stringify to prevent corruption
    const entry = JSON.stringify({ role, content });
    await redis.rpush(key, entry);
    await redis.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1);
    await redis.expire(key, CONSTANTS.SESSION_TTL);
  },

  async rateLimit(ip) {
    const k = `rl:${ip}`;
    const c = await redis.incr(k);
    if (c === 1) await redis.expire(k, 60);
    return c <= CONSTANTS.CHAT_LIMIT;
  }
};

/* ================= 4. SEARCH TOOL ================= */
async function googleSearch(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 3 })
    });
    const data = await res.json();
    
    const answerBox = data.answerBox?.snippet || data.answerBox?.answer || "";
    const organic = data.organic?.map((r) => `- ${r.title}: ${r.snippet}`).join("\n");
    
    return `[REAL-TIME DATA]:\n${answerBox}\n${organic}`.trim();
  } catch (e) { return null; }
}

function shouldSearch(msg) {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  const ignore = ["my name", "who are you", "hello", "hi", "help", "code", "convert", "rewrite", "html", "css"];
  if (ignore.some(x => lower.includes(x))) return false;
  const triggers = ["price", "news", "latest", "today", "weather", "who is", "current", "stock", "usd to"];
  if (triggers.some(t => lower.includes(t))) return true;
  return (msg.endsWith("?") && msg.length > 15);
}

/* ================= 5. BRAIN ================= */
async function streamSarvamChat({ messages, onChunk }) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${sarvamKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ 
      model: CONSTANTS.SARVAM_MODEL, 
      messages: messages, 
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
      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        try {
          const json = JSON.parse(line.slice(6));
          const txt = json.choices[0]?.delta?.content || "";
          if (txt) onChunk(txt);
        } catch (e) { /* ignore */ }
      }
    }
  }
}

/* ================= 6. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked'
  });

  if (req.method !== 'POST') return res.end("ERROR|Method not allowed");

  try {
    const rawBody = req.body || "{}";
    const { message, sessionId } = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    
    // 1. Session Handling
    const userSession = sessionId || "guest";
    const ip = req.headers["x-forwarded-for"] || "guest";

    if (!(await DB.rateLimit(ip))) {
        res.write("ERROR|Server busy. Please wait.");
        return res.end();
    }

    // 2. Load Memory (Safe Load)
    const history = await DB.getHistory(userSession);
    
    // 3. Search Layer
    let context = "";
    if (shouldSearch(message)) {
        res.write("STATUS|SEARCHING\n");
        const searchRes = await googleSearch(message);
        if (searchRes) context = `\n\n${searchRes}\n\n(Use this live data to answer)`;
    }

    res.write("STATUS|TYPING\n");

    // 4. Construct Prompt (System + History + User)
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
        { role: "user", content: message + context }
    ];

    // 5. Stream Response
    let fullReply = "";
    await streamSarvamChat({
        messages,
        onChunk: (text) => {
            fullReply += text;
            const safe = text.replace(/\n/g, "\\n");
            res.write(`CHUNK|${safe}\n`);
        }
    });

    // 6. Save Memory (Securely on Server)
    await DB.addToHistory(userSession, 'user', message);
    await DB.addToHistory(userSession, 'assistant', fullReply);

    res.write("DONE|Done");
    res.end();

  } catch (e) {
    console.error(e);
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}
