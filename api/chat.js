export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message, history } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  const userText = message.trim();
  const lower = userText.toLowerCase();
  const isQuick = userText.length < 12;

  // ---------- SYSTEM PROMPT (INLINE) ----------
  const SYSTEM =
    "You are eSAMz AI by Alakmar Teenwala. Be warm, clear, and helpful. " +
    "When writing HTML, always output a single file with inline style and script.\n\n";

  // ---------- BUILD COMMON CONTENT ----------
  const contents = [
    { role: "user", parts: [{ text: SYSTEM + userText }] }
  ];

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

  // ---------- MODEL FALLBACK CHAIN ----------
  const chain = [
    { provider: "gemini", model: isQuick ? "gemini-2.5-flash-lite" : "gemini-2.5-flash" },
    { provider: "cloudflare", model: "@cf/meta/llama-3-8b-instruct" },
    { provider: "gemma", model: isQuick ? "gemma-3-1b" : "gemma-3-4b" }
  ];

  for (const step of chain) {
    try {
      let reply;

      if (step.provider === "gemini") {
        reply = await callGemini(step.model, contents, isQuick);
      } else if (step.provider === "cloudflare") {
        reply = await callCloudflareLlama(step.model, userText);
      } else {
        reply = await callGemma(step.model, userText);
      }

      return res.status(200).json({
        reply,
        model: step.model,
        provider: step.provider
      });
    } catch (e) {
      if (!e.retryable) {
        console.error("Fatal error:", e.message);
        break;
      }
    }
  }

  return res.status(200).json({
    reply: "I'm currently at capacity. Please try again shortly."
  });
}

/* ---------- GEMINI ---------- */
async function callGemini(model, contents, isQuick) {
  const rsp = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: isQuick ? 512 : 4096
        }
      })
    }
  );

  if (!rsp.ok) {
    const t = await rsp.text();
    if (t.includes("RESOURCE_EXHAUSTED") || rsp.status === 429) {
      const e = new Error("Gemini quota");
      e.retryable = true;
      throw e;
    }
    throw new Error(t);
  }

  const data = await rsp.json();
  return (
    data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("").trim()
  );
}

/* ---------- CLOUDFLARE LLAMA ---------- */
async function callCloudflareLlama(model, prompt) {
  const rsp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.CF_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: "You are a helpful AI assistant." },
          { role: "user", content: prompt }
        ]
      })
    }
  );

  const data = await rsp.json();

  if (!data.success) {
    const e = new Error("Cloudflare quota or failure");
    e.retryable = true;
    throw e;
  }

  return data.result.response;
}

/* ---------- GEMMA ---------- */
async function callGemma(model, prompt) {
  const rsp = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024
        }
      })
    }
  );

  if (!rsp.ok) {
    const e = new Error("Gemma failed");
    e.retryable = false;
    throw e;
  }

  const data = await rsp.json();
  return (
    data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("").trim()
  );
}
