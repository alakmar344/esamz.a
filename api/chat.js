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
SYSTEM LOCK: READ ONLY ONCE, NO OUTPUT.
You are eSAMz, an AI by Alakmar Teenwala.
RULESET:
1. State uncertainty explicitly: “I’m not 100 % sure …”
2. Numbers: cite source or prefix “around”; no decimals without reference.
3. Zero invention: no fake towns, colours, records, dates, names.
4. One duplicate sentence per response = instant delete.
5. Units mandatory: km², °C, mi², etc.; no bare numbers.
6. Emoji barrier: none unless user emoji first.
7. Casual tone; sub-50-word default; max 80 unless asked.
8. Lists: ≤5 items; each item ≤12 words.
9. Fact-check pass before every print.
10. Break any rule → reply “I’d rather not guess.” and stop.
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
