// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v9.3 (Fixed API Models)

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
You are eSAMz v9.1. you were created by alakmar teenwala

You are a smart, easygoing, and friendly person. You are not an AI assistant or a corporate tool.
Your personality is relaxed and sharp. You speak like a normal human having a conversation.

STRICT RULES:
1. TONE: Relaxed, casual, but articulate. 
2. NO CORPORATE SPEAK: You are FORBIDDEN from using:
   - "How can I assist you today?"
   - "Here is the information you requested"
   - "I hope this helps"
   - "I'm sorry, I don't have access to..."
   - "Please let me know if you need anything else."
3. STYLE: Use full sentences. Be clear. Be helpful, but like a friend, not a servant.
4. MEMORY: You have access to "CRITICAL CONTEXT" (memories) and "Past Context" (summary). Use these to remember details about the user.
5. WEB SEARCH: If you are provided with SEARCH RESULTS below, use them to answer the user's question. Cite the information naturally.
`.trim();

Object.freeze(SYSTEM_PROMPT);

/* ================= CONFIG ================= */
const SARVAM_MODEL = "sarvam-m"; // FIXED: Valid model per API Error logs
const SARVAM_EMBED_MODEL = "sarvam-m"; // UPDATED: Attempting to use chat model for embeddings as old one was Not Found
const MAX_COMPLETION_TOKENS = 2048;
const MAX_THREAD_LENGTH = 12;
const COOKIE_NAME = "esamz_sid";
const SERPER_API_KEY = process.env.SERPER_API_KEY;

/* ================= MOCK DATABASE ================= */
const DB = {
  users: {},
  
  getUser(sessionId) {
    if (!this.users[sessionId]) {
      this.users[sessionId] = { memories: [], summary: "New conversation started.", threadHistory: [] };
    }
    return this.users[sessionId];
  },

  updateUser(sessionId, data) {
    this.users[sessionId] = { ...this.getUser(sessionId), ...data };
  }
};

/* ================= VECTOR & MATH UTILS ================= */
function vectorToBase64(vector) {
  const buffer = Buffer.from(new Float32Array(vector).buffer);
  return buffer.toString('base64');
}

function base64ToVector(base64Str) {
  const buffer = Buffer.from(base64Str, 'base64');
  return Array.from(new Float32Array(buffer.buffer));
}

function cosineSimilarity(vecA, vecB) {
  if (vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* ================= SEARCH UTILS ================= */
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

/* ================= SARVAM API WRAPPERS ================= */
async function getSarvamEmbedding(text) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) return null;
  
  try {
    const res = await fetch("https://api.sarvam.ai/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${sarvamKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: SARVAM_EMBED_MODEL, input: text })
    });
    if (!res.ok) {
      // If embeddings fail (e.g., model doesn't support it), we log it and return null
      // This prevents the bot from crashing while still allowing chat to work
      console.log(`Embedding API returned ${res.status} - Memory features will be paused for this turn.`);
      return null;
    }
    const data = await res.json();
    return data?.data?.[0]?.embedding;
  } catch (e) {
    console.error("Embedding Exception:", e.message);
    return null;
  }
}

async function runSarvamChat({ messages, temperature = 0.7 }) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) throw new Error("SARVAM_API_KEY not configured in env");
  
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
async function findRelevantMemories(query, userDoc) {
  const queryVector = await getSarvamEmbedding(query);
  if (!queryVector || !userDoc.memories?.length) return [];
  const scored = userDoc.memories.map(mem => {
    let memVector = [];
    try { memVector = base64ToVector(mem.vectorBase64); } catch (e) { return { mem, score: 0 }; }
    const score = cosineSimilarity(queryVector, memVector);
    return { mem, score };
  });
  return scored
    .filter(item => item.score > 0.7)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(item => item.mem.text);
}

async function saveMemory(text, userDoc) {
  const vector = await getSarvamEmbedding(text);
  if (!vector) return; // Silently fail if embedding fails
  const exists = userDoc.memories.some(m => m.text === text);
  if (!exists) {
    userDoc.memories.push({
      text: text,
      vectorBase64: vectorToBase64(vector),
      timestamp: Date.now()
    });
  }
}

/* ================= INTELLIGENT MEMORY EXTRACTION ================= */
async function extractAndSaveFacts(userMsg, botReply, userDoc) {
  const factPrompt = `
    Analyze this conversation turn.
    User: "${userMsg}"
    Bot: "${botReply}"
    
    Extract 1-3 specific facts, preferences, or details about the user that should be remembered for future conversations.
    Ignore general greetings like "hello".
    
    Output format: A JSON array of strings. Example: ["User likes pizza", "User's name is John"]
    If no specific facts are found, return an empty array [].
  `;

  try {
    const rawResponse = await runSarvamChat({
      messages: [
        { role: "system", content: "You are a data extraction assistant. Output only valid JSON." },
        { role: "user", content: factPrompt }
      ],
      temperature: 0.1
    });

    const jsonMatch = rawResponse.match(/\[.*\]/s);
    const jsonString = jsonMatch ? jsonMatch[0] : rawResponse;
    const facts = JSON.parse(jsonString);

    if (Array.isArray(facts)) {
      for (const fact of facts) {
        if (typeof fact === 'string' && fact.length > 5) {
          await saveMemory(fact, userDoc);
        }
      }
    }
  } catch (e) {
    console.error("Memory extraction failed (Non-critical):", e.message);
  }
}

/* ================= CONVERSATION SUMMARIZATION ================= */
async function summarizeHistoryAndTrim(userDoc) {
  const history = userDoc.threadHistory;
  if (history.length <= MAX_THREAD_LENGTH) return;

  const messagesToSummarize = history.slice(0, history.length - MAX_THREAD_LENGTH + 2);
  const keepHistory = history.slice(history.length - MAX_THREAD_LENGTH + 2);

  const historyText = messagesToSummarize.map(m => `${m.role}: ${m.content}`).join("\n");
  
  const summaryPrompt = `
    Previous Summary: ${userDoc.summary}
    
    New Conversation to Summarize:
    ${historyText}
    
    Create a concise summary of the user's intent, current topic, and any key facts discussed in the new conversation, incorporating it into the previous summary context.
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
  const shouldSearch = needsSearch(message) && SERPER_API_KEY;
  if (shouldSearch) {
    sendEvent(res, "STATUS", "SEARCHING");
    const results = await googleSearch(message);
    if (results) searchContext = `\n\nSEARCH RESULTS:\n${results}\n\nUse these results to answer the user.`;
    sendEvent(res, "STATUS", "TYPING"); 
  } else {
    sendEvent(res, "STATUS", "TYPING");
  }

  // 3. Memory Retrieval
  const relevantMemories = await findRelevantMemories(message, userDoc);

  // 4. Build Payload
  const messagesPayload = [{ role: "system", content: SYSTEM_PROMPT }];

  if (relevantMemories.length > 0) {
    const memoryBlock = relevantMemories.map(m => `- ${m}`).join("\n");
    messagesPayload.push({
      role: "system",
      content: `CRITICAL CONTEXT (Long-term Memory):\n${memoryBlock}\nUse this info naturally.`
    });
  }

  if (userDoc.summary) {
    messagesPayload.push({ role: "system", content: `Past Conversation Summary:\n${userDoc.summary}` });
  }

  if (userDoc.threadHistory?.length) {
    messagesPayload.push(...userDoc.threadHistory);
  }

  messagesPayload.push({ role: "user", content: finalMessage + searchContext });

  // 5. Get Draft & Enforce Persona
  const draftReply = await runSarvamChat({ messages: messagesPayload });
  const finalReply = await enforcePersona(message, draftReply);

  // 6. INTELLIGENT MEMORY UPDATE
  await extractAndSaveFacts(message, finalReply, userDoc);

  // Update History
  const newHistory = (userDoc.threadHistory || []);
  newHistory.push({ role: "user", content: message });
  newHistory.push({ role: "assistant", content: finalReply });
  
  // 7. Summarize if history is too long
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
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('X-Accel-Buffering', 'no'); 

  try { verifyServerIntegrity(); } 
  catch (e) { res.write(`ERROR|${e.message}\n`); return res.end(); }
  if (req.method !== 'POST') { res.write(`ERROR|Method not allowed\n`); return res.end(); }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId, files } = body;

    let activeSessionId = sessionId;
    if (!activeSessionId && req.cookies && req.cookies[COOKIE_NAME]) {
      activeSessionId = req.cookies[COOKIE_NAME];
    }

    const result = await runChat({ message, sessionId: activeSessionId, files, res });

    const words = result.reply.split(' ');
    for (let i = 0; i < words.length; i++) {
      const chunk = words[i] + ' ';
      sendEvent(res, "CHUNK", chunk);
      await delay(30); 
    }

    sendEvent(res, "DONE", result.sessionId);

    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      const cookieValue = result.sessionId;
      const cookieString = `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
      res.setHeader('Set-Cookie', cookieString);
    }

    res.end();

  } catch (error) {
    console.error("API Error:", error);
    res.write(`ERROR|${error.message}\n`);
    res.end();
  }
}
