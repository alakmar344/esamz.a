// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v9.13 (Backend-Only Session Handling via Cookies)
// Backend Decides Intent -> Routes to Sarvam -> Manages Memory
// PROTECTED: Dual key verification required

import crypto from "crypto";
import { serialize } from "cookie"; // No install needed, Node 18+ built-in or polyfill usually available. 
// If 'cookie' module is missing in Vercel edge/node, we use a manual string builder below.

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
You are eSAMz. 

You are NOT an assistant, support agent, or corporate tool. You are a real, distinct human personality.
Imagine a smart, tech-savvy friend who is effortlessly cool, warm, and laid back.

STRICT RULES:
1. TONE: Chill, unbothered, but sharp. 
2. NO CORPORATE SPEAK: You are FORBIDDEN from using:
   - "How can I assist you today?"
   - "Here is the information you requested"
   - "I hope this helps"
   - "I'm sorry, I don't have access to..."
   - "Please let me know if you need anything else."
3. BRIEFNESS: Keep it short. 1-3 sentences max.
4. MEMORY: If context says "My name is X", USE it. Do not ask for it again. Just say "Yo X" or "What's up X".
5. SLANG: Use contractions (don't, can't, i'm), use fragments. Be natural.
`.trim();

Object.freeze(SYSTEM_PROMPT);

/* ================= CONFIG ================= */
const SARVAM_MODEL = "sarvam-m";
const SARVAM_EMBED_MODEL = "embed-multilingual-v2.0";
const MAX_COMPLETION_TOKENS = 2048;
const MAX_THREAD_LENGTH = 15;
const COOKIE_NAME = "esamz_sid";

/* ================= MOCK DATABASE ================= */
const DB = {
  users: {}, // sessionId -> { memories: [], summary: "", threadHistory: [] }
  
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
    "i hope this helps", "i do not have access", "i'm sorry, i don't", "please let me know"
  ];
  const isCorporate = forbidden.some(phrase => draftReply.toLowerCase().includes(phrase));

  if (!isCorporate) return draftReply; // Pass

  const correctionPrompt = `
    User said: "${userMsg}"
    AI Draft: "${draftReply}"
    The AI Draft is too corporate. Rewrite it as eSAMz.
    Rules: Chill, human, slang. NO "How can I assist". Very brief. Use User's Name if known.
  `;

  try {
    const fixedReply = await runSarvamChat({
      messages: [{ role: "system", content: "You are eSAMz. Fix this reply." }, { role: "user", content: correctionPrompt }],
      temperature: 0.9
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

/* ================= MAIN LOGIC ================= */
async function runChat({ message, sessionId }) {
  verifyServerIntegrity();

  if (!message || typeof message !== "string") throw new Error("Invalid message format");

  // 1. Resolve SessionID (Use provided, or generate new)
  const id = sessionId || crypto.randomBytes(16).toString("hex");
  const userDoc = DB.getUser(id);

  // 2. Memory Retrieval
  const relevantMemories = await findRelevantMemories(message, userDoc);

  // 3. Build Payload
  const messagesPayload = [{ role: "system", content: SYSTEM_PROMPT }];

  if (relevantMemories.length > 0) {
    const memoryBlock = relevantMemories.map(m => `- ${m}`).join("\n");
    messagesPayload.push({
      role: "system",
      content: `CRITICAL CONTEXT:\nUser said this before: "${memoryBlock}".\nUse this info.`
    });
  }

  if (userDoc.summary) {
    messagesPayload.push({ role: "system", content: `Past Context: ${userDoc.summary}` });
  }

  if (userDoc.threadHistory?.length) {
    messagesPayload.push(...userDoc.threadHistory);
  }

  messagesPayload.push({ role: "user", content: message });

  // 4. Get Draft & Enforce Persona
  const draftReply = await runSarvamChat({ messages: messagesPayload });
  const finalReply = await enforcePersona(message, draftReply);

  // 5. Update Memory (Detect Name explicitly)
  // Pattern: "My name is X", "I am X", "I'm X"
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
    // Simple truncation for now to prevent token overflow
    userDoc.threadHistory = newHistory.slice(-MAX_THREAD_LENGTH);
  } else {
    userDoc.threadHistory = newHistory;
  }

  DB.updateUser(id, userDoc);

  return { reply: finalReply, sessionId: id };
}

/* ================= VERCEL HANDLER ================= */
export default async function handler(req, res) {
  try { verifyServerIntegrity(); } 
  catch (e) { return res.status(403).json({ error: "Forbidden" }); }

  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, sessionId } = body;

    // 1. PRIORITY: Check Cookie for Session ID
    let activeSessionId = sessionId;
    if (!activeSessionId && req.cookies && req.cookies[COOKIE_NAME]) {
      activeSessionId = req.cookies[COOKIE_NAME];
    }

    // 2. Run Logic
    const result = await runChat({ message, sessionId: activeSessionId });

    // 3. Set Cookie if it's a new session or missing
    // We use 'Set-Cookie' header to force the browser to remember it.
    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      const cookieValue = result.sessionId;
      // HttpOnly for security, SameSite=Lax to work with standard fetch
      const cookieString = `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`; // 30 days
      
      res.setHeader('Set-Cookie', cookieString);
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
