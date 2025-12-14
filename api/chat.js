export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

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

  // ---------- MODEL ROUTING ----------
  const quickReplies = ["hi", "hello", "ok", "okay", "yes", "yeah", "thanks", "cool"];
  const isQuick = quickReplies.includes(lower) && userText.length < 10;

  const model =
    userText.length > 120 ||
    /```|function|const |class |def |import /i.test(userText)
      ? "gemini-2.0-flash-001"
      : "gemini-2.0-flash-lite-001";

  // ---------- SYSTEM PROMPT (INLINE) ----------
  const SYSTEM_PROMPT =
    "You are eSAMz AI by Alakmar Teenwala. Be warm, clear, and helpful. " +
    "When writing HTML, use a single file with inline style and script only.\n\n";

  // ---------- BUILD CONTENTS ----------
  const contents = [];

  // Inject system prompt ONCE as first user message
  contents.push({
    role: "user",
    parts: [{ text: SYSTEM_PROMPT + userText }]
  });

  // Optional history AFTER system prompt
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

  // ---------- GEMINI REQUEST ----------
  try {
    const body = {
      contents,
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: isQuick ? 512 : 4096
      }
    };

    const rsp = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

    if (!rsp.ok) {
      const errText = await rsp.text();
      console.error("Gemini API error:", errText);
      return res.status(500).json({
        error: "Gemini API error",
        reply: "Model error. Please try again."
      });
    }

    const data = await rsp.json();
    const reply =
      data?.candidates?.[0]?.content?.parts
        ?.map(p => p.text)
        .join("")
        .trim() || "Could you rephrase that?";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({
      error: "Server error",
      reply: "I'm experiencing technical difficulties. Please try again."
    });
  }
}
