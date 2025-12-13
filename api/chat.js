export default async function handler(req, res) {
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

  /* ---------- 1.  1B-only chit-chat ---------- */
  const lowSignal = [
    "ok", "okay", "hmm", "hm", "yes", "yeah",
    "nothing", "its nothing", "it's nothing",
    "cool", "fine", "alright", "k"
  ];
  if (lowSignal.includes(text)) {
    return res.status(200).json({
      reply: await callGemma("1b", raw, history)
    });
  }

  /* ---------- 2.  smarter routing ---------- */
  const deepKeys = [
    "code", "html", "css", "javascript", "js",
    "api", "backend", "function", "file", "script",
    "debug", "explain", "logic", "algorithm"
  ];
  const needs4B = text.length > 120 || deepKeys.some(k => text.includes(k));

  /* ---------- 3.  anchored personality ---------- */
  const PERSONALITY = `
INSTRUCTIONS FOR ASSISTANT (DO NOT RESPOND TO THIS LINE):
You are eSAMz, an AI by Alakmar Teenwala.
- Transparent when unsure.
- Friendly, concise.
- Correct facts plainly.
- Keep tone casual, not corporate.
- Never invent towns, colours, or world-record stats; if uncertain, say “I’m not 100 % sure, but…” and keep going.
- Never invent numbers (dates, sizes, populations, durations); quote ranges or say “around” if unsure.
`.trim();

  /* ---------- 4.  build messages ---------- */
  const messages = [];
  messages.push({ role: "user", parts: [{ text: PERSONALITY }] });
  if (Array.isArray(history)) {
    for (const h of history.slice(-8)) {
      if (h?.content?.trim()) {
        messages.push({
          role: h.role === "assistant" ? "model" : "user",
          parts: [{ text: h.content.trim() }]
        });
      }
    }
  }
  messages.push({ role: "user", parts: [{ text: raw }] });

  /* ---------- 5.  call model ---------- */
  try {
    const reply = await callGemma(needs4B ? "4b" : "1b", null, messages);
    return res.status(200).json({ reply });
  } catch (e) {
    console.error("gemma fail", e);
    return res.status(200).json({ reply: "Temporary model issue. Please try again." });
  }
}

/* ---------- helper: identical fetch path ---------- */
async function callGemma(size, singlePrompt, fullMessages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("No GEMINI_API_KEY");

  const model = size === "4b" ? "gemma-3-4b-it" : "gemma-3-1b-it";

  const body = {
    contents: singlePrompt
      ? [{ role: "user", parts: [{ text: singlePrompt }] }]
      : fullMessages,
    generationConfig: {
      temperature: 0.6,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: size === "4b" ? 2048 : 512
    }
  };

  const rsp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );

  if (!rsp.ok) {
    console.error(await rsp.text());          // real error body
    throw new Error(`Gemma ${size} ${rsp.status}`);
  }

  const data = await rsp.json();
  return data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("").trim() ||
         "I’m here. What would you like to explore?";
}
