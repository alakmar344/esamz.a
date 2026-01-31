import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIG ================= */
console.log("--> System: Initializing eSAMz Backend v22 (Clean Architecture)...");
const redis = Redis.fromEnv();

const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 30048;
const MAX_THREAD_LENGTH = 25; // Server keeps last 25 messages. 
const COOKIE_NAME = "esamz_sid";
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SESSION_TTL_SEC = 30 * 60; // 30 Minutes of persistence

// List of allowed origins
const ALLOWED_ORIGINS = [
  "https://esamz.site",
  "https://www.esamz.site"
  // Add your local domain if testing locally
  // "http://localhost:3000" 
];

/* ================= SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, created by Alakmar Teenwala.

You are a smart, calm, sharp human-like conversationalist.
You are not a corporate assistant and not a robotic chatbot.

STRICTLY FORBIDDEN PHRASES
- "How can I assist you"
- "Here is the information"
- "I hope this helps"
- "Please let me know"
- "Is there anything else"
- "I'm sorry, I don't have access"
- "I do not have access to personal data"
- "I don't know who you are"

MEMORY RULES (CRITICAL)
- ALWAYS check conversation history before answering.
- If user says "My name is X", you MUST REMEMBER IT.
- If user asks "What is my name?", CHECK HISTORY and answer.
- Do NOT say "I don't have access".

SEARCH RULES
If search results are provided below, use them naturally in your answer.
Do not mention search engines or sources unless asked.

STYLE
- Speak like a human.
- Be direct.
`.trim();

/* ================= HELPERS ================= */
function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function sendEvent(res, type, data) {
  const safeData = data.replace(/\n/g, "\\n"); 
  res.write(`${type}|${safeData}\n`);
}

function safeStringify(item) {
  if (typeof item === 'string') {
    return item;
  }
  // Handle Buffers safely
  if (Buffer.isBuffer(item)) {
    return item.toString('utf-8');
  }
  if (item === undefined || item === null) {
    return "";
  }
  // Fallback for any other type (number, etc)
  return JSON.stringify(item);
}

/* ================= PERSONA ENFORCER ================= */
async function enforcePersona(userMsg, draftReply) {
  const forbidden = [
    "how can i assist", "how may i assist", "here is the information", 
    "i hope this helps", "i do not have access", "i'm sorry, i don't", 
    "i don't have access to personal", "please let me know", "is there anything else",
    "i don't know who you are", "i do not know who you are", "i don't know your name"
  ];

  const isRobotic = forbidden.some(phrase => draftReply.toLowerCase().includes(phrase));

  if (!isRobotic) return draftReply; 

  const correctionPrompt = `
User said: "${userMsg}"
AI Draft: "${draftReply}"

The AI Draft is too formal/robotic. Rewrite it as eSAMz.
Rules: 
- Speak like a normal, relaxed human.
- No "I don't have access".
- Be direct and clear.
`;

  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: SARVAM_MODEL,
        messages: [{ role: "system", content: "You are eSAMz. Fix this reply." }, { role: "user", content: correctionPrompt }],
        max_tokens: 500
      })
    });
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || draftReply;
  } catch (e) {
    return draftReply;
  }
}

/* ================= DB (REDIS LIST - BULLETPROOF) ================= */
const DB = {
  async updateActivity(id) {
    await redis.set(`activity:${id}`, Date.now().toString(), { ex: SESSION_TTL_SEC });
    await redis.expire(`chat:${id}`, SESSION_TTL_SEC);
    console.log(`[DB] Heartbeat for ${id}. Chat extended for 30m.`);
  },

  async getHistory(id) {
    console.log(`[DB] Loading history for ${id}`);
    const rawList = await redis.lrange(`chat:${id}`, -MAX_THREAD_LENGTH, -1);
    
    // STRICT FILTER: Only parse and return valid JSON. Skip bad items silently.
    const history = [];
    for (const item of rawList) {
      try {
        const strItem = (typeof item === 'string') ? item : item.toString('utf-8');
        
        if (strItem.trim() === '[object Object]') continue;
        
        const msg = JSON.parse(strItem);
        history.push(msg);
      } catch (e) {
        // Silently skip unparsable/corrupt items to prevent crashes
      }
    }
    return history.reverse();
  },

  async addMessage(id, role, content) {
    // EXPLICITLY Stringify to prevent corruption
    const jsonStr = JSON.stringify({ role, content });
    
    const pipeline = redis.pipeline();
    pipeline.rpush(`chat:${id}`, jsonStr);
    pipeline.ltrim(`chat:${id}`, 0, MAX_THREAD_LENGTH);
    
    // REFRESH ACTIVITY (Heartbeat)
    pipeline.set(`activity:${id}`, Date.now().toString(), { ex: SESSION_TTL_SEC });
    pipeline.expire(`chat:${id}`, SESSION_TTL_SEC);
    
    await pipeline.exec();
    console.log(`[DB] Saved msg & Refreshed TTL for ${id}.`);
  },

  async getName(id) {
    const name = await redis.get(`identity:${id}`);
    return name ? safeStringify(name) : null;
  },

  async setName(id, name) {
    await redis.set(`identity:${id}`, name, { ex: SESSION_TTL_SEC });
  }
};

/* ================= SEARCH ================= */
function needsSearch(query) {
  const lower = query.toLowerCase();
  const exclude = ["my name", "i am", "i'm", "who am i", "my email", "my address", "remember that", "do you know me"];
  if (exclude.some(ex => lower.includes(ex))) return false;
  const triggers = ["latest", "news", "weather", "price", "search for", "current", "happening now", "stock price", "today", "capital of", "president of", "meaning of", "define"];
  return triggers.some(t => lower.includes(t));
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
async function streamSarvamChat({ messages, onChunk }) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) throw new Error("SARVAM_API_KEY not configured");

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${sarvamKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ 
      model: SARVAM_MODEL, 
      messages, 
      temperature: 0.7,
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
      } catch (e) {}
    }
  }
  
  return fullContent;
}

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); 

  if (req.method !== 'POST') { res.write(`ERROR|Method not allowed\n`); return res.end(); }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId } = body;

    // 1. Session
    let id = sessionId || req.cookies?.[COOKIE_NAME] || crypto.randomBytes(16).toString("hex");
    const ip = getIP(req);

    // Set Cookie
    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`);
    }

    // 2. Load History
    const history = await DB.getHistory(id);
    const currentName = await DB.getName(id) || "User";

    // 3. Prepare Message
    let finalMessage = message;

    // 4. Search
    let searchContext = "";
    if (needsSearch(message) && SERPER_API_KEY) {
      sendEvent(res, "STATUS", "SEARCHING");
      const results = await googleSearch(message);
      if (results) searchContext = `\n\nSEARCH RESULTS:\n${results}\n\nUse these results to answer user.`;
    }
    sendEvent(res, "STATUS", "TYPING");

    // 5. Name Detection
    const namePattern = /(?:my name is|i am|i'm)\s+([a-zA-Z]+)/i;
    const nameMatch = message.match(namePattern);
    
    if (nameMatch) {
      const name = nameMatch[1].trim();
      if (currentName !== name) {
        console.log(`[MEMORY] User identified as ${name}`);
        await DB.setName(id, name);
      }
    }

    // 6. Build Context
    let fullSystemContent = SYSTEM_PROMPT;
    if (currentName !== "User") {
      fullSystemContent += `\n\nUSER CONTEXT:\nThe user's name is "${currentName}". Use it naturally.`;
    }

    const messagesPayload = [{ role: "system", content: fullSystemContent }];
    messagesPayload.push(...history); 
    messagesPayload.push({ role: "user", content: finalMessage + searchContext });

    // 7. Stream AI Response
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

    // 8. Persona Enforce & Save
    const polishedReply = await enforcePersona(message, accumulatedReply);
    
    await DB.addMessage(id, "user", message);
    await DB.addMessage(id, "assistant", polishedReply);

    sendEvent(res, "DONE", id);
    res.end();

  } catch (error) {
    console.error("API Error:", error);
    if (!res.headersSent) {
      res.write(`ERROR|${error.message}\n`);
    }
    res.end();
  }
}
