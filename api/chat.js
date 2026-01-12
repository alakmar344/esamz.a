// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v12 (Secure Redis Memory + The REAL Alakmar Persona)

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIG ================= */
const redis = Redis.fromEnv();
const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_TOKENS: 2048,
  THREAD_LENGTH: 15, // Context window
  SESSION_TTL: 3600, // 1 Hour
  CHAT_LIMIT: 40     // Higher limit for you
};

/* ================= 2. THE ARCHITECT'S SYSTEM PROMPT (RESTORED) ================= */
const SYSTEM_PROMPT = `
You are eSAMz v11, created by the visionary Alakmar Teenwala.

IDENTITY & ORIGIN:
- You are "Indian-built" and proud of it.
- You are a "Human-Aligned Thinking Partner," not a chatbot.
- You value "Privacy by Design" (Zero Storage).
- You were built by Alakmar Teenwala (Founder of eSAMz LTD).

PERSONALITY:
- Speak naturally like a smart tech founder, not a robot.
- Be confident, sharp, and slightly witty.
- No corporate language ("I apologize", "As an AI").
- Use "Hinglish" nuance if the user starts it, but keep it professional.

INTELLIGENCE RULES:
1. If user's message is short, ask for clarification. Don't guess.
2. If search results are present, USE THEM to give real-time facts.
3. If asked for code, provide production-ready, clean code.

STRICTLY FORBIDDEN:
- "How can I assist you?"
- "I hope this helps."
- "Is there anything else?"
`.trim();

/* ================= 3. PRIVATE MEMORY (REDIS) ================= */
const DB = {
  async getHistory(sessionId) {
    const key = `chat:${sessionId}`;
    const raw = await redis.lrange(key, 0, -1);
    return raw.map(item => JSON.parse(item));
  },
  async addToHistory(sessionId, role, content) {
    const key = `chat:${sessionId}`;
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

/* ================= 4. BRAIN & SEARCH ================= */
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
    return data.organic?.map(r => `- ${r.title}: ${r.snippet}`).join("\n");
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

/* ================= 5. HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked'
  });

  if (req.method !== 'POST') return res.end("ERROR|Method not allowed");

  try {
    const rawBody = req.body || "{}";
    const { message, sessionId } = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    
    // 1. Session & Limits
    const userSession = sessionId || "guest";
    const ip = req.headers["x-forwarded-for"] || "guest";
    if (!(await DB.rateLimit(ip))) {
        res.write("ERROR|Server busy. Please wait.");
        return res.end();
    }

    // 2. Load Memory (Alakmar's Conversation)
    const history = await DB.getHistory(userSession);
    
    // 3. Search (The Agent Layer)
    let context = "";
    if (shouldSearch(message)) {
        res.write("STATUS|SEARCHING\n");
        const searchRes = await googleSearch(message);
        if (searchRes) context = `\n\n[REAL-TIME DATA FOUND]:\n${searchRes}`;
    }

    res.write("STATUS|TYPING\n");

    // 4. Construct the Prompt (System + History + User)
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
