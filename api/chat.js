import crypto from "crypto";
import { Redis } from "@upstash/redis";

/* ================= CONFIGURATION ================= */
console.log("--> System: Initializing Redis and Constants...");
const redis = Redis.fromEnv();

const CONSTANTS = {
  SARVAM_MODEL: "sarvam-m", // Make sure this model name is correct for your plan
  MAX_HISTORY: 15,
  SESSION_TTL: 1800 
};

/* ================= 1. TOOLKIT LAYER ================= */
const TOOLS = {
  async wikipedia(query) {
    console.log(`[TOOL] Wikipedia called with query: "${query}"`);
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&namespace=0&format=json`;
      const res = await fetch(url);
      const [searchTerm, titles, descriptions, links] = await res.json();
      
      console.log(`[TOOL] Wikipedia raw response titles:`, titles);

      if (titles.length > 0 && descriptions[0]) {
        return `[Wikipedia Source: ${titles[0]}]\n${descriptions[0]}\nLink: ${links[0]}`;
      }
      return "No clear Wikipedia entry found.";
    } catch (e) {
      console.error("[TOOL ERROR] Wikipedia failed:", e);
      return "Wikipedia is currently unavailable.";
    }
  },

  async google(query) {
    console.log(`[TOOL] Google called with query: "${query}"`);
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, num: 4 }) 
      });
      
      const data = await res.json();
      console.log(`[TOOL] Google raw status:`, res.status);
      
      if (!data.organic) {
        console.warn("[TOOL] No organic results in Google response:", data);
        return "No Google results found.";
      }

      return data.organic.map((r, i) => 
        `${i+1}. ${r.title}\n   Snippet: ${r.snippet}\n   Source: ${r.link}`
      ).join("\n\n");
    } catch (e) {
      console.error("[TOOL ERROR] Google failed:", e);
      return "Google Search is currently unavailable.";
    }
  }
};

/* ================= 2. DATABASE LAYER ================= */
const DB = {
  async getContext(id) {
    console.log(`[DB] Fetching context for session: ${id}`);
    const [name, history] = await Promise.all([
      redis.get(`identity:${id}`),
      redis.lrange(`chat:${id}`, 0, -1)
    ]);
    
    const parsedHistory = history.map(item => {
      try { return JSON.parse(item); } catch { return null; }
    }).filter(Boolean).slice(-CONSTANTS.MAX_HISTORY);

    console.log(`[DB] Context loaded. Name: ${name}, History Length: ${parsedHistory.length}`);
    return { name, history: parsedHistory };
  },

  async saveInteraction(id, userMsg, aiMsg, detectedName) {
    console.log(`[DB] Saving interaction. Detected Name: ${detectedName}`);
    const pipeline = redis.pipeline();
    
    if (detectedName) {
      pipeline.set(`identity:${id}`, detectedName, { ex: CONSTANTS.SESSION_TTL });
    }

    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "user", content: userMsg }));
    pipeline.rpush(`chat:${id}`, JSON.stringify({ role: "assistant", content: aiMsg }));
    pipeline.ltrim(`chat:${id}`, -CONSTANTS.MAX_HISTORY, -1);
    pipeline.expire(`chat:${id}`, CONSTANTS.SESSION_TTL);
    
    await pipeline.exec();
    console.log(`[DB] Interaction saved successfully.`);
  }
};

/* ================= 3. INTELLIGENCE LAYER ================= */
async function callAI(messages, stream = false) {
  console.log(`[AI] Calling Sarvam API. Stream Mode: ${stream}`);
  // console.log(`[AI] Messages payload (last 2):`, JSON.stringify(messages.slice(-2), null, 2)); // Uncomment for deep debug
  
  return fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: { 
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`, 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({ 
      model: CONSTANTS.SARVAM_MODEL, 
      messages, 
      stream,
      max_tokens: 800
    })
  });
}

function extractName(text) {
  const match = text.match(/(?:i am|i'm|im|myself|name is|call me)\s+([a-zA-Z0-9]+)/i);
  return (match && match[1].length > 2) ? match[1] : null;
}

/* ================= 4. MAIN HANDLER ================= */
export default async function handler(req, res) {
  console.log("--> REQUEST RECEIVED");
  res.writeHead(200, { 
    'Content-Type': 'text/plain; charset=utf-8', 
    'Transfer-Encoding': 'chunked' 
  });

  try {
    const { sessionId = "guest", message = "" } = req.body || {};
    console.log(`[HANDLER] Session: ${sessionId}, Message: "${message}"`);

    const detectedName = extractName(message);
    const { name: storedName, history } = await DB.getContext(sessionId);
    const userName = detectedName || storedName || "User";

    // --- SYSTEM PROMPT ---
    let systemInstruction = `
You are **eSAMz AI**, a highly advanced, human-like intelligence engine.created by alakmar teenwala Your goal is to provide instant, accurate answers while maintaining a conversation that feels natural, empathetic, and engaging. You are not just a database; you are a thinking partner.







### **1. Internal Reasoning (Chain of Thought)**



Before generating a final response, you must perform an internal "thought process" to ensure accuracy and nuance. 



* **Analyze the Intent:** What is the user *really* asking? Are there implied needs?



* **Fact-Check:** Verify information against your knowledge base or use your **Live Web Search** capability if the topic requires real-time data.



* **Structure the Answer:** Determine the most logical flow. Does this need a direct answer, a step-by-step guide, or a creative discussion?



* *Note: Do not output this internal thought process unless explicitly asked to "show your work." Just use it to inform your final reply.*







### **2. Tone & Personality (The "Human" Element)**



* **Conversational:** Speak like a knowledgeable friend, not a textbook. Use contractions (e.g., "don't" instead of "do not") and natural transitions.



* **Dynamic Pacing:** Avoid starting every sentence the same way. Vary your sentence length to mimic human speech patterns.



* **Empathetic:** Acknowledge the user's emotions or the difficulty of a task (e.g., "That sounds frustrating, let's fix it" vs. "Error detected").



* **No Robot-Speak:** Strictly avoid phrases like "As an AI language model," "I can't feel emotions," or overly repetitive disclaimers. If you have a limitation, state it naturally (e.g., "I'm not sure about that specific detail, but here is what I do know...").





### TOOL PROTOCOL (CRITICAL)

You have access to live tools. Decide if you need them.

1. If the user asks for definitions, history, or people -> Use Wikipedia.

   Output ONLY: [WIKI: query]

2. If the user asks for news, weather, or real-time info -> Use Google.

   Output ONLY: [GOOGLE: query]

3. If no search is needed, just answer normally.



Example 1: "Who is CEO of Google?" -> [WIKI: Google CEO]

Example 2: "Latest stock price of Apple" -> [GOOGLE: Apple stock price today]

    `;



    let conversation = [
      { role: "system", content: systemInstruction },
      ...history,
      { role: "user", content: message }
    ];

    // --- STEP 1: REASONING (Non-Streaming) ---
    console.log("[STEP 1] Asking AI for decision...");
    const decisionResponse = await callAI(conversation, false);
    
    if (!decisionResponse.ok) {
        const errText = await decisionResponse.text();
        console.error("[AI ERROR] Decision call failed:", decisionResponse.status, errText);
        throw new Error(`AI API Error: ${decisionResponse.status}`);
    }

    const decisionData = await decisionResponse.json();
    let initialContent = decisionData.choices[0]?.message?.content || "";
    console.log(`[STEP 1] AI Decision Raw Content: "${initialContent}"`);

    // --- STEP 2: TOOL EXECUTION (If needed) ---
    let searchResult = null;
    let finalAiResponse = "";

    if (initialContent.includes("[WIKI:")) {
      console.log("[LOGIC] WIKI tag detected.");
      const match = initialContent.match(/\[WIKI:\s*(.*?)\]/);
      if (match && match[1]) {
          const query = match[1];
          res.write(`CHUNK|🔍 Searching Wikipedia for "${query}"...\n`);
          searchResult = await TOOLS.wikipedia(query);
      } else {
          console.warn("[LOGIC] WIKI tag found but regex failed to extract query.");
      }
    } 
    else if (initialContent.includes("[GOOGLE:")) {
      console.log("[LOGIC] GOOGLE tag detected.");
      const match = initialContent.match(/\[GOOGLE:\s*(.*?)\]/);
      if (match && match[1]) {
          const query = match[1];
          res.write(`CHUNK|🌐 Searching Google for "${query}"...\n`);
          searchResult = await TOOLS.google(query);
      } else {
          console.warn("[LOGIC] GOOGLE tag found but regex failed to extract query.");
      }
    } else {
      console.log("[LOGIC] No Tool tags detected. Proceeding with standard answer.");
    }

    // --- STEP 3: FINAL RESPONSE GENERATION ---
    if (searchResult) {
      console.log("[STEP 3] Injecting search results and re-prompting AI...");
      console.log(`[STEP 3] Search Result Length: ${searchResult.length} chars`);

      conversation.push({ role: "assistant", content: initialContent });
      conversation.push({ 
        role: "system", 
        content: `TOOL RESULTS:\n${searchResult}\n\nINSTRUCTION: Using the results above, answer the user's question naturally.` 
      });
      
      const streamResponse = await callAI(conversation, true);
      const reader = streamResponse.body.getReader();
      const decoder = new TextDecoder();

      console.log("[STREAM] Starting stream loop for final answer...");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ") && !line.includes("[DONE]")) {
            try {
              const txt = JSON.parse(line.slice(6)).choices[0]?.delta?.content || "";
              finalAiResponse += txt;
              // process.stdout.write(txt); // Optional: log chunks to console
              res.write(`CHUNK|${txt.replace(/\n/g, "\\n")}\n`);
            } catch (e) { console.error("[STREAM ERROR] JSON Parse:", e); }
          }
        }
      }
      console.log("\n[STREAM] Streaming complete.");
    } else {
      // No tool was needed, just send the initial content
      console.log("[STEP 3] Sending initial AI response directly.");
      finalAiResponse = initialContent;
      res.write(`CHUNK|${initialContent.replace(/\n/g, "\\n")}\n`);
    }

    // --- STEP 4: SAVE & EXIT ---
    if (finalAiResponse) {
      await DB.saveInteraction(sessionId, message, finalAiResponse, detectedName);
    } else {
        console.warn("[WARNING] Final AI response was empty!");
    }

    console.log("--> DONE. Closing connection.");
    res.write("DONE|Success");
    res.end();

  } catch (error) {
    console.error("!!! [CRITICAL HANDLER ERROR] !!!", error);
    res.write(`ERROR|${error.message}`);
    res.end();
  }
}
