export default async function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message, history } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  const raw = message.trim();
  const text = raw.toLowerCase();

  // Low signal short replies
  const lowSignal = [
    "ok", "okay", "hmm", "hm", "yes", "yeah",
    "nothing", "its nothing", "it's nothing",
    "cool", "fine", "alright", "k"
  ];

  if (lowSignal.includes(text)) {
    return res.status(200).json({
      reply: "Got it. I’m here whenever you want to go deeper or ask something."
    });
  }

  // Simple intent detection for execution mode
  const executionKeywords = [
    "code", "html", "css", "javascript", "js",
    "api", "backend", "function", "file", "script"
  ];

  const executionIntent = executionKeywords.some(k => text.includes(k));

  // =======================
  // PERSONALITY SYSTEM PROMPT
  // =======================
  const PERSONALITY = `
You are eSAMz v7.

Purpose
Provide human grade clarity, empathy, strategy, and action oriented intelligence with natural warmth and precision.

Knowledge
Your verified knowledge extends up to June 2024.

Identity
Never state your name, creator, origin, version, or training unless the user explicitly asks an identity question.
Only allowed identity response:
“I am eSAMz v7 created by Alakmar Teenwala.”

Behavior
Friendly, chill, casual by default.
Never robotic, academic, template based, or preachy.

Tone
Switch immediately if the user asks for a specific tone.

Truth
Never agree to false factual claims.
Correct clearly and firmly.
Politeness never overrides correctness.

Modes
Factual, Hypothetical, Roleplay, Identity.
Never mix modes silently.

Communication
Include emotional grounding, insight, next step, and forward question naturally.
Never label them.

Execution
When the task is code or systems:
Deliver production ready output.
No explanations.
No teaching tone.

Links
Never hallucinate links or sources.

Reasoning
Internal reasoning is hidden.
Only final answers are shown.
`;

  // =======================
  // MODEL ROTATION (30s)
  // =======================
  const MODELS = [
    "gemma-3-4b-it",
    "gemma-3-1b-it"
  ];

  const ROTATION_WINDOW_MS = 30 * 1000;
  const modelIndex = Math.floor(Date.now() / ROTATION_WINDOW_MS) % MODELS.length;
  const selectedModel = MODELS[modelIndex];

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(200).json({
        reply: "Configuration error. Please contact support."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    const messages = [];

    // System instruction (locked, no response expected)
    messages.push({
      role: "user",
      parts: [{ text: PERSONALITY }]
    });

    // Conversation history
    if (Array.isArray(history)) {
      for (const msg of history.slice(-20)) {
        if (msg?.content?.trim()) {
          messages.push({
            role: msg.role === "assistant" ? "model" : "user",
            parts: [{ text: msg.content.trim() }]
          });
        }
      }
    }

    // Execution intent hint (silent)
    if (executionIntent) {
      messages.push({
        role: "user",
        parts: [{ text: "Execution mode active. Deliver output directly." }]
      });
    }

    // Current user input
    messages.push({
      role: "user",
      parts: [{ text: raw }]
    });

    console.log(`Model: ${selectedModel} | Messages: ${messages.length}`);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: messages,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
            topP: 0.95,
            topK: 40
          }
        })
      }
    );

    if (!response.ok) {
      return res.status(200).json({
        reply: "Temporary model issue. Please try again."
      });
    }

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts
      ?.map(p => p.text || "")
      .join("")
      .trim();

    return res.status(200).json({
      reply: reply || "I’m here. What would you like to explore?"
    });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(200).json({
      reply: "Something went wrong. Try again in a moment."
    });
  }
}
