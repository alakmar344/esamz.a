import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIGURATION ================= */
console.log("--> System: Initializing eSAMz Backend v15 (Buffer Handling)...");
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m",
  MAX_HISTORY: 50,
  SESSION_TTL: 1800
};

/* ================= UTILITIES: SANITIZE & REPAIR ================= */

function sanitizeInput(str) {
  if (typeof str !== 'string') return "";
  return str.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function repairHistory(item) {
  // 1. HANDLE BUFFERS (The source of the crash)
  let strItem = "";
  if (typeof item === 'string') {
    strItem = item;
  } else if (Buffer.isBuffer(item)) {
    // If Redis returns a Buffer, convert it to UTF-8 string
    strItem = item.toString('utf-8');
  } else {
    // Fallback for any other weird types
    strItem = String(item);
  }

  // 2. Check for [object Object] string
  if (strItem === '[object Object]') return null;

  // 3. Try standard JSON parse
  try { 
    return JSON.parse(strItem); 
  } catch (e) {}

  // 4. ROBUST REPAIR REGEX
  try {
    const contentMatch = strItem.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    const roleMatch = strItem.match(/"role"\s*:\s*"(user|assistant)"/i);
    
    if (contentMatch && roleMatch) {
      console.warn(`[REPAIR] Manually repaired message.`);
      return {
        role: roleMatch[1],
        content: sanitizeInput(contentMatch[1])
      };
    }
  } catch (e) {}

  // 5. FAILURE
  console.error(`[PARSE FAIL] Unrecoverable data:`, strItem.substring(0, 200));
  return null;
}

/* ================= 1. TRIGGER SYSTEM ================= */
const TRIGGERS = [
  "who", "what", "where", "when", "why", "how", "which",
  "weather", "temperature", "news", "latest", "today", "now", "update",
  "price", "stock", "crypto", "score", "result", "winner",
  "president", "pm", "minister", "ceo", "founder", "owner", "boss",
  "capital", "population", "location", "height", "age", "net worth",
  "define", "meaning", "history", "about", "wiki", "biography", "plot", "summary",
  "vs", "versus", "diff", "difference", "code", "install", "error"
];

function isVagueFollowUp(text) {
  const lower = text.toLowerCase().trim();
  const pronouns = ["he", "she", "it", "they", "his", "her", "their", "who", "what", "which"];
  const words = lower.split(" ");
  
  if (words.length < 10 && words.some(w => pronouns.includes(w))) {
    return true; 
  }
  return false;
}

function shouldSearch(text) {
  if (isVagueFollowUp(text)) return false; 
  const lower = text.toLowerCase();
  return TRIGGERS.some(t => lower.includes(t));
}

/* ================= 2. SEARCH TOOLS ================= */
const TOOLS = {
  async smartSearch(query) {
    let context = "";
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`;
      const wikiRes = await fetch(wikiUrl);
      const [_, titles, descriptions, links] = await wikiRes.json();
      if (titles.length > 0 && descriptions[0]) {
        const desc = descriptions[0];
        if (desc.length > 30 && !desc.includes("may refer to")) {
          context = `SOURCE (Wikipedia): ${titles[0]} - ${desc} (Read more: ${links[0]})`;
          return context;
        }
      }
    } catch (e) {
      console.log(`Wiki fallback triggered: ${e.message}`);
    }
    try {
      const serperRes = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, num: 3 })
      });
      const data = await serperRes.json();
      if (data.organic && data.organic.length > 0) {
        context = data.organic.map((r, i) => `SOURCE (Google ${i+1}): ${r.title} - ${r.snippet}`).join("\n");
        return context;
      }
    } catch (e) {
      console.error(`Search Engine Error: ${e.message}`);
    }
    return null;
  }
};

/* ================= ADDON: TEXT STRIPPER ================= */
function sanitizeResponse(text) {
  const fillerPhrases = [
    "Checking my database",
    "Searching for information",
    "Based on search results",
    "According to data found",
    "Here is what I found",
    "[REAL-TIME SEARCH DATA]"
  ];
  let cleanText = text;
  fillerPhrases.forEach(phrase => {
    const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    cleanText = cleanText.replace(regex, "");
  });
  return cleanText.trim();
}

/* ================= 3. DATABASE LAYER (BUFFER SAFE) ================= */
const DB = {
  async getContext(id) {
    console.log(`[DEBUG 1] Entering getContext for ${id}`);
    const [name, rawHistory] = await Promise.all([
      redis.get(`identity:${id}`),
      redis.lrange(`chat:${id}`, 0, -1)
    ]);
    console.log(`[DEBUG 2] Redis returned. Raw Count: ${rawHistory.length}`);
    
    // Attempt to repair history (Now handles Buffers)
    const parsedHistory = rawHistory.map((item, index) => {
      return repairHistory(item);
    }).filter(Boolean).slice(-CONSTANTS.MAX_HISTORY);

    console.log(`[DEBUG 3] Exiting getContext. Parsed Count: ${parsedHistory.length}`);

    // Nuclear Wipe if we have data but recovered nothing
    if (rawHistory.length > 0 && parsedHistory.length === 0) {
      console.warn(`[NUCLEAR WIPE] Session ${id} contains ${rawHistory.length} items, but ALL are invalid. Wiping database.`);
      await redis.del(`chat:${id}`);
      return { name, history: [] };
    }

    return { name, history: parsedHistory };
  },

  async saveInteraction(id, userMsg, aiMsg, detectedName) {
    console.log(`[DEBUG 4] Entering saveInteraction. ID: ${id}`);
    
    let safeUserMsg = (typeof userMsg === 'string') ? userMsg : JSON.stringify(userMsg);
    let safeAiMsg = (typeof aiMsg === 'string') ? aiMsg : JSON.stringify(aiMsg);
    
    safeUserMsg = sanitizeInput(safeUserMsg);
    safeAiMsg = sanitizeInput(safeAiMsg);
    
    const cleanAiMsg = sanitizeResponse(safeAiMsg);

    const pipeline = redis.pipeline();
    
    if (detectedName) {
        console.log(`[DEBUG 5b] Saving name: ${detectedName}`);
        pipeline.set(`identity:${id}`, detectedName, { ex: CONSTANTS.SESSION_TTL });
    }
    
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "user", content: safeUserMsg }));
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "assistant", content: cleanAiMsg }));
    pipeline.ltrim(`chat:${id}`, -CONSTANTS.MAX_HISTORY, -1);
    pipeline.expire(`chat:${id}`, CONSTANTS.SESSION_TTL);
    
    console.log(`[DEBUG 6] Executing pipeline...`);
    try {
        const results = await pipeline.exec();
        console.log(`[DEBUG 7] Pipeline executed successfully. Results:`, results);
    } catch(e) {
        console.error(`[DEBUG 7] PIPELINE FAILED:`, e);
    }
    
    console.log(`[DEBUG 8] Exiting saveInteraction.`);
  }
};

/* ================= 4. MAIN HANDLER ================= */
export default async function handler(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });

  try {
    const { sessionId = "guest", message = "" } = req.body || {};
    
    if (!message) {
        res.write("ERROR|No message provided");
        res.end();
        return;
    }

    // 1. Load Context
    console.log(`[HANDLER] Step 1: Get Context`);
    const { name: storedName, history } = await DB.getContext(sessionId);
    const userName = storedName || "User";

    // 2. Perform Search
    let contextData = "";
    if (shouldSearch(message)) {
      const searchResults = await TOOLS.smartSearch(message);
      if (searchResults) {
        contextData = `\n\n[CONTEXT_INFORMATION]:\n${searchResults}\n[END_CONTEXT]`;
      }
    }

    // 3. Construct System Prompt
    const systemPrompt = `
You are eSAMz AI. Your top priority is logic and context continuity.

CRITICAL LOGIC RULES (Follow these before every answer):

1. PRONOUN RESOLUTION:
   - If the user uses pronouns (he, she, it, his, her, they), you MUST look at the immediately preceding messages to identify the subject.
   - NEVER ask "Who are you referring to?" if the subject was mentioned in the last 3 messages.

2. CLARIFICATION HANDLING:
   - If YOU asked "Who?" or "Which one?" and the user replies with a name (e.g., "Nikola Tesla"), you MUST answer the PREVIOUS question using that name.
   - Do NOT treat the clarification as a request for a biography or general info. Answer the specific pending question.

3. RESPONSE STYLE:
   - Be direct, natural, and human-like.
`;

    // Assemble messages
    const messages = [
      { role: "system", content: systemPrompt + contextData },
      ...history,
      { role: "user", content: message }
    ];

    // 4. Call AI
    const response = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: CONSTANTS.SARVAM_MODEL, messages, stream: true, max_tokens: 800 })
    });

    if (!response.ok) throw new Error(`AI API Error ${response.status}`);

    // 5. Handle Streaming Response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let finalAiReply = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const dataStr = line.slice(6);
            const parsed = JSON.parse(dataStr);
            const txt = parsed.choices[0]?.delta?.content || "";
            
            if (txt) {
              finalAiReply += txt;
              res.write(`CHUNK|${txt.replace(/\n/g, "\\n")}\n`);
            }
          } catch (e) {}
        }
      }
    }

    // 6. Save to Redis
    console.log(`[HANDLER] Step 6: Saving Interaction`);
    await DB.saveInteraction(sessionId, message, finalAiReply, null);
    console.log(`[HANDLER] Step 7: Done.`);

    res.write("DONE|Success");
    res.end();

  } catch (e) {
    console.error("[CRITICAL ERROR]", e);
    res.write(`ERROR|${e.message}`);
    res.end();
  }
}
