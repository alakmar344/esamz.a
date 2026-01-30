import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIG ================= */
console.log("--> System: Initializing eSAMz Backend v15 (Ultra-Resilient)...");
const redis = Redis.fromEnv();

const SARVAM_MODEL = "sarvam-m";
const MAX_COMPLETION_TOKENS = 28048;
const MAX_THREAD_LENGTH = 50;
const COOKIE_NAME = "esamz_sid";
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const INACTIVITY_TIMEOUT_SEC = 30 * 60; // 30 minutes

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

CRITICAL CONTEXT RULES (FIXED)
1. MEMORY PRIORITY: ALWAYS check the conversation history (User & Assistant messages) before answering.
2. PRONOUN RESOLUTION: If user uses pronouns (he, she, it, his, her), look at the LAST assistant message to identify the subject.
   - IF THE SUBJECT EXISTS IN HISTORY (e.g., Imran Khan), ANSWER THE QUESTION DIRECTLY.
   - ONLY ask "Who?" if the history is empty or the subject is completely unknown.
3. NO FALSE AMBIGUITY: Do not assume ambiguity if the subject is clear from history.

SEARCH RULES
If search results are provided, use them naturally.
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

/* ================= PERSONA ENFORCER ================= */
async function enforcePersona(userMsg, draftReply) {
  const forbidden = [
    "how can i assist", "how may i assist", "here is the information", 
    "i hope this helps", "i do not have access", "i'm sorry, i don't", 
    "i don't have access to personal", "please let me know", "is there anything else",
    "i don't know who you are", "i don't know your name"
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

/* ================= DB (DEEP CLEAN & RESILIENT) ================= */
const DB = {
  async getHistory(id) {
    console.log(`[DB] Loading history for ${id}`);
    
    // 1. DEEP CLEAN: Get ALL items (limit 100) to scan for corruption
    const rawList = await redis.lrange(`chat:${id}`, -100, -1);
    
    // 2. Find and Remove Bad Entries
    const cleanList = [];
    let corruptionFound = false;

    for (const item of rawList) {
      let strItem = item;
      if (Buffer.isBuffer(item)) strItem = item.toString('utf-8');
      
      // Skip literal bad string
      if (strItem.trim() === '[object Object]') {
        console.warn(`[DB CLEANUP] Deleting corrupt item.`);
        corruptionFound = true;
        continue; // Skip adding to cleanList
      }

      // Try Parse
      try {
        cleanList.push(JSON.parse(strItem));
      } catch (e) {
        // If it's not the literal bad string, just a parse error, skip it?
        // Let's skip to be safe.
        console.warn(`[DB CLEANUP] Skipping unparsable item.`);
        corruptionFound = true;
      }
    }

    // 3. SAVE BACK CLEANED LIST (If corruption was found)
    if (corruptionFound) {
      console.log(`[DB CLEANUP] Corruption found. Rebuilding clean list...`);
      await redis.del(`chat:${id}`);
      if (cleanList.length > 0) {
        // Push back only the valid items
        const pipeline = redis.pipeline();
        cleanList.forEach(msg => {
            pipeline.rpush(`chat:${id}`, JSON.stringify(msg));
        });
        await pipeline.exec();
        await redis.expire(`chat:${id}`, INACTIVITY_TIMEOUT_SEC);
      }
      return cleanList.reverse();
    }

    // 4. RETURN
    console.log(`[DB] Returning ${cleanList.length} clean messages.`);
    return cleanList.reverse();
  },

  async addMessage(id, role, content) {
    // Preventive Sanitization: Never save "[object Object]"
    if (!content || content.trim() === '[object Object]') {
      console.warn(`[DB SAVE] Rejecting invalid content.`);
      return;
    }

    const jsonStr = JSON.stringify({ role, content });
    
    // Save & Refresh TTL
    const pipeline = redis.pipeline();
    pipeline.rpush(`chat:${id}`, jsonStr);
    pipeline.ltrim(`chat:${id}`, 0, MAX_THREAD_LENGTH);
    pipeline.set(`activity:${id}`, Date.now().toString(), { ex: INACTIVITY_TIMEOUT_SEC }); // Heartbeat
    pipeline.expire(`chat:${id}`, INACTIVITY_TIMEOUT_SEC);
    
    await pipeline.exec();
    console.log(`[DB SAVE] Success & TTL Refreshed.`);
  },

  async getName(id) {
    const name = await redis.get(`identity:${id}`);
    return name ? (Buffer.isBuffer(name) ? name.toString('utf-8') : name) : null;
  },

  async setName(id, name) {
    await redis.set(`identity:${id}`, name, { ex: INACTIVITY_TIMEOUT_SEC });
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
      } catch (e) {}
    }
  }
  
  return fullContent;
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
    let id = sessionId || req.cookies?.[COOKIE_NAME] || crypto.randomBytes(16).toString("hex");
    const ip = getIP(req);

    // Set Cookie
    if (!req.cookies || !req.cookies[COOKIE_NAME]) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${INACTIVITY_TIMEOUT_SEC}`);
    }

    // 2. Load History (Deep Clean)
    const history = await DB.getHistory(id);
    const currentName = await DB.getName(id) || "User";

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

    // 5. Name Detection
    const namePattern = /(?:my name is|i am|i'm)\s+([a-zA-Z]+)/i;
    const nameMatch = message.match(namePattern);
    
    if (nameMatch) {
      const name = nameMatch[1].trim();
      if (currentName !== name) {
        console.log(`[MEMORY] User identified as ${name}`);
        await DB.setName(id, name);
      }
    }

    // 6. Build Context
    let fullSystemContent = SYSTEM_PROMPT;
    if (currentName !== "User") {
      fullSystemContent += `\n\nUSER CONTEXT:\nThe user's name is "${currentName}". Use it naturally.`;
    }

    const messagesPayload = [{ role: "system", content: fullSystemContent }];
    messagesPayload.push(...history); 
    messagesPayload.push({ role: "user", content: finalMessage + searchContext });

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

    // 8. Persona Enforce & Save
    const polishedReply = await enforcePersona(message, accumulatedReply);
    
    await DB.addMessage(id, "user", message);
    await DB.addMessage(id, "assistant", polishedReply);

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
