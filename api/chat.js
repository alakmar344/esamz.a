export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  // ---- SAFE BODY PARSING ----
  let body = "";
  await new Promise(resolve => {
    req.on("data", chunk => (body += chunk));
    req.on("end", resolve);
  });

  const parsed = body ? JSON.parse(body) : {};
  const { message, provider = "cloudflare" } = parsed;

  if (!message) {
    return res.status(400).json({ error: "message required" });
  }

  try {
    // ===== GROQ =====
    if (provider === "groq") {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.1-70b-versatile",
          messages: [{ role: "user", content: message }]
        })
      });

      const data = await r.json();
      return res.json({
        provider: "groq",
        reply: data.choices?.[0]?.message?.content || ""
      });
    }

    // ===== CLOUDFLARE =====
    const cfUrl =
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}` +
      `/ai/run/@cf/microsoft/phi-3-lite-4k-instruct`;

    const r = await fetch(cfUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.CF_AI_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: message }]
      })
    });

    const data = await r.json();
   const cfReply =
  typeof data.result?.response === "string"
    ? data.result.response
    : data.result?.response?.text || "";

return res.json({
  provider: "cloudflare",
  model: "phi-3-lite",
  reply: cfReply
});


  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
