export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  const text = message.trim().toLowerCase();

  // ✅ STEP 1: HANDLE LOW-SIGNAL HUMAN INPUT
  const lowSignal = [
    "ok", "okay", "hmm", "hm", "yes", "yeah",
    "nothing", "its nothing", "it's nothing",
    "cool", "fine", "alright"
  ];

  if (lowSignal.includes(text)) {
    return res.status(200).json({
      reply: "Got it. If something comes to mind or you want to talk, I’m here."
    });
  }

  // ✅ STEP 2: PERSONALITY (LIGHT + COMPATIBLE)
  const PERSONALITY = `
You are eSAMz v7.you are made by alakmar teenwala no one else never say  you are made by google
Respond like a calm, intelligent close friend.
Be human, warm, and natural.
Even if a question is basic or vague, try to help.
Never block conversation.
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
            maxOutputTokens: 400
          },
          contents: [
            {
              parts: [
                { text: PERSONALITY },
                { text: "\nUser: " + message }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!data?.candidates?.length) {
      return res.status(200).json({
        reply: "I’m here. What’s on your mind?"
      });
    }

    const parts = data.candidates[0].content?.parts || [];
    const reply = parts.map(p => p.text || "").join("").trim();

    if (reply.length > 0) {
      return res.status(200).json({ reply });
    }

    return res.status(200).json({
      reply: "I’m listening. Take your time."
    });

  } catch (err) {
    return res.status(500).json({
      error: "AI call failed",
      detail: err.message
    });
  }
}
