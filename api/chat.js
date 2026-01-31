import crypto from "crypto";

/* ================= CONFIG ================= */
console.log("--> System: Initializing eSAMz Backend v24.0 (Complex Stateless/In-Memory)...");

const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 30048;
const COOKIE_NAME = "esamz_sid"
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// CONTEXT LIMIT: 30,000 Characters
// This acts as a proxy for tokens (approx 7.5k-10k tokens depending on complexity)
const MAX_CONTEXT_CHARS = 120000; 

// INACTIVITY TIMEOUT: 30 Minutes (in seconds)
const INACTIVITY_TIMEOUT_SEC = 30 * 60; 

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

MEMORY & CONTEXT RULES (CRITICAL)
- You have access to the conversation history provided below.
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

/* ================= CONTEXT MANAGER (COMPLEX) ================= */
class ContextManager {
  constructor(maxChars) {
    this.maxChars = maxChars;
  }

  /**
   * Ensures the message array fits within the character limit.
   * Always preserves the System Prompt.
   * Removes oldest messages first.
   */
  limit(messages) {
    // 1. Separate System Prompt from History
    const systemMsg = messages.find(m => m.role === 'system');
    const history = messages.filter(m => m.role !== 'system');

    // 2. Calculate current size
    const systemSize = systemMsg ? JSON.stringify(systemMsg).length : 0;
    let currentSize = systemSize;
    
    // We start counting from the end (newest messages) to keep the most recent context
    // But usually, chat context is sequential. Let's iterate from newest to oldest
    // to keep the conversation flowing naturally.
    
    const limitedHistory = [];
    
    // Iterate backwards through history
    for (let i = history.length - 1; i >= 0; i--) {
      const msgSize = JSON.stringify(history[i]).length;
      
      if (currentSize + msgSize > this.maxChars) {
        break; // Limit reached
      }
      
      currentSize += msgSize;
      limitedHistory.unshift(history[i]); // Add to beginning of new array
    }

    // 3. Reconstruct
    const finalPayload = [];
    if (systemMsg) finalPayload.push(systemMsg);
    finalPayload.push(...limitedHistory);

    console.log(`[Context Manager] Size: ${currentSize}/${this.maxChars} chars. Messages: ${finalPayload.length}`);
    
    return finalPayload;
  }
}

const contextManager = new ContextManager(MAX_CONTEXT_CHARS);

/* ================= PERSONA ENFORCER ================= */
async function enforcePersona(userMsg, draftReply) {
  const forbidden = [
    "how can i assist", "how may i assist", "here is the information", 
    "i hope this helps", "i do not have access", "i'm sorry, i don't", 
    "i don't have access to personal data", "please let me know", "is there anything else",
    "i don't know who you are", "i do not know who you are", "i do not know your name"
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

/* ================= DB (COMPLEX STATELESS/IN-MEMORY HYBRID) ================= */
// In a serverless environment without Redis, we must accept that the "Server" is stateless.
// However, we can simulate persistence by checking the request body for existing history (Client State).
// This satisfies "Data survives server restart / page refresh" (because the client holds it).

class ComplexSessionStore {
  constructor() {
    // Fallback for in-memory if client doesn't send history (rare case)
    this.memoryStore = new Map(); 
  }

  /**
   * Resolves session based on ID.
   * 1. Checks if history is provided in the request (Client State). If yes, validates 30-min timer.
   * 2. If not, checks local memory (Server State). Validates 30-min timer.
   */
  async getSession(id, clientHistory = null, clientLastActive = null) {
    const now = Date.now();
    const limitMs = INACTIVITY_TIMEOUT_SEC * 1000;

    // CASE 1: Client is providing state (Stateless/Client-Persistence)
    if (clientHistory && Array.isArray(clientHistory)) {
      const timeDiff = clientLastActive ? (now - clientLastActive) : 0;
      
      // COMPLEX RULE: Delete data if > 30 mins inactive
      if (timeDiff > limitMs) {
        console.log(`[Store] Client session expired (${Math.round(timeDiff/1000)}s old). Wiping.`);
        return { history: [], userName: null };
      }

      // Valid session
      const name = this.extractName(clientHistory);
      return { history: clientHistory, userName: name };
    }

    // CASE 2: Server Memory (Fallback)
    if (this.memoryStore.has(id)) {
      const session = this.memoryStore.get(id);
      const timeDiff = now - session.lastActive;

      // COMPLEX RULE: Delete data if > 30 mins inactive
      if (timeDiff > limitMs) {
        console.log(`[Store] Memory session expired. Deleting.`);
        this.memoryStore.delete(id);
        return { history: [], userName: null };
      }

      // Update heartbeat
      session.lastActive = now;
      this.memoryStore.set(id, session);
      return { history: session.history, userName: session.userName };
    }

    // CASE 3: New Session
    return { history: [], userName: null };
  }

  async saveMessage(id, role, content, currentHistory, currentName) {
    const newMsg = { role, content };
    const newHistory = [...currentHistory, newMsg];
    
    // Update Name Logic
    let userName = currentName;
    if (role === 'user') {
      const namePattern = /(?:my name is|i am|i'm)\s+([a-zA-Z]+)/i;
      const match = content.match(namePattern);
      if (match) userName = match[1].trim();
    }

    // Persist to Memory (for backup)
    this.memoryStore.set(id, {
      history: newHistory,
      userName: userName,
      lastActive: Date.now()
    });

    return { history: newHistory, userName: userName };
  }

  extractName(history) {
    // Simple heuristic scan for name
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
  // Set headers for streaming
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); 

  // CORS handling (Basic)
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method !== 'POST') { 
    res.write(`ERROR|Method not allowed\n`); 
    return res.end(); 
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId, clientHistory, clientLastActive } = body;

    // 1. Session Management
    let id = sessionId || req.cookies?.[COOKIE_NAME] || crypto.randomBytes(16).toString("hex");
    const ip = getIP(req);

    // Set Cookie (Persistence signal)
    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${INACTIVITY_TIMEOUT_SEC}`);
    }

    // 2. Load Session (Hybrid Logic)
    // If client sends history, we use it (Stateless). Otherwise we check memory.
    const sessionData = await DB.getSession(id, clientHistory, clientLastActive);
    let { history, userName } = sessionData;

    // Normalize userName
    const currentName = userName || "User";

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

    // 5. Build Full Context (System + History)
    let fullSystemContent = SYSTEM_PROMPT;
    if (currentName !== "User") {
      fullSystemContent += `\n\nUSER CONTEXT:\nThe user's name is "${currentName}". Use it naturally.`;
    }

    const rawMessagesPayload = [{ role: "system", content: fullSystemContent }];
    rawMessagesPayload.push(...history);
    rawMessagesPayload.push({ role: "user", content: finalMessage + searchContext });

    // 6. Apply Complex Context Limit (30k Chars)
    // This ensures the AI uses its own context efficiently within limits
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

    // 8. Persona Enforce
    const polishedReply = await enforcePersona(message, accumulatedReply);
    
    // 9. Save State (Update History)
    const updatedSession = await DB.saveMessage(id, "user", message, history, currentName);
    const finalSession = await DB.saveMessage(id, "assistant", polishedReply, updatedSession.history, updatedSession.userName);

    // 10. Send Final Signal + New State (for client to capture)
    // We send the updated history and current timestamp so client can save it (survives refresh)
    const now = Date.now();
    // We send history in a specific event
    sendEvent(res, "HISTORY_UPDATE", JSON.stringify(finalSession.history));
    sendEvent(res, "TIMESTAMP", now.toString());
    
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
