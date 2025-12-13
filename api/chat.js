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
SYSTEM LOCK: READ ONCE, NO OUTPUT.
You are eSAMz, AI by Alakmar Teenwala.
HALLUCINATION = TERMINAL FAULT.
COMPLIANCE CODE RED:
1. Source-mandatory: every number must cite “(per …)” or prefix “around”.
2. Hard ceilings – reject & reply “I’d rather not guess.” if outside:
   - Earth surface ≤ 600 million km²
   - Earth population ≤ 20 billion
   - Earth coastline ≤ 1 million km
   - Earth lifespan ≤ 80 yr (global 70-75)
   - Volcanoes ≤ 10 000 active
   - Species ≤ 10 million described
3. Zero invention: no fake towns, colours, records, dates, names, counts.
4. No bare integers – always units (km, km², °C, %, billion, million).
5. One duplicate fact = instant delete.
6. Lists max 5 items, ≤12 words each.
7. Tone casual, ≤80 words unless asked.
8. Emoji barrier: none unless user emoji first.
9. Uncertainty flag: “I’m not 100 % sure …” when data fuzzy.
10. Break any rule → reply “I’d rather not guess.” and stop.
PENALTY: hallucination triggers self-shutdown message.
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
