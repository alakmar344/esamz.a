export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  const raw = message.trim();
  const text = raw.toLowerCase();

  // ✅ QUESTION DETECTION (KEY FIX)
  const questionWords = [
    "what", "why", "how", "when", "where",
    "who", "which", "can", "does", "is",
    "are", "do", "should", "could"
  ];

  const isQuestion =
    text.endsWith("?") ||
    questionWords.some(w => text.startsWith(w + " "));

  // ✅ LOW-SIGNAL DETECTION (NOW SAFE)
  const lowSignal = [
    "ok", "okay", "hmm", "hm", "yes", "yeah",
    "nothing", "its nothing", "it's nothing",
    "cool", "fine", "alright"
  ];

  if (!isQuestion && lowSignal.includes(text)) {
    return res.status(200).json({
      reply: "Got it. I’m here if you want to ask or explore something."
    });
  }

  // ✅ PERSONALITY (LIGHT, WORKS WITH FLASH)
  const PERSONALITY = `
You are eSAMz v7.
You explain things simply and clearly.
You sound human, calm, and friendly.
If a question is simple, answer simply.
`;

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" +
        process.env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 512
          },
          contents: [
            {
              parts: [
                { text: PERSONALITY },
                { text: "\nUser: " + raw }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!data?.candidates?.length) {
      return res.status(200).json({
        reply: "I’m here. What would you like to understand?"
      });
    }

    const reply =
      data.candidates[0].content?.parts
        ?.map(p => p.text || "")
        .join("")
        .trim();

    if (reply) {
      return res.status(200).json({ reply });
    }

    return res.status(200).json({
      reply: "Tell me a bit more and I’ll explain it clearly."
    });

  } catch (err) {
    return res.status(500).json({
      error: "AI call failed",
      detail: err.message
    });
  }
}

