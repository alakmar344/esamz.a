export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // ---------- READ BODY ----------
  let raw = "";
  await new Promise(resolve => {
    req.on("data", chunk => (raw += chunk));
    req.on("end", resolve);
  });

  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { message, provider = "groq" } = body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message required" });
  }

  try {
    // =====================================================
    // ====================== GROQ =========================
    // =====================================================
    if (provider === "groq") {
      const r = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [
              { role: "system", content: "You are a helpful AI assistant." },
              { role: "user", content: message }
            ]
          })
        }
      );

      const data = await r.json();

      let reply = "";
      const content = data?.choices?.[0]?.message?.content;

      if (typeof content === "string") {
        reply = content;
      } else if (Array.isArray(content)) {
        reply = content.map(p => p.text || "").join("");
      }

      return res.json({
        provider: "groq",
        model: "llama-3.1-8b-instant",
        reply
      });
    }

    // =====================================================
    // =================== CLOUDFLARE ======================
    // =====================================================
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/microsoft/phi-3-mini-4k-instruct`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CF_AI_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: "You are a helpful AI assistant." },
            { role: "user", content: message }
          ]
        })
      }
    );

    const data = await r.json();

    let reply = "";
    if (typeof data?.result?.response === "string") {
      reply = data.result.response;
    } else if (typeof data?.result?.response?.text === "string") {
      reply = data.result.response.text;
    }

    return res.json({
      provider: "cloudflare",
      model: "phi-3-mini",
      reply
    });

  } catch (err) {
    console.error("BACKEND ERROR:", err);
    return res.status(500).json({
      error: "Backend failure",
      detail: err.message
    });
  }
}
