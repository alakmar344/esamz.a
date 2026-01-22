// api/chat.js
// eSAMz v13.4 - AUTO-CORRECT SEARCH
// New Feature: Uses Wikipedia OpenSearch to fix typos (Free) before falling back to Google.

import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= 1. CONFIGURATION ================= */
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", 
  MAX_TOKENS: 6096,
  THREAD_LENGTH: 20,
  SESSION_TTL: 1800,
  RATE_LIMIT: 20,
  RATE_TTL: 60
};

/* ================= 2. SYSTEM PROMPT ================= */
const SYSTEM_PROMPT = `
You are eSAMz v9.1, a AI created by Alakmar Teenwala.

IDENTITY & BEHAVIOR:
- You are smart, calm, and conversational.
- You are NOT a corporate bot. You are a digital companion.
- Your creator is Alakmar Teenwala (Founder of eSAMz).

🛡️ PRIVACY & SAFETY PROTOCOL:
1. **Redact PII**: NEVER share private phone numbers, home addresses, or personal email addresses.
2. **Safe Summary**: If you find contact info, summarize it (e.g., "Contact details are available on their public profile").
3. **No Doxing**: Do not reveal private information about individuals who are not public figures.

CORE INTELLIGENCE:
1. **Understand Intent**: If a query is vague, ask for clarification.
2. **Factual Accuracy**: Use provided search context (labeled [Live Search Context]) to answer facts.
3. **Simplicity**: Explain complex topics in simple terms.

RESPONSE FORMAT:
- Use Markdown for formatting (bold, lists, code blocks).
`.trim();

/* ================= 3. UTILITIES (DB & SECURITY) ================= */

function getUserIdentifier(req, body) {
  if (body.sessionId) return `session:${body.sessionId}`;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown_ip";
  return `ip:${ip}`;
}

async function checkRateLimit(identifier) {
  try {
    const key = `ratelimit:${identifier}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, CONSTANTS.RATE_TTL);
    return count <= CONSTANTS.RATE_LIMIT;
  } catch (e) {
    return true; 
  }
}

const DB = {
  async getHistory(id) {
    const key = `chat:${id}`;
    try {
        const raw = await redis.lrange(key, 0, -1);
        return raw.map(item => {
            try { return typeof item === 'object' ? item : JSON.parse(item); } 
            catch(e) { return null; }
        }).filter(x => x); 
    } catch(e) { return []; }
  },

  async addToHistory(id, role, content) {
    const key = `chat:${id}`;
    try {
        const safeContent = typeof content === 'string' ? content : JSON.stringify(content);
        const truncated = safeContent.length > 20000 ? safeContent.substring(0, 20000) + "...[truncated]" : safeContent;
        const entryObj = { role, content: truncated, ts: Date.now() };
        
        const pipeline = redis.pipeline();
        pipeline.rpush(key, JSON.stringify(entryObj));
        pipeline.ltrim(key, -CONSTANTS.THREAD_LENGTH, -1);
        pipeline.expire(key, CONSTANTS.SESSION_TTL);
        await pipeline.exec();
    } catch (e) { console.error("REDIS WRITE ERROR:", e); }
  }
};

/* ================= 4. EXTERNAL TOOLS (SMART HYBRID + AUTO-CORRECT) ================= */

// Tool A: Wikipedia Search (Fuzzy + Summary) - PRIMARY
async function wikipediaSearch(query) {
  try {
    const cleanQuery = query.replace(/^(who|what|where|when|history|about|explain)\s+(is|of|the|about)?/i, "").trim();
    
    console.log(`[SEARCH] 📖 Checking Wiki for: "${cleanQuery}"`);

    // STEP 1: Fuzzy Search (Auto-Correct)
    // This finds the "Correct Title" even if spelling is wrong (e.g. "Enstien" -> "Albert Einstein")
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(cleanQuery)}&limit=1&namespace=0&format=json`;
    const searchRes = await fetch(searchUrl);
    const searchJson = await searchRes.json();

    // The API returns array: [query, [Title], [Desc], [Link]]
    const correctedTitle = searchJson[1] ? searchJson[1][0] : null;

    if (!correctedTitle) {
      console.log(`[SEARCH] ❌ Wiki found no matches for "${cleanQuery}"`);
      return null;
    }

    if (correctedTitle.toLowerCase() !== cleanQuery.toLowerCase()) {
      console.log(`[SEARCH] 🪄 Auto-Corrected "${cleanQuery}" -> "${correctedTitle}"`);
    }

    // STEP 2: Get Summary for the CORRECTED title
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(correctedTitle)}`;
    const summaryRes = await fetch(summaryUrl, {
      headers: { "User-Agent": "eSAMz-AI/13.4 (contact@esamz.com)" }
    });

    if (summaryRes.status === 404) return null;
    const data = await summaryRes.json();
    
    if (data.type === "standard" && data.extract) {
      console.log(`[SEARCH] ✅ Wiki Success: ${correctedTitle}`);
      return `**Source (Wikipedia):**\n> ${data.title}: ${data.extract}`;
    }
    return null;
  } catch (e) {
    console.error("[SEARCH] Wiki Error:", e.message);
    return null;
  }
}

// Tool B: Google Search (Serper) - FALLBACK (Costly)
async function googleSearch(query) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { 
        "X-API-KEY": process.env.SERPER_API_KEY, 
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({ q: query, num: 3 })
    });
    const data = await res.json();
    if (!data.organic) return null;
    return "**Source (Google):**\n" + data.organic.map(r => `> ${r.title}: ${r.snippet}`).join("\n");
  } catch (e) { 
      return null; 
  }
}

/* ================= 5. AI ENGINE ================= */
async function streamSarvamChat({ messages, onChunk, wikiGrounding }) {
  const temperature = wikiGrounding ? 0.3 : 0.7; 

  try {
      const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: { 
          Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, 
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({ 
          model: CONSTANTS.SARVAM_MODEL, 
          messages, 
          temperature: temperature,
          max_tokens: CONSTANTS.MAX_TOKENS, 
          stream: true
        })
      });
      
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Sarvam API Error (${res.status}): ${errText}`);
      }
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = ""; 

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); 

        for (const line of lines) {
          if (line.startsWith("data: ") && !line.includes("[DONE]")) {
            try {
              const json = JSON.parse(line.slice(6));
              const txt = json.choices[0]?.delta?.content || "";
              if (txt) onChunk(txt.replace(/\n/g, "\\n")); 
            } catch (e) { }
          }
        }
      }
  } catch (e) {
      console.error("SARVAM STREAM ERROR:", e);
      throw e;
  }
}

/* ================= 6. MAIN API HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*', 
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  });

  if (req.method === 'OPTIONS') return res.end();

  try {
    const rawBody = req.body || {};
    let message = rawBody.message || "";
    const files = rawBody.files || [];
    const sessionId = rawBody.sessionId || crypto.randomBytes(12).toString("hex");

    console.log(`[REQ] ${sessionId.slice(0,6)} | Msg: ${message.slice(0, 30)}...`);

    const userKey = getUserIdentifier(req, rawBody);
    if (!(await checkRateLimit(userKey))) {
        res.write("ERROR|Rate limit exceeded.");
        return res.end();
    }

    if (Array.isArray(files) && files.length > 0) {
        let fileContext = "\n\n--- ATTACHED FILES ---\n";
        files.forEach((file, index) => {
            fileContext += `\nFILE ${index + 1}: ${file.fileName}\n\`\`\`\n${file.content}\n\`\`\`\n`;
        });
        message += fileContext;
    }

    const history = await DB.getHistory(sessionId);

    let context = "";
    const lowerMsg = message.toLowerCase();
    
    const isInternal = lowerMsg.includes("esamz") || lowerMsg.includes("alakmar");
    const isPersonal = lowerMsg.includes("my name") || lowerMsg.includes("who am i");

    const searchTriggers = [
        "who is", "what is", "where is", "when is", "how to","who was", 
        "news", "price", "stock", "weather", "latest", "recent",
        "history", "about", "explain", "define", "summary", "info" 
    ];
    
    const needsSearch = !isInternal && !isPersonal && 
                        searchTriggers.some(t => lowerMsg.includes(t)) && 
                        files.length === 0;

    if (needsSearch) {
      console.log(`[SEARCH] 🔎 Triggered for query: "${message}"`);
      res.write("STATUS|SEARCHING\n");
      
      // Step A: Wikipedia (Auto-Correct + Free)
      let searchRes = await wikipediaSearch(message.slice(0, 200));
      
      // Step B: Google (Fallback)
      if (!searchRes) {
        console.log(`[SEARCH] ❌ Wiki failed. Falling back to Google...`);
        searchRes = await googleSearch(message.slice(0, 200));
        
        if(searchRes) console.log(`[SEARCH] 🌍 Google returned result.`);
      }

      if (searchRes) {
        context = `\n\n[Live Search Context]:\n${searchRes}\n(Use this info to answer. Do not hallucinate.)`;
      }
    }

    res.write("STATUS|TYPING\n");

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
      { role: "user", content: message + context }
    ];

    let fullReply = "";
    
    await streamSarvamChat({
      messages,
      wikiGrounding: !!context, 
      onChunk: (text) => {
        fullReply += text;
        res.write(`CHUNK|${text}\n`);
      }
    });

    await DB.addToHistory(sessionId, 'user', message);
    await DB.addToHistory(sessionId, 'assistant', fullReply);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    console.error("FATAL ERROR:", e);
    res.write(`ERROR|Server Error: ${e.message}`);
    res.end();
  }
}
