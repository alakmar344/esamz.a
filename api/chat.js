// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v9.2 (Web Search & Streaming Integration)

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
4. MEMORY: If context says "My name is X", USE it naturally. "Hey X" or "Right X".
5. WEB SEARCH: If you are provided with SEARCH RESULTS below, use them to answer the user's question. Cite the information naturally.
`.trim();

Object.freeze(SYSTEM_PROMPT);

/* ================= CONFIG ================= */
const SARVAM_MODEL = "sarvam-m";
const SARVAM_EMBED_MODEL = "embed-multilingual-v2.0";
const MAX_COMPLETION_TOKENS = 2048;
const MAX_THREAD_LENGTH = 15;
const COOKIE_NAME = "esamz_sid";
const SERPER_API_KEY = process.env.SERPER_API_KEY; // Required for Web Search

/* ================= MOCK DATABASE ================= */
const DB = {
  users: {},
  
  getUser(sessionId) {
    if (!this.users[sessionId]) {
      this.users[sessionId] = { memories: [], summary: "", threadHistory: [] };
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
  const triggers = [
    "who is", "what is", "latest", "news", "weather", "price", "search for", 
    "current", "happening", "define", "meaning of", "capital of", "president of"
  ];
  return triggers.some(t => lower.includes(t));
}

async function googleSearch(query) {
  if (!SERPER_API_KEY) return null;
  
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query, num: 5 }) // Top 5 results
    });

    if (!response.ok) return null;
    const data = await response.json();
    
    // Format results for the AI
    const snippets = (data.answerBox?.snippet || "") + "\n" + 
      (data.organic?.map((r, i) => `${i+1}. ${r.title} - ${r.snippet}`).join("\n") || "");
      
    return snippets;
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
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.embedding;
  } catch { return null; }
}

async function runSarvamChat({ messages, temperature = 0.7 }) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) throw new Error("Sarvam API key not configured");

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${sarvamKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: SARVAM_MODEL,
      messages,
      temperature,
      max_tokens: MAX_COMPLETION_TOKENS
    })
  });

  if (!res.ok) throw new Error("Sarvam Chat failed");
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

/* ================= PERSONA ENFORCER ================= */
async function enforcePersona(userMsg, draftReply) {
  const forbidden = [
    "how can i assist", "how may i assist", "here is the information", 
    "i hope this helps", "i do not have access", "i'm sorry, i don't", "please let me know",
    "is there anything else" 
  ];
  
  const isCorporate = forbidden.some(phrase => draftReply.toLowerCase().includes(phrase));

  if (!isCorporate) return draftReply; 

  const correctionPrompt = `
    User said: "${userMsg}"
    AI Draft: "${draftReply}"
    
    The AI Draft is too formal/robotic. Rewrite it as eSAMz.
    Rules: 
    - Speak like a normal, relaxed human.
    - No "How can I assist".
    - Be direct and clear.
  `;

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
    .slice(0, 3)
    .map(item => item.mem.text);
}

async function saveMemory(text, userDoc) {
  const vector = await getSarvamEmbedding(text);
  if (!vector) return;
  userDoc.memories.push({
    text: text,
    vectorBase64: vectorToBase64(vector),
    timestamp: Date.now()
  });
}

/* ================= STREAMING UTILS ================= */
// Helper to send data in a format the frontend understands
function sendEvent(res, type, data) {
  // We use a custom simple protocol: TYPE|DATA
  // e.g. STATUS|SEARCHING
  //      CHUNK|Hello there
  res.write(`${type}|${data}\n`);
}

// Artificial delay helper to simulate typing
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
    const fileContext = files.map(f => {
      return `\n--- [FILE: ${f.fileName} (${f.type})] ---\n${f.content}\n--- END FILE ---`;
    }).join('\n');
    
    finalMessage = `${message}\n\n${fileContext}`;
  }

  // 2. Web Search Logic
  let searchContext = "";
  const shouldSearch = needsSearch(message) && SERPER_API_KEY;
  
  if (shouldSearch) {
    sendEvent(res, "STATUS", "SEARCHING"); // Tell Frontend to show loader
    const results = await googleSearch(message);
    if (results) {
      searchContext = `\n\nSEARCH RESULTS:\n${results}\n\nUse these results to answer the user.`;
    }
    // Send DONE searching status
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
      content: `CRITICAL CONTEXT:\nUser said this before: "${memoryBlock}".\nUse this info naturally.`
    });
  }

  if (userDoc.summary) {
    messagesPayload.push({ role: "system", content: `Past Context: ${userDoc.summary}` });
  }

  if (userDoc.threadHistory?.length) {
    messagesPayload.push(...userDoc.threadHistory);
  }

  // Add message + search context + file context
  messagesPayload.push({ role: "user", content: finalMessage + searchContext });

  // 5. Get Draft & Enforce Persona
  const draftReply = await runSarvamChat({ messages: messagesPayload });
  const finalReply = await enforcePersona(message, draftReply);

  // 6. Update Memory
  const namePattern = /(?:my name is|i am|i'm)\s+([a-zA-Z]+)/i;
  const nameMatch = message.match(namePattern);
  
  if (nameMatch) {
    const name = nameMatch[1];
    await saveMemory(`User's name is ${name}`, userDoc);
  } else {
    const factPatterns = [/i like/i, /i prefer/i, /i work at/i, /i live in/i];
    if (factPatterns.some(p => p.test(message))) await saveMemory(message, userDoc);
  }

  // Update History
  const newHistory = (userDoc.threadHistory || []);
  newHistory.push({ role: "user", content: message });
  newHistory.push({ role: "assistant", content: finalReply });
  
  if (newHistory.length > MAX_THREAD_LENGTH) {
    userDoc.threadHistory = newHistory.slice(-MAX_THREAD_LENGTH);
  } else {
    userDoc.threadHistory = newHistory;
  }

  DB.updateUser(id, userDoc);

  return { reply: finalReply, sessionId: id };
}

/* ================= VERCEL HANDLER ================= */
export default async function handler(req, res) {
  // Enable streaming headers
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  // Disable buffering to ensure immediate sending
  res.setHeader('X-Accel-Buffering', 'no'); 

  try { 
    verifyServerIntegrity(); 
  } 
  catch (e) { 
    res.write(`ERROR|${e.message}`);
    return res.end(); 
  }

  if (req.method !== 'POST') {
    res.write(`ERROR|Method not allowed`);
    return res.end();
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId, files } = body;

    // 1. PRIORITY: Check Cookie for Session ID
    let activeSessionId = sessionId;
    if (!activeSessionId && req.cookies && req.cookies[COOKIE_NAME]) {
      activeSessionId = req.cookies[COOKIE_NAME];
    }

    // 2. Run Logic & Stream Response
    const result = await runChat({ 
      message, 
      sessionId: activeSessionId, 
      files, 
      res 
    });

    // 3. Artificial Streaming (Word by Word Effect)
    // Since we already fetched the full text, we chunk it and send it with delays
    const words = result.reply.split(' ');
    
    for (let i = 0; i < words.length; i++) {
      const chunk = words[i] + ' ';
      res.write(`CHUNK|${chunk}`);
      // Small delay to simulate typing (30ms per word approx)
      await delay(30); 
    }

    // Send Final End Signal
    res.write(`DONE|${result.sessionId}`);

    // 4. Set Cookie if new
    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      const cookieValue = result.sessionId;
      const cookieString = `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
      res.setHeader('Set-Cookie', cookieString);
    }

    res.end();

  } catch (error) {
    console.error("API Error:", error);
    res.write(`ERROR|${error.message}`);
    res.end();
  }
}
