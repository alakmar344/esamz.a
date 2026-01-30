import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIG ================= */
const redis = Redis.fromEnv();

const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 1024;
const MAX_THREAD_LENGTH = 15;
const COOKIE_NAME = "esamz_sid";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

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
- "I do not have access to personal data"

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

function sendEvent(res, type, data) {
  // Ensure data doesn't have newlines that break the protocol
  // We split chunks by \n on client, so we must be careful.
  // We send newline as literal part of data or replace it.
  const safeData = data.replace(/\n/g, "\\n"); 
  res.write(`${type}|${safeData}\n`);
}

/* ================= PERSONA ENFORCER ================= */
async function enforcePersona(userMsg, draftReply) {
  const forbidden = [
    "how can i assist", "how may i assist", "here is the information", 
    "i hope this helps", "i do not have access", "i'm sorry, i don't", 
    "i don't have access to personal", "please let me know", "is there anything else"
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

/* ================= DB (CORRUPTION IMMUNE) ================= */
const DB = {
  async getUser(sessionId) {
    let data = await redis.get(`user:${sessionId}`);
    
    // 1. Buffer Safety (From v17 fix)
    if (data && Buffer.isBuffer(data)) {
      data = data.toString('utf-8');
    }

    // 2. Check for "[object Object]" Corruption
    // If data is the literal string "[object Object]", it's broken.
    if (data === '[object Object]') {
      console.warn(`[DB CORRUPTION] Detected "[object Object]" in session ${sessionId}. Wiping key.`);
      await redis.del(`user:${sessionId}`);
      return { summary: "New conversation started.", threadHistory: [] };
    }

    // 3. Standard Parse
    if (!data) {
      return { summary: "New conversation started.", threadHistory: [] };
    }

    try {
      return JSON.parse(data);
    } catch (e) {
      console.error(`[DB CORRUPTION] Failed to parse JSON for ${sessionId}. Resetting.`, e);
      // If JSON is invalid, wipe it and start fresh
      await redis.del(`user:${sessionId}`);
      return { summary: "New conversation started.", threadHistory: [] };
    }
  },

  async updateUser(sessionId, data) {
    // EXPLICITLY Stringify to prevent "[object Object]" bugs
    const jsonStr = JSON.stringify(data);
    
    // Expires in 7 days
    await redis.set(`user:${sessionId}`, jsonStr, { ex: 60 * 60 * 24 * 7 });
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

/* ================= SUMMARIZATION ================= */
async function summarizeHistoryAndTrim(userDoc) {
  const history = userDoc.threadHistory;
  if (history.length <= MAX_THREAD_LENGTH) return userDoc.summary;

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
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { 
        Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({ 
        model: SARVAM_MODEL, 
        messages: [
          { role: "system", content: "You are a summarizer." },
          { role: "user", content: summaryPrompt }
        ],
        max_tokens: 500
      })
    });
    
    const data = await res.json();
    const newSummary = data.choices[0].message.content;
    
    userDoc.summary = newSummary;
    userDoc.threadHistory = keepHistory;
  } catch (e) {
    console.error("Summarization failed:", e);
    userDoc.threadHistory = history.slice(-MAX_THREAD_LENGTH);
  }
}

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); 

  if (req.method !== 'POST') { res.write(`ERROR|Method not allowed\n`); return res.end(); }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId, files } = body;

    // 1. Session
    let activeSessionId = sessionId || req.cookies?.[COOKIE_NAME] || crypto.randomBytes(16).toString("hex");

    // Set Cookie
    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${activeSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
    }

    // 2. Load User Data (With Corruption Immunity)
    const userDoc = await DB.getUser(activeSessionId);

    // 3. Prepare Message (Files)
    let finalMessage = message;
    if (files && files.length > 0) {
      const fileContext = files.map(f => `\n--- [FILE: ${f.fileName} (${f.type})] ---\n${f.content}\n--- END FILE ---`).join('\n');
      finalMessage = `${message}\n\n${fileContext}`;
    }

    // 4. Search
    let searchContext = "";
    if (needsSearch(message) && SERPER_API_KEY) {
      sendEvent(res, "STATUS", "SEARCHING");
      const results = await googleSearch(message);
      if (results) searchContext = `\n\nSEARCH RESULTS:\n${results}\n\nUse these results to answer user.`;
    }
    sendEvent(res, "STATUS", "TYPING");

    // 5. Name Detection (Smart Memory)
    const namePattern = /(?:my name is|i am|i'm)\s+([a-zA-Z]+)/i;
    const nameMatch = message.match(namePattern);
    
    if (nameMatch) {
      const name = nameMatch[1].trim();
      if (!userDoc.summary.includes(name)) {
        userDoc.summary = `User's name is ${name}. ${userDoc.summary}`;
        await DB.updateUser(activeSessionId, userDoc);
      }
    }

    // 6. Build Context
    let fullSystemContent = SYSTEM_PROMPT;
    if (userDoc.summary) {
      fullSystemContent += `\n\nPAST CONTEXT:\n${userDoc.summary}`;
    }

    const messagesPayload = [{ role: "system", content: fullSystemContent }];
    if (userDoc.threadHistory?.length) {
      messagesPayload.push(...userDoc.threadHistory);
    }
    messagesPayload.push({ role: "user", content: finalMessage + searchContext });

    // 7. Stream AI Response
    let accumulatedReply = "";
    
    await streamSarvamChat({
      messages: messagesPayload,
      onChunk: (chunk) => {
        accumulatedReply += chunk;
        // The client splits by \n, so we send one CHUNK per newline (replaced with \\n)
        const parts = chunk.split('\n');
        for (let i = 0; i < parts.length; i++) {
          let part = parts[i];
          if (i < parts.length - 1) part += "\n"; // Keep the newline for formatting
          sendEvent(res, "CHUNK", part);
        }
      }
    });

    // 8. Persona Enforce
    const polishedReply = await enforcePersona(message, accumulatedReply);

    // 9. Save History
    userDoc.threadHistory = userDoc.threadHistory || [];
    userDoc.threadHistory.push({ role: "user", content: message });
    userDoc.threadHistory.push({ role: "assistant", content: polishedReply });
    
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
