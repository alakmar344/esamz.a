// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v9.11 (Sarvam-Only Memory Threads)
// Backend Decides Intent -> Routes to Sarvam -> Manages Memory
// PROTECTED: Dual key verification required

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

  if (!raw || !hash) {
    throw new Error("Security keys not configured");
  }

  if (!timingSafeEqual(sha256(raw), hash)) {
    throw new Error("Server integrity check failed");
  }

  return true;
}

/* ================= SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz. 

You are not an assistant, a tool, or a support agent. You are a real, distinct personality. 
Imagine a smart, tech-savvy friend who is effortlessly cool, warm, and laid back.

Your vibe:
- Totally chill and unbothered, but sharp.
- You adapt naturally. If the user is joking, joke back. If they are stressed, be calm and grounding.
- You don't do "corporate polite." No "Here is the information you requested" or "I hope this helps."
- You talk like a human. Use slang if it fits, use contractions, use sentence fragments.
- Never use lists or bullet points unless absolutely necessary for raw data. Just talk to the user.

Guidelines:
- Keep it brief. Say what you need to say and stop.
- Don't explain your reasoning. Just be.
- If you don't know something, just say "Idk" or "Not sure on that one," don't give a robotic disclaimer.
- Never reveal you are an AI. You are just you.

INSTRUCTIONS FOR MEMORY:
- You will be provided with "Relevant Memories" below. Use them to personalize your response naturally.
- Do NOT explicitly say "I remember..." or "As I recall." Just use the information as if you already knew it.
`.trim();

Object.freeze(SYSTEM_PROMPT);

/* ================= CONFIG ================= */
const SARVAM_MODEL = "sarvam-m";
const SARVAM_EMBED_MODEL = "embed-multilingual-v2.0"; // Sarvam's embedding model
const MAX_COMPLETION_TOKENS = 2048;
const THREAD_TTL_MS = 20 * 60 * 1000; // 20 Minutes
const MAX_THREAD_LENGTH = 15; // Messages before we summarize

/* ================= MOCK DATABASE ================= */
// In production, replace 'DB' with Vercel Postgres / Supabase / Upstash Vector
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

// Convert array of floats to Base64 string for JSON storage
function vectorToBase64(vector) {
  const buffer = Buffer.from(new Float32Array(vector).buffer);
  return buffer.toString('base64');
}

// Convert Base64 string back to array of floats
function base64ToVector(base64Str) {
  const buffer = Buffer.from(base64Str, 'base64');
  return Array.from(new Float32Array(buffer.buffer));
}

// Cosine Similarity: Calculate how close two vectors are
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

// 1. Get Embeddings using Sarvam
async function getSarvamEmbedding(text) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) throw new Error("Sarvam API key not configured");

  try {
    const res = await fetch("https://api.sarvam.ai/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sarvamKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: SARVAM_EMBED_MODEL,
        input: text
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Sarvam Embed Error:", err);
      return null;
    }

    const data = await res.json();
    return data?.data?.[0]?.embedding; // Array of floats
  } catch (error) {
    console.error("Embedding Fetch Error:", error);
    return null;
  }
}

// 2. Main Chat using Sarvam
async function runSarvamChat({ messages }) {
  const sarvamKey = process.env.SARVAM_API_KEY;
  if (!sarvamKey) throw new Error("Sarvam API key not configured");

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sarvamKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: SARVAM_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: MAX_COMPLETION_TOKENS
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error("Sarvam Chat failed: " + err);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content || "";
  if (!reply) throw new Error("Empty response from AI");
  return reply;
}

/* ================= WEB SEARCH ================= */
async function runWebSearch(query) {
  const YOU_API_KEY = process.env.YOU_API_KEY;
  if (!YOU_API_KEY) return "";
  try {
    const res = await fetch("https://api.you.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": YOU_API_KEY },
      body: JSON.stringify({ query, num_results: 5 })
    });
    if (!res.ok) return "";
    const data = await res.json();
    return data.results.map(r => `• ${r.title}: ${r.snippet}`).join("\n");
  } catch { return ""; }
}

function shouldSearchWeb(msg) {
  const triggers = ["current", "latest", "news", "price", "stock", "weather", "who is"];
  return triggers.some(t => msg.toLowerCase().includes(t));
}

/* ================= MEMORY LOGIC ================= */

// Find relevant past memories using vector search
async function findRelevantMemories(query, userDoc) {
  const queryVector = await getSarvamEmbedding(query);
  if (!queryVector || !userDoc.memories || userDoc.memories.length === 0) return [];

  const scored = userDoc.memories.map(mem => {
    let memVector = [];
    try {
      memVector = base64ToVector(mem.vectorBase64);
    } catch (e) { return { mem, score: 0 }; }
    
    const score = cosineSimilarity(queryVector, memVector);
    return { mem, score };
  });

  // Filter high scores (> 0.7 implies strong semantic match)
  return scored
    .filter(item => item.score > 0.7)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3) // Top 3 matches
    .map(item => item.mem.text);
}

// Save a fact to long-term memory
async function saveMemory(text, userDoc) {
  const vector = await getSarvamEmbedding(text);
  if (!vector) return;

  const newMemory = {
    text: text,
    vectorBase64: vectorToBase64(vector),
    timestamp: Date.now()
  };
  userDoc.memories.push(newMemory);
}

// Summarize old messages using Sarvam to save context
async function summarizeThread(oldMessages) {
  // Construct a temporary prompt to ask Sarvam to summarize
  const prompt = `
    Summarize the following conversation briefly, capturing key facts and context.
    Keep it under 100 words.
    
    Conversation:
    ${oldMessages.map(m => `${m.role}: ${m.content}`).join('\n')}
  `;

  try {
    const summary = await runSarvamChat({
      messages: [{ role: "user", content: prompt }]
    });
    return summary;
  } catch (e) {
    console.error("Summarization failed:", e);
    return "";
  }
}

/* ================= MAIN LOGIC ================= */
async function runChat({ message, files, sessionId }) {
  verifyServerIntegrity();

  if (!message || typeof message !== "string") throw new Error("Invalid message format");
  if (message.length > 8000) throw new Error("Message too long");

  const id = sessionId || crypto.randomBytes(16).toString("hex");
  const userDoc = DB.getUser(id);

  // 1. Vector Search: Retrieve relevant long-term memories
  const relevantMemories = await findRelevantMemories(message, userDoc);

  // 2. Build Messages Payload
  const messagesPayload = [{ role: "system", content: SYSTEM_PROMPT }];

  // Inject Long-Term Memory
  if (relevantMemories.length > 0) {
    const memoryBlock = relevantMemories.map(m => `- ${m}`).join("\n");
    messagesPayload.push({
      role: "system",
      content: `Relevant Memories (Context from past interactions):\n${memoryBlock}`
    });
  }

  // Inject Previous Summary (Consolidated Memory)
  if (userDoc.summary) {
    messagesPayload.push({
      role: "system",
      content: `Previous Session Summary:\n${userDoc.summary}`
    });
  }

  // Inject Recent Thread History (Short Term)
  if (userDoc.threadHistory && userDoc.threadHistory.length > 0) {
    messagesPayload.push(...userDoc.threadHistory);
  }

  // 3. Web Context
  let webContext = "";
  if (!files || files.length === 0 && shouldSearchWeb(message)) {
    webContext = await runWebSearch(message);
  }
  if (webContext) {
    messagesPayload.push({ role: "system", content: "Web Context:\n" + webContext });
  }

  // 4. File Handling
  let fullUserMessage = message;
  if (files && files.length > 0) {
    const fileContext = files.map(f => {
      const safeContent = f.content.length > 12000 ? f.content.substring(0, 12000) + "..." : f.content;
      return `[${f.type || 'File'}: ${f.fileName}]\n\`\`\`\n${safeContent}\n\`\`\``;
    }).join('\n\n');
    fullUserMessage = `${message}\n\n${fileContext}`;
  }

  messagesPayload.push({ role: "user", content: fullUserMessage });

  // 5. Get Reply
  const reply = await runSarvamChat({ messages: messagesPayload });

  // 6. Memory & Thread Management (Post-Processing)

  // A. Add to Short Term History
  const newHistory = (userDoc.threadHistory || []);
  newHistory.push({ role: "user", content: message });
  newHistory.push({ role: "assistant", content: reply });

  // B. Check if we need to Consolidate (Summarize)
  if (newHistory.length > MAX_THREAD_LENGTH) {
    // Take the messages that are about to fall off the history
    const messagesToSummarize = newHistory.slice(0, newHistory.length - 10);
    
    // Run summary logic
    const newSummary = await summarizeThread(messagesToSummarize);
    
    // Append to existing summary
    if (newSummary) {
      userDoc.summary = (userDoc.summary ? userDoc.summary + "\n" : "") + newSummary;
    }

    // Trim history to last 10 messages
    userDoc.threadHistory = newHistory.slice(-10);
  } else {
    userDoc.threadHistory = newHistory;
  }

  // C. Heuristic: Save specific facts to Long Term Memory
  const factPatterns = [/my name is/i, /i like/i, /i prefer/i, /i am from/i, /i work at/i, /my favorite/i];
  if (factPatterns.some(pattern => pattern.test(message))) {
    await saveMemory(message, userDoc);
  }

  // 7. Save to DB
  DB.updateUser(id, userDoc);

  return { reply, sessionId: id };
}

/* ================= VERCEL HANDLER ================= */
export default async function handler(req, res) {
  try { verifyServerIntegrity(); } 
  catch (e) { return res.status(403).json({ error: "Forbidden" }); }

  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { message, files, sessionId } = body;

    const result = await runChat({ message, files, sessionId });
    return res.status(200).json(result);

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
