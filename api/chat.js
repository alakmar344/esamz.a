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
  const isQuick = userText.length < 12;

  // ---------- SYSTEM PROMPT ----------
  const SYSTEM =
    "You are eSAMz AI by Alakmar Teenwala. Be warm, clear, and helpful. " +
    "When writing HTML, always output a single file with inline style and script.\n\n";

  // ---------- BUILD MESSAGES FOR LLAMA ----------
  const messages = [
    { role: "system", content: SYSTEM },
    ...(Array.isArray(history)
      ? history.slice(-10).map(h => ({
          role: h.role === "assistant" ? "assistant" : "user",
          content: h.content.trim()
        }))
      : []),
    { role: "user", content: userText }
  ];

  // ---------- CALL CLOUDFLARE LLAMA ----------
  try {
    const reply = await callCloudflareLlama(
      "@cf/meta/llama-3.1-8b-instruct",
      messages,
      isQuick
    );
    return res.status(200).json({
      reply,
      model: "@cf/meta/llama-3.1-8b-instruct",
      provider: "cloudflare"
    });
  } catch (e) {
    console.error("Fatal error:", e.message);
    return res.status(200).json({
      reply: "I'm currently at capacity. Please try again shortly."
    });
  }
}

/* ---------- CLOUDFLARE LLAMA (ONLY) ---------- */
async function callCloudflareLlama(model, messages, isQuick) {
  const rsp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages,
        stream: false,
        max_tokens: isQuick ? 512 : 4096,
        temperature: 0.7,
        top_p: 0.95
      })
    }
  );

  if (!rsp.ok) {
    const t = await rsp.text();
    if (rsp.status === 429) {
      const e = new Error("Cloudflare quota");
      e.retryable = true;
      throw e;
    }
    throw new Error(t);
  }

  const data = await rsp.json();
  if (!data.success) {
    const e = new Error("Cloudflare failure");
    e.retryable = false;
    throw e;
  }
  return data.result.response.trim();
}
