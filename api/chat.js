import crypto from "crypto";

/* ================= CONFIG ================= */
const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 30048;
const COOKIE_NAME = "esamz_sid";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// CONTEXT LIMIT: 30,000 Characters
const MAX_CONTEXT_CHARS = 120000; 
// INACTIVITY TIMEOUT: 30 Minutes (in seconds)
const INACTIVITY_TIMEOUT_SEC = 30 * 60; 

const ALLOWED_ORIGINS = [
  "https://esamz.site",
  "https://www.esamz.site"
];

/* ================= SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, created by Alakmar Teenwala.
You are a smart, calm, sharp human-like conversationalist.
STRICTLY FORBIDDEN PHRASES: "How can I assist you", "Here is the information", "I hope this helps", "Please let me know", "Is there anything else", "I'm sorry, I don't have access", "I do not have access to personal data", "I don't know who you are".
MEMORY & CONTEXT RULES (CRITICAL): ALWAYS check conversation history provided below. If user says "My name is X", you MUST REMEMBER IT. If user asks "What is my name?", CHECK HISTORY and answer. Do NOT say "I don't have access".
SEARCH RULES: If search results are provided below, use them naturally in your answer. Do not mention search engines or sources unless asked.
STYLE: Speak like a human. Be direct.
`.trim();

/* ================= HELPERS ================= */
function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "unknown";
}

function sendEvent(res, type, data) {
  const safeData = data.replace(/\n/g, "\\n"); 
  res.write(`${type}|${safeData}\n`);
}

/* ================= CONTEXT MANAGER (30k Limit) ================= */
class ContextManager {
  constructor(maxChars) { this.maxChars = maxChars; }

  limit(messages) {
    const systemMsg = messages.find(m => m.role === 'system');
    const history = messages.filter(m => m.role !== 'system');
    const systemSize = systemMsg ? JSON.stringify(systemMsg).length : 0;
    let currentSize = systemSize;
    
    const limitedHistory = [];
    // Iterate backwards to keep newest messages
    for (let i = history.length - 1; i >= 0; i--) {
      const msgSize = JSON.stringify(history[i]).length;
      if (currentSize + msgSize > this.maxChars) break;
      currentSize += msgSize;
      limitedHistory.unshift(history[i]);
    }

    const finalPayload = [];
    if (systemMsg) finalPayload.push(systemMsg);
    finalPayload.push(...limitedHistory);
    
    // Security: Do not log content, just stats
    console.log(`[Context] Processed: ${currentSize}/${this.maxChars} chars. Messages: ${finalPayload.length}`);
    return finalPayload;
  }
}
const contextManager = new ContextManager(MAX_CONTEXT_CHARS);

/* ================= PERSONA ENFORCER ================= */
async function enforcePersona(userMsg, draftReply) {
  const forbidden = ["how can i assist", "here is the information", "i hope this helps", "i do not have access", "i'm sorry, i don't", "i don't have access to personal data", "please let me know", "is there anything else", "i don't know who you are"];
  const isRobotic = forbidden.some(phrase => draftReply.toLowerCase().includes(phrase));
  if (!isRobotic) return draftReply; 

  const correctionPrompt = `User said: "${userMsg}"\nAI Draft: "${draftReply}"\nThe AI Draft is too formal/robotic. Rewrite it as eSAMz. Rules: Speak like a normal, relaxed human. No "I don't have access". Be direct and clear.`;
  
  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: SARVAM_MODEL, messages: [{ role: "system", content: "You are eSAMz. Fix this reply." }, { role: "user", content: correctionPrompt }], max_tokens: 500 })
    });
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || draftReply;
  } catch (e) { return draftReply; }
}

/* ================= STATELESS SESSION STORE ================= */
// Manages the 30-minute rule and memory fallback
class ComplexSessionStore {
  constructor() { this.memoryStore = new Map(); }

  async getSession(id, clientHistory = null, clientLastActive = null) {
    const now = Date.now();
    const limitMs = INACTIVITY_TIMEOUT_SEC * 1000;

    // CASE 1: Client Sync (Stateless)
    if (clientHistory && Array.isArray(clientHistory)) {
      const timeDiff = clientLastActive ? (now - clientLastActive) : 0;
      // 30 MINUTE RULE
      if (timeDiff > limitMs) {
        console.log(`[Store] Session ${id} expired (${Math.round(timeDiff/1000)}s). Wiping.`);
        return { history: [], userName: null };
      }
      const name = this.extractName(clientHistory);
      return { history: clientHistory, userName: name };
    }

    // CASE 2: Server Memory (Fallback)
    if (this.memoryStore.has(id)) {
      const session = this.memoryStore.get(id);
      const timeDiff = now - session.lastActive;
      // 30 MINUTE RULE
      if (timeDiff > limitMs) {
        console.log(`[Store] Memory session expired. Deleting.`);
        this.memoryStore.delete(id);
        return { history: [], userName: null };
      }
      session.lastActive = now;
      this.memoryStore.set(id, session);
      return { history: session.history, userName: session.userName };
    }

    return { history: [], userName: null };
  }

  async saveMessage(id, role, content, currentHistory, currentName) {
    const newMsg = { role, content };
    const newHistory = [...currentHistory, newMsg];
    let userName = currentName;
    if (role === 'user') {
      const namePattern = /(?:my name is|i am|i'm)\s+([a-zA-Z]+)/i;
      const match = content.match(namePattern);
      if (match) userName = match[1].trim();
    }

    // Persist to Memory
    this.memoryStore.set(id, {
      history: newHistory,
      userName: userName,
      lastActive: Date.now()
    });
    return { history: newHistory, userName: userName };
  }

  extractName(history) {
    const namePattern = /(?:my name is|i am|i'm)\s+([a-zA-Z]+)/i;
    for (const msg of history) {
      if (msg.role === 'user') {
        const match = msg.content.match(namePattern);
        if (match) return match[1].trim();
      }
    }
    return null;
  }
}
const DB = new ComplexSessionStore();

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
  } catch (e) { return null; }
}

/* ================= AI STREAMING ================= */
async function streamSarvamChat({ messages, onChunk }) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) throw new Error("SARVAM_API_KEY not configured");

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${sarvamKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: SARVAM_MODEL, messages, temperature: 0.7, max_tokens: MAX_COMPLETION_TOKENS, stream: true })
  });

  if (!res.ok) throw new Error(`Sarvam API Error ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
        // [FIX] Process remaining buffer when stream ends
        if (buffer.trim()) {
            const lines = [buffer];
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data: ")) continue;
                const dataStr = trimmed.slice(6);
                if (dataStr === "[DONE]") continue;
                try {
                    const parsed = JSON.parse(dataStr);
                    const content = parsed.choices?.[0]?.delta?.content || "";
                    if (content) { fullContent += content; onChunk(content); }
                } catch (e) { /* Ignore */ }
            }
        }
        break;
    }

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
        if (content) { fullContent += content; onChunk(content); }
      } catch (e) { /* Ignore parse errors */ }
    }
  }
  return fullContent;
}

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  // 1. STRICT SECURITY HEADERS
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx streaming fix
  
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.jsdelivr.net cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' fonts.googleapis.com;");

  // CORS
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method !== 'POST') { res.write(`ERROR|Method not allowed\n`); return res.end(); }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId, clientHistory, clientLastActive } = body;

    // 2. Session Management
    let id = sessionId || req.cookies?.[COOKIE_NAME] || crypto.randomBytes(16).toString("hex");
    
    // Set Secure Cookie
    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${INACTIVITY_TIMEOUT_SEC}`);
    }

    // 3. Load Session (With 30-min enforcement)
    const sessionData = await DB.getSession(id, clientHistory, clientLastActive);
    let { history, userName } = sessionData;
    const currentName = userName || "User";

    let finalMessage = message;

    // 4. Search
    let searchContext = "";
    if (needsSearch(message) && SERPER_API_KEY) {
      sendEvent(res, "STATUS", "SEARCHING");
      const results = await googleSearch(message);
      if (results) searchContext = `\n\nSEARCH RESULTS:\n${results}\n\nUse these results to answer user.`;
    }
    sendEvent(res, "STATUS", "TYPING");

    // 5. Build Context
    let fullSystemContent = SYSTEM_PROMPT;
    if (currentName !== "User") {
      fullSystemContent += `\n\nUSER CONTEXT:\nThe user's name is "${currentName}". Use it naturally.`;
    }

    const rawMessagesPayload = [{ role: "system", content: fullSystemContent }];
    rawMessagesPayload.push(...history);
    rawMessagesPayload.push({ role: "user", content: finalMessage + searchContext });

    // 6. Apply 30k Character Limit
    const messagesPayload = contextManager.limit(rawMessagesPayload);

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
    const updatedSession = await DB.saveMessage(id, "user", message, history, currentName);
    const finalSession = await DB.saveMessage(id, "assistant", polishedReply, updatedSession.history, updatedSession.userName);

    // 9. Send Final Sync (Privacy: This is the only place history leaves server)
    const now = Date.now();
    sendEvent(res, "HISTORY_UPDATE", JSON.stringify(finalSession.history));
    sendEvent(res, "TIMESTAMP", now.toString());
    sendEvent(res, "DONE", id);
    res.end();

  } catch (error) {
    console.error("API System Error:", error.message); // Safe logging (no content)
    if (!res.headersSent) { res.write(`ERROR|${error.message}\n`); }
    res.end();
  }
}
