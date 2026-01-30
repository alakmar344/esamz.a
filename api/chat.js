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

/* ================= SECURITY ================= */
function verifyServerIntegrity() {
  // Optional: Add your hash check if needed
  return true;
}

/* ================= HELPERS ================= */
function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function sendEvent(res, type, data) {
  res.write(`${type}|${data}\n`);
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

/* ================= DB (REDIS) ================= */
const DB = {
  async getUser(sessionId) {
    const data = await redis.get(`user:${sessionId}`);
    // CRITICAL FIX: Parse the JSON string from Redis
    return data ? JSON.parse(data) : { summary: "New conversation started.", threadHistory: [] };
  },

  async updateUser(sessionId, data) {
    // Expires in 7 days
    await redis.set(`user:${sessionId}`, data, { ex: 60 * 60 * 24 * 7 });
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
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
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

  try { verifyServerIntegrity(); } 
  catch (e) { res.write(`ERROR|${e.message}\n`); return res.end(); }
  
  if (req.method !== 'POST') { res.write(`ERROR|Method not allowed\n`); return res.end(); }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId, files } = body;

    // 1. Session
    let activeSessionId = sessionId || req.cookies?.[COOKIE_NAME] || crypto.randomBytes(16).toString("hex");
    const ip = getIP(req);

    // Set Cookie
    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${activeSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
    }

    // 2. Load User Data
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
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        model: SARVAM_MODEL, 
        messages: messagesPayload, 
        temperature: 0.7,
        max_tokens: MAX_COMPLETION_TOKENS,
        stream: true
      })
    });

    if (!response.ok) throw new Error(`Sarvam API Error ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulatedReply = "";

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
            accumulatedReply += content;
            
            // Handle newlines for streaming protocol
            const parts = content.split('\n');
            for (let i = 0; i < parts.length; i++) {
              let part = parts[i];
              if (i < parts.length - 1) part += "\n";
              if (part) sendEvent(res, "CHUNK", part);
            }
          }
        } catch (e) {}
      }
    }

    // 8. Persona Enforce & Save
    const polishedReply = await enforcePersona(message, accumulatedReply);
    
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
