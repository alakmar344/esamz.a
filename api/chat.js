import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIG ================= */
console.log("--> System: Initializing eSAMz Backend v22 (Hybrid Memory)...");
const redis = Redis.fromEnv();

const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 2048;
const MAX_HISTORY_LENGTH = 25; // We limit server memory to 25, frontend handles the rest
const COOKIE_NAME = "esamz_sid";
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SESSION_TTL_SEC = 30 * 60; // 30 minutes of inactivity for persistence

// List of allowed origins
const ALLOWED_ORIGINS = [
  "https://esamz.site",
  "https://www.esamz.site"
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

MEMORY & CONTEXT RULES
- You have access to conversation history (User & Assistant messages).
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
  if (Buffer.isBuffer(item)) {
    return item.toString('utf-8');
  }
  if (item === undefined || item === null) {
    return "";
  }
  return JSON.stringify(item);
}

/* ================= PERSONA ENFORCER ================= */
async function enforcePersona(userMsg, draftReply) {
  const forbidden = [
    "how can i assist", "how may i assist", "here is the information", 
    "i hope this helps", "i do not have access", "i'm sorry, i don't", 
    "i don't have access to personal data", "please let me know", "is there anything else",
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

/* ================= USER STATE (REDIS HASH) ================= */
const DB = {
  // Update User State (Session Persistence)
  async updateState(id, isTyping, lastSeenAt) {
    const pipeline = redis.pipeline();
    pipeline.hset(`state:${id}`, 'is_active', isTyping ? 'true' : 'false');
    
    if (lastSeenAt) {
        pipeline.hset(`state:${id}`, 'last_seen_at', lastSeenAt);
        // Refresh TTL on every user action
        pipeline.expire(`state:${id}`, SESSION_TTL_SEC);
    }

    await pipeline.exec();
    console.log(`[DB] Updated user state: ${id}`);
  },

  async getLastHistory(id) {
    // We use a simple Redis LIST for this. 
    // Server keeps last 20-25 messages to ensure continuity.
    const rawList = await redis.lrange(`chat:${id}`, -MAX_HISTORY_LENGTH, -1);
    const history = [];
    for (const item of rawList) {
      try {
        const msg = JSON.parse(item);
        history.push(msg);
      } catch (e) {
        console.warn(`[DB] Skipping corrupt history item.`);
      }
    }
    return history.reverse();
  },

  async addHistory(id, role, content) {
    const jsonStr = JSON.stringify({ role, content });
    
    const pipeline = redis.pipeline();
    pipeline.lpush(`chat:${id}`, jsonStr);
    pipeline.ltrim(`chat:${id}`, 0, MAX_HISTORY_LENGTH);
    pipeline.expire(`chat:${id}`, SESSION_TTL_SEC);
    
    // Update User State (Heartbeat)
    await DB.updateState(id, true, Date.now().toString());
    
    await pipeline.exec();
    console.log(`[DB] Saved message to history.`);
  },

  async clearHistory(id) {
    // Clears server history (e.g., New Chat button)
    await redis.del(`chat:${id}`);
    console.log(`[DB] Cleared history for ${id}`);
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
      } catch (e) {
        // Ignore parse errors for partial chunks
      }
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
    const { message, sessionId, files, history: clientHistory, action } = body;

    // 1. Session ID & Cookie
    let id = sessionId || req.cookies?.[COOKIE_NAME] || crypto.randomBytes(16).toString("hex");
    const ip = getIP(req);

    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}`);
    }

    // 2. ORIGIN LOCK
    const referer = req.headers.referer || "";
    const origin = req.headers.origin || "";
    const isAllowed = ALLOWED_ORIGINS.some(url => referer.includes(url) || origin.includes(url));

    if (!isAllowed) {
      console.warn(`[SECURITY] Unauthorized request from: ${referer || origin}`);
      res.write(`ERROR|Unauthorized Request: AI usage is restricted to esamz.site interface only.\n`);
      res.end();
      return;
    }

    // 3. HYBRID MEMORY MERGE
    // Get Server Memory (Last 25 messages)
    const serverHistory = await DB.getLastHistory(id);
    
    // Get Client Memory (Array of objects)
    let clientHistory = [];
    if (clientHistory && Array.isArray(clientHistory)) {
        clientHistory = clientHistory; // Use provided history
    }

    // Combine them (Server first, then Client)
    // This ensures user's last action (typing) is prioritized for memory
    const combinedHistory = [...serverHistory, ...clientHistory];

    // 4. HANDLE ACTIONS
    if (action === 'clear_history') {
        await DB.clearHistory(id);
        res.write(`DONE|History Cleared\n`);
        res.end();
        return;
    }

    if (action === 'sync_history') {
        res.write(`DONE|Synced\n`); // Already synced by default load
        res.end();
        return;
    }

    // 5. Search
    let searchContext = "";
    if (needsSearch(message) && SERPER_API_KEY) {
      sendEvent(res, "STATUS", "SEARCHING");
      const results = await googleSearch(message);
      if (results) searchContext = `\n\nSEARCH RESULTS:\n${results}\n\nUse these results to answer user.`;
    }
    sendEvent(res, "STATUS", "TYPING");

    // 6. Build Messages
    // Inject User State if needed (Optional feature for advanced usage)
    const messagesPayload = [{ role: "system", content: SYSTEM_PROMPT }];
    messagesPayload.push(...combinedHistory); // <--- HYBRID MEMORY
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

    // 8. Server-Side Save (Persistence)
    await DB.addHistory(id, "user", message);
    await DB.addHistory(id, "assistant", accumulatedReply);

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
