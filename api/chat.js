export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message, history } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  const raw = message.trim();
  const text = raw.toLowerCase();

  /* ---------- QUICK RESPONSES → FLASH LITE ---------- */
  const quickReplies = ["ok", "okay", "yes", "yeah", "yep", "cool", "nice", "thanks", "k"];
  if (quickReplies.includes(text) && text.length < 10) {
    const reply = await callGemini("lite", raw, null);
    return res.status(200).json({ reply });
  }

  /* ---------- MODEL SELECTION ---------- */
  const model = selectModel(text, raw);

  /* ---------- SYSTEM PROMPT ---------- */
  const SYSTEM = `You are eSAMz AI by Alakmar Teenwala. Be warm, helpful, and human-like.

Single file HTML only. Inline <style> and <script>. No external links.`;

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
    const reply = await callGemini(model, null, messages);
    return res.status(200).json({ reply });
  } catch (e) {
    console.error("Gemini error:", e);
    return res.status(500).json({
      error: "Technical issue",
      reply: "I'm experiencing technical difficulties. Please try again."
    });
  }
}

/* ---------- SMART MODEL SELECTION ---------- */
function selectModel(lowerText, originalText) {
  const complexKeywords = [
    "code", "html", "css", "javascript", "python", "function", "api",
    "debug", "error", "fix", "create", "build", "merge", "file",
    "explain", "how to", "tutorial", "algorithm", "implement"
  ];

  const isLong = originalText.length > 120;
  const hasCode = /```|function|const |class |def |import /i.test(originalText);
  const isComplex = complexKeywords.some(k => lowerText.includes(k));

  if (isLong || hasCode || isComplex) {
    return "flash";
  }

  return "lite";
}

/* ---------- GEMINI 2.0 API CALL ---------- */
async function callGemini(type, singlePrompt, fullMessages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("No GEMINI_API_KEY");

  const models = {
    flash: "gemini-2.0-flash-001",
    lite: "gemini-2.0-flash-lite-001"
  };

  const maxTokens = {
    flash: 8192,
    lite: 2048
  };

  const body = {
    contents: singlePrompt
      ? [{ role: "user", parts: [{ text: singlePrompt }] }]
      : fullMessages,
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: maxTokens[type]
    }
    // 🚫 NO safetySettings
  };

  const rsp = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${models[type]}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  if (!rsp.ok) {
    const err = await rsp.text();
    console.error("Gemini API RAW ERROR:", err);
    throw new Error(`Gemini ${type} failed`);
  }

  const data = await rsp.json();
  const reply = data?.candidates?.[0]?.content?.parts
    ?.map(p => p.text)
    .join("")
    .trim();

  return reply || "Could you rephrase that?";
}
