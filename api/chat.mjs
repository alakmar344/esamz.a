export const runtime = "nodejs20.x";

function send(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "POST") {
    return send(res, 405, { error: "POST only" });
  }

  const { message, provider = "cloudflare" } = req.body || {};
  if (!message || typeof message !== "string") {
    return send(res, 400, { error: "message required" });
  }

  try {
    // ================= GROQ (LLAMA 3.1 70B) =================
    if (provider === "groq") {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.1-70b-versatile",
          messages: [
            { role: "system", content: "You are eSAMz AI. Be precise and helpful." },
            { role: "user", content: message }
          ]
        })
      });

      const data = await r.json();
      return send(res, 200, {
        provider: "groq",
        model: "llama-3.1-70b",
        reply: data.choices?.[0]?.message?.content || ""
      });
    }

    // ================= CLOUDFLARE (PHI-3 LITE) =================
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
        messages: [
          { role: "system", content: "You are eSAMz AI. Be concise and fast." },
          { role: "user", content: message }
        ]
      })
    });

    const data = await r.json();
    return send(res, 200, {
      provider: "cloudflare",
      model: "phi-3-lite",
      reply: data.result?.response || ""
    });

  } catch (err) {
    return send(res, 500, { error: err.message });
  }
}
