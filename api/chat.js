// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v10.2 (Redis + Server Cookie + 30m Strict Timeout + Bug Fixes)

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= SECURITY & REDIS ================= */
const redis = Redis.fromEnv();

function verifyServerIntegrity() {
  const raw = process.env.ESAMZ_INTERNAL_KEY;
  const hash = process.env.ESAMZ_KEY_HASH;
  if (!raw || !hash) throw new Error("Security keys not configured");
  
  const A = crypto.createHash("sha256").update(raw).digest("hex");
  if (A !== hash) throw new Error("Server integrity check failed");
}

/* ================= CONFIG ================= */
const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 5024;
const MAX_THREAD_LENGTH = 15; 
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const COOKIE_NAME = "esamz_sid";

// Rate Limit & Session Config
const CHAT_LIMIT_PER_MIN = 15; 
const SESSION_TTL_SEC = 1800; // 30 Minutes

/* ================= SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, created by Alakmar Teenwala.

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

/* ================= HELPERS ================= */
function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// Helper to parse cookies from header string
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list;
}

function sendEvent(res, type, data) {
  res.write(`${type}|${data}\n`);
}

/* ================= DB (REDIS) ================= */
const DB = {
  async getUser(sessionId) {
    const data = await redis.get(`user:${sessionId}`);
    return data || { summary: "New conversation started.", threadHistory: [] };
  },

  async updateUser(sessionId, data) {
    // Expires in 30 minutes of inactivity
    await redis.set(`user:${sessionId}`, data, { ex: SESSION_TTL_SEC });
  }
};

async function checkRateLimit(identifier) {
  const key = `rl:${identifier}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60); 
  return count <= CHAT_LIMIT_PER_MIN;
}

/* ================= SEARCH ================= */
function needsSearch(query) {
  const lower = query.toLowerCase();
  const exclude = ["my name", "i am", "i'm", "who am i", "my email", "my address", "remember that", "do you know me"];
  if (exclude.some(ex => lower.includes(ex))) return false;
  const triggers = ["latest", "news", "weather", "price", "search for", "current", "happening now", "stock price", "today", "capital of", "president of", "meaning of", "define"];
  return triggers.some(t => lower.includes(t));
}

function isMathQuery(msg) {
  return /[\d+\-*/=]/.test(msg);
}

async function googleSearch(query) {
  if (!SERPER_API_KEY) return null;
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 5 })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const answerBox = data.answerBox?.snippet || data.answerBox?.answer || "";
    const organic = data.organic?.map((r, i) => `${i+1}. ${r.title} - ${r.snippet}`).join("\n") || "";
    return (answerBox + "\n" + organic).trim();
  } catch (e) {
    console.error("Serper Error:", e);
    return null;
  }
}

/* ================= AI STREAMING ================= */
async function streamSarvamChat({ messages, temperature = 0.7, onChunk }) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) throw new Error("SARVAM_API_KEY not configured");

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${sarvamKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ 
      model: SARVAM_MODEL, 
      messages, 
      temperature, 
      max_tokens: MAX_COMPLETION_TOKENS,
      stream: true 
    })
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Sarvam API Error ${res.status}: ${errorText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; 

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const dataStr = trimmed.slice(6);
      if (dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr);
        const content = parsed.choices?.[0]?.delta?.content || "";
        if (content) {
          fullContent += content;
          onChunk(content);
        }
      } catch (e) { /* ignore */ }
    }
  }
  return fullContent;
}

/* ================= SUMMARIZATION ================= */
async function summarizeHistoryAndTrim(userDoc) {
  const history = userDoc.threadHistory;
  if (history.length <= MAX_THREAD_LENGTH) return userDoc.summary;

  // FIX: Ensure clean cut between User and Assistant
  let cutIndex = history.length - MAX_THREAD_LENGTH;
  if (cutIndex % 2 !== 0) cutIndex++;
  if (cutIndex < 0) cutIndex = 0;

  const messagesToSummarize = history.slice(0, cutIndex);
  const keepHistory = history.slice(cutIndex);

  // Safety: Remove leading assistant message if orphan
  if (keepHistory.length > 0 && keepHistory[0].role === "assistant") {
    keepHistory.shift();
  }

  const historyText = messagesToSummarize.map(m => `${m.role}: ${m.content}`).join("\n");
  
  const summaryPrompt = `
    Previous Summary: ${userDoc.summary || "None"}
    New Conversation: ${historyText}
    Create a concise summary of user's intent, current topic, and any key facts.
  `;

  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        model: SARVAM_MODEL, 
        messages: [{ role: "system", content: "You are a summarizer." }, { role: "user", content: summaryPrompt }],
        max_tokens: 500
      })
    });
    
    if(!res.ok) throw new Error("Summary failed");
    const data = await res.json();
    userDoc.summary = data.choices[0].message.content;
    userDoc.threadHistory = keepHistory;
  } catch (e) {
    console.error("Summarization failed:", e);
    userDoc.threadHistory = keepHistory;
  }
}

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); 

  try { verifyServerIntegrity(); } 
  catch (e) { res.write(`ERROR|${e.message}\n`); return res.end(); }
  
  if (req.method !== 'POST') { res.write(`ERROR|Method not allowed\n`); return res.end(); }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, files } = body;
    
    // 1. Cookie Management
    const cookies = parseCookies(req);
    let activeSessionId = cookies[COOKIE_NAME];
    
    // If no cookie, generate ID. 
    if (!activeSessionId) {
      activeSessionId = crypto.randomBytes(16).toString("hex");
    }

    // Refresh Cookie (Strict 30 Min Expiry)
    // SameSite=Lax allows the cookie to be sent on top-level navigations
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${activeSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`);

    // Rate Limit
    const ip = getIP(req);
    if (!(await checkRateLimit(activeSessionId)) || !(await checkRateLimit(ip))) {
      res.write(`ERROR|Rate limit exceeded. Please wait a moment.\n`);
      return res.end();
    }

    // 2. Load User Data
    const userDoc = await DB.getUser(activeSessionId);

    // 3. Prepare Message
    let finalMessage = message;
    if (files && files.length > 0) {
      const fileContext = files.map(f => `\n--- [FILE: ${f.fileName} (${f.type})] ---\n${f.content}\n--- END FILE ---`).join('\n');
      finalMessage = `${message}\n\n${fileContext}`;
    }

    // 4. Search
    let searchContext = "";
    if (needsSearch(message) && !isMathQuery(message) && SERPER_API_KEY) {
      sendEvent(res, "STATUS", "SEARCHING");
      const results = await googleSearch(message);
      if (results) searchContext = `\n\nSEARCH RESULTS:\n${results}\n\nUse these results to answer user.`;
    }
    sendEvent(res, "STATUS", "TYPING");

    // 5. Build Context
    let fullSystemContent = SYSTEM_PROMPT;
    if (userDoc.summary) {
      fullSystemContent += `\n\nPAST CONTEXT:\n${userDoc.summary}`;
    }

    const messagesPayload = [{ role: "system", content: fullSystemContent }];
    
    if (userDoc.threadHistory?.length) {
      // FIX: Sanitize history to prevent API 400 Errors
      while (userDoc.threadHistory.length > 0 && userDoc.threadHistory[0].role === "assistant") {
        userDoc.threadHistory.shift();
      }
      messagesPayload.push(...userDoc.threadHistory);
    }
    
    messagesPayload.push({ role: "user", content: finalMessage + searchContext });

    // 6. Stream AI Response
    let accumulatedReply = "";
    
    await streamSarvamChat({
      messages: messagesPayload,
      onChunk: (chunk) => {
        accumulatedReply += chunk;
        const parts = chunk.split('\n');
        for (let i = 0; i < parts.length; i++) {
          let part = parts[i];
          if (i < parts.length - 1) part += "\n"; 
          if (part) sendEvent(res, "CHUNK", part);
        }
      }
    });

    // 7. Save History (Async)
    userDoc.threadHistory = userDoc.threadHistory || [];
    userDoc.threadHistory.push({ role: "user", content: message });
    userDoc.threadHistory.push({ role: "assistant", content: accumulatedReply });
    
    if (userDoc.threadHistory.length > MAX_THREAD_LENGTH) {
      await summarizeHistoryAndTrim(userDoc);
    }
    
    await DB.updateUser(activeSessionId, userDoc);

    sendEvent(res, "DONE", activeSessionId);
    res.end();

  } catch (error) {
    console.error("API Error:", error);
    if (!res.headersSent) {
      res.write(`ERROR|${error.message}\n`);
    }
    res.end();
  }
}
