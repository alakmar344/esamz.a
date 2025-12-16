export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  let raw = "";
  await new Promise(resolve => {
    req.on("data", c => (raw += c));
    req.on("end", resolve);
  });

  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { message, provider = "groq" } = body;

  try {
    if (provider === "groq") {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.1-70b-versatile",
          messages: [{ role: "user", content: message }]
        })
      });

      const text = await r.text(); // IMPORTANT
      console.log("GROQ STATUS:", r.status);
      console.log("GROQ RAW:", text);

      return res.json({ provider: "groq", raw: text });
    }

    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/microsoft/phi-3-lite-4k-instruct`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CF_AI_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: message }]
        })
      }
    );

    const text = await r.text(); // IMPORTANT
    console.log("CF STATUS:", r.status);
    console.log("CF RAW:", text);

    return res.json({ provider: "cloudflare", raw: text });

  } catch (e) {
    console.error("FETCH FAILED:", e);
    return res.status(500).json({ error: e.message });
  }
}
