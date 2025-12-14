export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  const { message, history } = req.body;
  
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  const raw = message.trim();
  const text = raw.toLowerCase();

  /* ---------- QUICK RESPONSES (2B) ---------- */
  const quickReplies = ["ok", "okay", "yes", "yeah", "yep", "cool", "nice", "thanks", "k"];
  if (quickReplies.includes(text) && text.length < 10) {
    return res.status(200).json({
      reply: await callGemma("2b", raw, history)
    });
  }

  /* ---------- MODEL SELECTION ---------- */
  const model = selectModel(text, raw);

  /* ---------- SYSTEM PROMPT ---------- */
  const SYSTEM = `You are eSAMz AI by Alakmar Teenwala. 2M context. Be warm, helpful, human-like.

Single file HTML = inline <style> and <script> tags only. No external links.`;

  /* ---------- BUILD MESSAGES ---------- */
  const messages = [{ role: "user", parts: [{ text: SYSTEM }] }];
  
  if (Array.isArray(history)) {
    history.slice(-10).forEach(h => {
      if (h?.content?.trim()) {
        messages.push({
          role: h.role === "assistant" ? "model" : "user",
          parts: [{ text: h.content.trim() }]
        });
      }
    });
  }
  
  messages.push({ role: "user", parts: [{ text: raw }] });

  /* ---------- CALL MODEL ---------- */
  try {
    const reply = await callGemma(model, null, messages);
    return res.status(200).json({ reply });
  } catch (e) {
    console.error("Model error:", e);
    return res.status(500).json({ 
      error: "Technical issue",
      reply: "I'm experiencing technical difficulties. Please try again." 
    });
  }
}

/* ---------- SMART MODEL SELECTION ---------- */
function selectModel(lowerText, originalText) {
  // Use 27B for complex tasks
  const complexKeywords = [
    "code", "html", "css", "javascript", "python", "function", "api",
    "debug", "error", "fix", "create", "build", "merge", "file",
    "explain", "how to", "tutorial", "algorithm", "implement"
  ];
  
  const isLong = originalText.length > 120;
  const hasCodeBlock = /```|function|const |class |def |import /i.test(originalText);
  const hasComplexKeyword = complexKeywords.some(k => lowerText.includes(k));
  
  if (isLong || hasCodeBlock || hasComplexKeyword) {
    return "27b";
  }
  
  // Use 4B for normal conversations
  return "4b";
}

/* ---------- GEMMA API CALL ---------- */
async function callGemma(size, singlePrompt, fullMessages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("No GEMINI_API_KEY");

  const models = {
    "2b": "gemma-2-2b-it",
    "4b": "gemma-2-9b-it",
    "27b": "gemma-2-27b-it"
  };

  const tokens = {
    "2b": 1024,
    "4b": 2048,
    "27b": 8192
  };

  const model = models[size];

  const body = {
    contents: singlePrompt
      ? [{ role: "user", parts: [{ text: singlePrompt }] }]
      : fullMessages,
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: tokens[size]
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ]
  };

  const rsp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    { 
      method: "POST", 
      headers: { "Content-Type": "application/json" }, 
      body: JSON.stringify(body) 
    }
  );

  if (!rsp.ok) {
    const errorText = await rsp.text();
    console.error(`Gemma ${size} error:`, errorText);
    throw new Error(`Gemma ${size} failed: ${rsp.status}`); // ✅ FIXED THIS LINE
  }

  const data = await rsp.json();
  
  const reply = data?.candidates?.[0]?.content?.parts
    ?.map(p => p.text)
    .join("")
    .trim();

  if (!reply) {
    console.warn("Empty response:", JSON.stringify(data));
    return "Could you rephrase that?";
  }

  return reply;
}
