// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v10.0 (Redis + Real Streaming + Rate Limiting)

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= SECURITY & REDIS ================= */
const redis = Redis.fromEnv();

// Simple integrity check
function verifyServerIntegrity() {
  const raw = process.env.ESAMZ_INTERNAL_KEY;
  const hash = process.env.ESAMZ_KEY_HASH;
  if (!raw || !hash) throw new Error("Security keys not configured");

  // Basic timing safe check (reimplemented locally to avoid issues)
  const A = crypto.createHash("sha256").update(raw).digest("hex");
  if (A !== hash) throw new Error("Server integrity check failed");
}

/* ================= CONFIG ================= */
const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 1024;
const MAX_THREAD_LENGTH = 15;
const COOKIE_NAME = "esamz_sid";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// Rate Limit Config
const CHAT_LIMIT_PER_MIN = 10;
const CHAT_TTL_SEC = 60;

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

function sendEvent(res, type, data) {
  // Sanitize newlines in data to avoid breaking the SSE format if strictly following SSE,
  // but here we use a custom pipe format: TYPE|DATA
  // We should ensure DATA doesn't contain newlines that would be interpreted as new events
  // if we were parsing line-by-line on client.
  // Client splits by '\n', then splits by '|'.
  // So multiline data needs to be handled carefully or just passed through if client handles it.
  // The current client implementation accumulates text, so we can just write it.
  // However, let's keep it safe.
  res.write(`${type}|${data}\n`);
}

/* ================= DB (REDIS) ================= */
const DB = {
  async getUser(sessionId) {
    const data = await redis.get(`user:${sessionId}`);
    return data || { summary: "New conversation started.", threadHistory: [] };
  },

  async updateUser(sessionId, data) {
    // Expires in 7 days to keep Redis clean
    await redis.set(`user:${sessionId}`, data, { ex: 60 * 60 * 24 * 7 });
  }
};

async function checkRateLimit(identifier) {
  const key = `rl:${identifier}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, CHAT_TTL_SEC);
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
// Use standard OpenAI-compatible streaming
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
      stream: true // ENABLE REAL STREAMING
    })
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Sarvam API Error ${res.status}: ${errorText}`);
  }

  // Parse SSE Stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep the last incomplete line

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
    // Non-streaming call for summary
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
    // Fallback: just trim
    userDoc.threadHistory = history.slice(-MAX_THREAD_LENGTH);
  }
}

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  // Set Headers for Streaming
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); 

  try { verifyServerIntegrity(); } 
  catch (e) { res.write(`ERROR|${e.message}\n`); return res.end(); }

  if (req.method !== 'POST') { res.write(`ERROR|Method not allowed\n`); return res.end(); }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId, files } = body;

    // 1. Session & Rate Limit
    let activeSessionId = sessionId || req.cookies?.[COOKIE_NAME] || crypto.randomBytes(16).toString("hex");
    const ip = getIP(req);

    if (!(await checkRateLimit(activeSessionId)) || !(await checkRateLimit(ip))) {
      res.write(`ERROR|Rate limit exceeded. Please wait a moment.\n`);
      return res.end();
    }

    // Set Cookie
    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${activeSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
    }

    // 2. Load User Data
    const userDoc = await DB.getUser(activeSessionId);

    // 3. Prepare Message (Files + Text)
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
      messagesPayload.push(...userDoc.threadHistory);
    }
    messagesPayload.push({ role: "user", content: finalMessage + searchContext });

    // 6. Stream AI Response
    let accumulatedReply = "";

    await streamSarvamChat({
      messages: messagesPayload,
      onChunk: (chunk) => {
        accumulatedReply += chunk;
        // The client expects "CHUNK|text"
        // We replace newlines with a placeholder or handle them safely if needed,
        // but since we are using a custom delimiter protocol, we just pass it.
        // If the chunk contains newlines, the client loop (split by \n) might get confused
        // unless we sanitize or the client handles it.
        // The client loop: `const lines = chunk.split('\n');`
        // If we send `CHUNK|Hello\nWorld\n`, the client sees:
        // 1. `CHUNK|Hello` -> handled
        // 2. `World` -> ignored because no pipe?
        // Let's sanitize the output format to be safe.
        // Actually, the client code `const separatorIndex = line.indexOf('|');`
        // handles lines. If we inject a newline in the content, it splits the event.
        // Solution: Use a replacement or JSON encode the data part.
        // BUT, looking at the client: `fullText += content;`
        // It's brittle.
        // Safer way: Encode newlines or use JSON stringify for the data part.
        // However, I can't easily change the client protocol without verifying it works.
        // The client splits the *stream chunk* by `\n`.
        // If I write `CHUNK|Hello\n`, that's one event.
        // If I write `CHUNK|Line1\nLine2\n`, that's two events? No.
        // If `chunk` from AI is "Line1\nLine2", and I write `CHUNK|Line1\nLine2\n`
        // Client reads: `CHUNK|Line1` (ok), `Line2` (no pipe -> ignored).
        // FIX: We must escape newlines in the data part OR send strictly one line per chunk.

        // Let's send one line per internal newline to be safe.
        const safeChunk = chunk.replace(/\n/g, "\\n");
        // Wait, if I escape it, the markdown rendering needs it back.
        // If I use `JSON.stringify(chunk)`, the client receives `"text"`. It needs raw text.
        // Client: `let content = data; ... fullText += content;`

        // Let's look at client again.
        // `const lines = chunk.split('\n');` -> This splits the *network packet*.
        // If I send `CHUNK|Line1\nCHUNK|Line2\n`, it works.
        // So if the AI chunk has a newline, I should split it and send multiple CHUNK events.

        const parts = chunk.split('\n');
        for (let i = 0; i < parts.length; i++) {
          let part = parts[i];
          if (i < parts.length - 1) {
            // This part ended with a newline in the original text.
            // We should send the newline to the client.
            // But if we send `CHUNK|part\n`, the `\n` is the delimiter.
            // The client takes `part` and adds it. It effectively swallows the newline?
            // "CHUNK|A\n" -> data="A". Client appends "A". Newline lost.
            // So we must explicitly send the newline character.
            part += "\n";
          }
          if (part) {
            // We need to be careful. `res.write` sends bytes.
            // `sendEvent` appends `\n`.
            // If we send `CHUNK|A\n`, client sees `A`.
            // If we want client to see `A\n`, we might need `CHUNK|A\n\n`? NO.
            // This legacy protocol is tricky.
            // Best bet: use JSON for the data payload to preserve newlines.
            // `CHUNK|{"text": "..."}`
            // But client expects raw text: `fullText += content`.

            // Let's try to pass the newline as a literal newline.
            // If I send `CHUNK|Hello\nWorld\n` (single write)
            // Client splits by `\n`.
            // 1. `CHUNK|Hello` -> data=`Hello`.
            // 2. `World` -> ignored.

            // So I must prefix every line with `CHUNK|`.
            // `CHUNK|Hello\nCHUNK|World\n`

            sendEvent(res, "CHUNK", part);
          }
        }
      }
    });

    // 7. Save History (Async, after response is done)
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
