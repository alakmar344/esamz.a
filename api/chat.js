export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  // ---------- INPUT ----------
  const { message, history } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  const userText = message.trim();
  const lower = userText.toLowerCase();

  // ---------- QUICK CHECK ----------
  const quickReplies = ["hi", "hello", "ok", "okay", "yes", "yeah", "thanks"];
  const isQuick = quickReplies.includes(lower) && userText.length < 10;

  // ---------- SYSTEM PROMPT (INLINE FOR REST) ----------
  const SYSTEM =
    "You are eSAMz AI by Alakmar Teenwala. Be warm, clear, and helpful. " +
    "When writing HTML, always output a single file with inline style and script.\n\n";

  // ---------- BUILD CONTENTS ----------
  const contents = [];

  // System prompt injected once
  contents.push({
    role: "user",
    parts: [{ text: SYSTEM + userText }]
  });

  if (Array.isArray(history)) {
    history.slice(-10).forEach(h => {
      if (h?.content?.trim()) {
        contents.push({
          role: h.role === "assistant" ? "model" : "user",
          parts: [{ text: h.content.trim() }]
        });
      }
    });
  }

  // ---------- MODEL ORDER ----------
  // Priority: Gemini → Gemma
  const modelChain = isQuick
    ? [
        "gemini-2.5-flash-lite",
        "gemma-3-1b",
        "gemma-3-4b"
      ]
    : [
        "gemini-2.5-flash",
        "gemma-3-4b",
        "gemma-3-12b"
      ];

  // ---------- TRY MODELS ONE BY ONE ----------
  for (const model of modelChain) {
    try {
      const reply = await callModel(model, contents, isQuick);
      return res.status(200).json({ reply, model });
    } catch (err) {
      if (!err.retryable) {
        console.error("Fatal model error:", err.message);
        break;
      }
      // retry with next model
    }
  }

  // ---------- TOTAL FAILURE ----------
  return res.status(200).json({
    reply: "I'm currently at capacity. Please try again shortly."
  });
}

/* ---------- MODEL CALLER ---------- */
async function callModel(model, contents, isQuick) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("No GEMINI_API_KEY");

  const maxTokens =
    model.startsWith("gemini")
      ? isQuick ? 512 : 4096
      : isQuick ? 512 : 2048;

  const body = {
    contents,
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: maxTokens
    }
  };

  const rsp = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  if (!rsp.ok) {
    const errText = await rsp.text();

    // Retryable errors → try next model
    if (
      errText.includes("RESOURCE_EXHAUSTED") ||
      errText.includes("429")
    ) {
      const e = new Error(`Quota hit on ${model}`);
      e.retryable = true;
      throw e;
    }

    // Non-retryable
    const e = new Error(errText);
    e.retryable = false;
    throw e;
  }

  const data = await rsp.json();
  const reply =
    data?.candidates?.[0]?.content?.parts
      ?.map(p => p.text)
      .join("")
      .trim();

  if (!reply) {
    const e = new Error("Empty response");
    e.retryable = true;
    throw e;
  }

  return reply;
}
