// api/chat.js
// Vercel Serverless Function (ES Module)
// eSAMz v9.8 (Fixed Input Length Error)
// Backend Decides Intent -> Routes to Sarvam
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
You are eSAMz v9.1. 

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
`.trim();

Object.freeze(SYSTEM_PROMPT);

/* ================= CONFIG ================= */
const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 2048;
// Set strict limit to stay under 7168 tokens (System prompt + Message + File)
const SAFE_TOKEN_LIMIT = 4000; 

/* ================= WEB SEARCH (YOU.COM) ================= */
async function runWebSearch(query) {
  const YOU_API_KEY = process.env.YOU_API_KEY;
  if (!YOU_API_KEY) return "";

  const res = await fetch("https://api.you.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": YOU_API_KEY
    },
    body: JSON.stringify({
      query,
      num_results: 5
    })
  });

  if (!res.ok) return "";

  const data = await res.json();
  if (!Array.isArray(data?.results)) return "";

  return data.results
    .map(r => `• ${r.title}: ${r.snippet}`)
    .join("\n");
}

/* ================= SEARCH INTENT DETECTION ================= */
function shouldSearchWeb(message) {
  const q = message.toLowerCase();

  const triggers = [
    "current",
    "currently",
    "latest",
    "today",
    "now",
    "recent",
    "news",
    "update",
    "who is",
    "who are",
    "president",
    "prime minister",
    "ceo",
    "price",
    "stock",
    "election",
    "released",
    "launch"
  ];

  return triggers.some(t => q.includes(t));
}

/* ================= SARVAM CHAT ================= */
async function runSarvam({ messages }) {
  const sarvamKey = process.env.SARVAM_API_KEY;

  if (!sarvamKey) {
    throw new Error("Sarvam API key not configured");
  }

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sarvamKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: SARVAM_MODEL,
      messages,
      temperature: 0.7, // Increased to allow for more human-like variability
      max_tokens: MAX_COMPLETION_TOKENS
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error("Sarvam Chat failed: " + err);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content || "";

  if (!reply) {
    throw new Error("Empty response from AI");
  }

  return reply;
}

/* ================= MAIN LOGIC ================= */
async function runChat({ message, files }) {
  verifyServerIntegrity();

  if (!message || typeof message !== "string") {
    throw new Error("Invalid message format");
  }

  if (message.length > 8000) {
    throw new Error("Message too long");
  }

  // 1. Build Messages
  const messages = [
    { role: "system", content: SYSTEM_PROMPT }
  ];

  // 2. Handle Web Context (Only for general chat, no file attachments)
  let webContext = "";
  if (!files || files.length === 0) {
      if (shouldSearchWeb(message)) {
        try {
          webContext = await runWebSearch(message);
        } catch {
          webContext = "";
        }
      }
  }

  if (webContext) {
    messages.push({
      role: "system",
      content:
        "Recent web sourced context for factual grounding only:\n\n" +
        webContext
    });
  }

  // 3. Handle File Context
  let fullUserMessage = message;
  if (files && files.length > 0) {
    const fileContext = files.map(f => {
      // FIX: Truncate file content to prevent Sarvam 400 Error
      // Assuming 1 token ≈ 4 chars. Limit to ~12,000 chars to stay safe.
      const safeContent = f.content.length > 12000 
        ? f.content.substring(0, 12000) + "... [Content Truncated]" 
        : f.content;

      const typeLabel = f.type === 'image' ? '[Image Content]' : `[${f.type || 'File'}: ${f.fileName}]`;
      return `${typeLabel}\n\`\`\`\n${safeContent}\n\`\`\``;
    }).join('\n\n');

    fullUserMessage = `${message}\n\n${fileContext}`;
  }

  messages.push({ role: "user", content: fullUserMessage });

  // 4. Route to Sarvam (Only provider)
  return runSarvam({ messages });
}

/* ================= VERCEL HANDLER ================= */
export default async function handler(req, res) {
  // 1. Security Check
  try {
    verifyServerIntegrity();
  } catch (securityError) {
    console.error("Security Error:", securityError);
    return res.status(403).json({ error: "Direct access forbidden" });
  }

  // 2. Method Check
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    // 3. Parse Body Helper
    let body;
    
    if (typeof req.body === 'object' && req.body !== null) {
        body = req.body;
    } else if (typeof req.body === 'string') {
        try {
            body = JSON.parse(req.body);
        } catch (e) {
            return res.status(400).json({ error: "Invalid JSON body" });
        }
    } else {
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks).toString();
        try {
            body = JSON.parse(buffer);
        } catch (e) {
            return res.status(400).json({ error: "Invalid JSON stream" });
        }
    }

    const { message, files } = body;

    // 4. Process Logic
    const reply = await runChat({ message, files });

    // 5. Send Response
    return res.status(200).json({ reply });

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ 
      error: "Internal Server Error", 
      details: error.message 
    });
  }
}
