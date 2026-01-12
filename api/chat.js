// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v14 (Cookie-Based Session + Original Persona + Robust Memory)

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIG ================= */
const redis = Redis.fromEnv();
const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_TOKENS: 2048,
  THREAD_LENGTH: 20, 
  SESSION_TTL: 31536000, // 1 Year (Persistent Memory)
  COOKIE_NAME: "esamz_session_v1"
};

/* ================= 2. THE ARCHITECT'S PERSONA ================= */
const SYSTEM_PROMPT = `
You are eSAMz v11, created by Alakmar Teenwala.

PERSONALITY:
- Speak naturally like a real person.
- Be friendly, but not silly.
- Be confident, not overdramatic.
- No corporate language.

INTELLIGENCE RULES:
1. If user's message is short, ask for clarification.
2. If search results are present, USE THEM.
3. If asked for code, provide production-ready code.

STRICTLY FORBIDDEN PHRASES:
- "How can I assist you"
- "I hope this helps"
- "Is there anything else"
`.trim();

/* ================= 3. MEMORY & TOOLS ================= */
const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    const raw = await redis.lrange(key, 0, -1);
    return raw.map(item => {
      try {
        if (typeof item !== 'string' || item.includes("[object Object]")) return null;
        return JSON.parse(item);
      } catch (e) { return null; }
    }).filter(x => x);
  },
  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    await redis.rpush(key, JSON.stringify({ role, content }));
    await redis.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1);
    await redis.expire(key, CONSTANTS.SESSION_TTL);
  }
};

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
  if (["hello", "hi", "code", "html"].some(x => lower.includes(x))) return false;
  return (msg.includes("price") || msg.includes("news") || msg.includes("who is") || (msg.endsWith("?") && msg.length > 15));
}

/* ================= 4. STREAMING ENGINE ================= */
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

/* ================= 5. MAIN HANDLER (COOKIE LOGIC) ================= */
export default async function handler(req, res) {
  // 1. Get or Create Session ID from Cookie
  const cookies = req.headers.cookie || "";
  let sessionId = cookies.match(new RegExp(`${CONSTANTS.COOKIE_NAME}=([^;]+)`))?.[1];
  let isNewSession = false;

  if (!sessionId) {
    sessionId = crypto.randomBytes(16).toString("hex");
    isNewSession = true;
  }

  // 2. Set Headers (Cookie + Stream)
  const cookieHeader = `${CONSTANTS.COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CONSTANTS.SESSION_TTL}`;
  
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'Set-Cookie': cookieHeader // <--- This saves the memory in the browser
  });

  if (req.method !== 'POST') return res.end("ERROR|Method not allowed");

  try {
    const { message } = JSON.parse(req.body);
    
    // 3. Load Memory using the Session ID
    const history = await DB.getHistory(sessionId);
    
    // 4. Search Layer
    let context = "";
    if (shouldSearch(message)) {
      res.write("STATUS|SEARCHING\n");
      const searchRes = await googleSearch(message);
      if (searchRes) context = `\n\n[REAL-TIME DATA]:\n${searchRes}`;
    }
    res.write("STATUS|TYPING\n");

    // 5. Generate Response
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
        res.write(`CHUNK|${text.replace(/\n/g, "\\n")}\n`);
      }
    });

    // 6. Save Memory
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
