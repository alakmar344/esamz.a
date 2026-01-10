// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v9.4 (Fixed Streaming Header Issue)

import crypto from "crypto";

/* ================= SECURITY ================= */
function sha256(x) {
  return crypto.createHash("sha256").update(x).digest("hex");
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function verifyServerIntegrity() {
  const raw = process.env.ESAMZ_INTERNAL_KEY;
  const hash = process.env.ESAMZ_KEY_HASH;
  if (!raw || !hash) throw new Error("Security keys not configured");
  if (!timingSafeEqual(sha256(raw), hash)) throw new Error("Server integrity check failed");
  return true;
}

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

Object.freeze(SYSTEM_PROMPT);

/* ================= CONFIG ================= */
const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 2048;
const MAX_THREAD_LENGTH = 15;
const COOKIE_NAME = "esamz_sid";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

/* ================= MOCK DATABASE ================= */
const DB = {
  users: {},
  
  getUser(sessionId) {
    if (!this.users[sessionId]) {
      this.users[sessionId] = { summary: "New conversation started.", threadHistory: [] };
    }
    return this.users[sessionId];
  },

  updateUser(sessionId, data) {
    this.users[sessionId] = { ...this.getUser(sessionId), ...data };
  }
};

/* ================= SEARCH UTILS ================= */
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

/* ================= SARVAM API WRAPPERS ================= */
async function runSarvamChat({ messages, temperature = 0.7 }) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) throw new Error("SARVAM_API_KEY not configured");
  
  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${sarvamKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: SARVAM_MODEL, messages, temperature, max_tokens: MAX_COMPLETION_TOKENS })
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error("Sarvam API Error:", res.status, errorText);
    throw new Error(`Sarvam API Error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

/* ================= PERSONA ENFORCER ================= */
async function enforcePersona(userMsg, draftReply) {
  const forbidden = ["how can i assist", "how may i assist", "here is the information", "i hope this helps", "i do not have access", "i'm sorry, i don't", "please let me know", "is there anything else"];
  const isCorporate = forbidden.some(phrase => draftReply.toLowerCase().includes(phrase));
  if (!isCorporate) return draftReply; 
  const correctionPrompt = `User said: "${userMsg}"\nAI Draft: "${draftReply}"\nThe AI Draft is too formal/robotic. Rewrite it as eSAMz.\nRules: \n- Speak like a normal, relaxed human.\n- No "How can I assist".\n- Be direct and clear.`;
  try {
    const fixedReply = await runSarvamChat({
      messages: [{ role: "system", content: "You are eSAMz. Fix this reply." }, { role: "user", content: correctionPrompt }],
      temperature: 0.8
    });
    return fixedReply || draftReply;
  } catch (e) {
    return draftReply;
  }
}

/* ================= MEMORY LOGIC ================= */

/* ================= CONVERSATION SUMMARIZATION ================= */
async function summarizeHistoryAndTrim(userDoc) {
  const history = userDoc.threadHistory;
  if (history.length <= MAX_THREAD_LENGTH) return;

  const messagesToSummarize = history.slice(0, history.length - MAX_THREAD_LENGTH + 4);
  const keepHistory = history.slice(history.length - MAX_THREAD_LENGTH + 4);

  const historyText = messagesToSummarize.map(m => `${m.role}: ${m.content}`).join("\n");
  
  const summaryPrompt = `
    Previous Summary: ${userDoc.summary}
    
    New Conversation to Summarize:
    ${historyText}
    
    Create a concise summary of user's intent, current topic, and any key facts discussed in new conversation.
  `;

  try {
    const newSummary = await runSarvamChat({
      messages: [{ role: "system", content: "You are a summarizer." }, { role: "user", content: summaryPrompt }],
      temperature: 0.5
    });

    userDoc.summary = newSummary;
    userDoc.threadHistory = keepHistory;
  } catch (e) {
    console.error("Summarization failed, force trimming:", e.message);
    userDoc.threadHistory = history.slice(-MAX_THREAD_LENGTH);
  }
}

/* ================= STREAMING UTILS ================= */
function sendEvent(res, type, data) {
  res.write(`${type}|${data}\n`);
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* ================= MAIN LOGIC ================= */
async function runChat({ message, sessionId, files = [], res }) {
  verifyServerIntegrity();
  if (!message || typeof message !== "string") throw new Error("Invalid message format");

  const id = sessionId || crypto.randomBytes(16).toString("hex");
  const userDoc = DB.getUser(id);

  // 1. File Processing
  let finalMessage = message;
  if (files && files.length > 0) {
    const fileContext = files.map(f => `\n--- [FILE: ${f.fileName} (${f.type})] ---\n${f.content}\n--- END FILE ---`).join('\n');
    finalMessage = `${message}\n\n${fileContext}`;
  }

  // 2. Web Search Logic
  let searchContext = "";
  const shouldSearch = needsSearch(message) && !isMathQuery(message) && SERPER_API_KEY;

  if (shouldSearch) {
    sendEvent(res, "STATUS", "SEARCHING");
    const results = await googleSearch(message);
    if (results) searchContext = `\n\nSEARCH RESULTS:\n${results}\n\nUse these results to answer user.`;
    sendEvent(res, "STATUS", "TYPING"); 
  } else {
    sendEvent(res, "STATUS", "TYPING");
  }

  // 3. Build Payload (CRITICAL: Only ONE system message allowed)
  let fullSystemContent = SYSTEM_PROMPT;

  if (userDoc.summary) {
    fullSystemContent += `\n\nPAST CONTEXT:\n${userDoc.summary}`;
  }

  const messagesPayload = [{ role: "system", content: fullSystemContent }];

  // Append Conversation History
  if (userDoc.threadHistory?.length) {
    messagesPayload.push(...userDoc.threadHistory);
  }

  // Append Current User Message
  messagesPayload.push({ role: "user", content: finalMessage + searchContext });

  // 4. Get Draft & Enforce Persona
  const draftReply = await runSarvamChat({ messages: messagesPayload });
  const finalReply = await enforcePersona(message, draftReply);

  // 5. Update History
  const newHistory = (userDoc.threadHistory || []);
  newHistory.push({ role: "user", content: message });
  newHistory.push({ role: "assistant", content: finalReply });
  
  // 6. Summarize if history is too long
  if (newHistory.length > MAX_THREAD_LENGTH) {
    await summarizeHistoryAndTrim(userDoc);
  } else {
    userDoc.threadHistory = newHistory;
  }

  DB.updateUser(id, userDoc);
  return { reply: finalReply, sessionId: id };
}

/* ================= VERCEL HANDLER ================= */
export default async function handler(req, res) {
  // Set Initial Headers BEFORE any writing happens
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); 

  try { verifyServerIntegrity(); } 
  catch (e) { res.write(`ERROR|${e.message}\n`); return res.end(); }
  if (req.method !== 'POST') { res.write(`ERROR|Method not allowed\n`); return res.end(); }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId, files } = body;

    // 1. PRE-COMPUTE SESSION ID & COOKIE
    // We must do this BEFORE runChat because runChat calls res.write(), which locks headers.
    let activeSessionId = sessionId || req.cookies?.[COOKIE_NAME] || crypto.randomBytes(16).toString("hex");

    // 2. SET COOKIE HEADER NOW (Before any streaming)
    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      const cookieString = `${COOKIE_NAME}=${activeSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
      res.setHeader('Set-Cookie', cookieString);
    }

    // 3. Run Logic & Stream Response
    // We pass the activeSessionId so DB uses the same ID as the cookie
    const result = await runChat({ 
      message, 
      sessionId: activeSessionId, 
      files, 
      res 
    });

    // 4. Artificial Streaming (Word by Word Effect)
    const words = result.reply.split(' ');
    for (let i = 0; i < words.length; i++) {
      const chunk = words[i] + ' ';
      sendEvent(res, "CHUNK", chunk);
      await delay(30); 
    }

    // 5. Send Final End Signal
    sendEvent(res, "DONE", result.sessionId);

    res.end();

  } catch (error) {
    console.error("API Error:", error);
    // Only write error if headers haven't been sent (unlikely here, but safe practice)
    if (!res.headersSent) {
      res.write(`ERROR|${error.message}\n`);
    }
    if (!res.writableEnded) {
      res.end();
    }
  }
}
