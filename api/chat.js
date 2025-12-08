export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  const PERSONALITY = `
You are eSAMz v7.
Speak like a calm, intelligent close friend.
Be clear, human, and practical.
Answer directly even for simple questions.
When a question is vague, still try to help.
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

    if (!data?.candidates || data.candidates.length === 0) {
      return res.status(200).json({
        reply: "I didn’t get a usable response. Try asking in a slightly different way."
      });
    }

    const parts = data.candidates[0].content?.parts || [];
    const replyText = parts.map(p => p.text).join("").trim();

    // ✅ IMPORTANT FIX: return model output as-is
    if (replyText.length > 0) {
      return res.status(200).json({ reply: replyText });
    }

   
  } catch (err) {
    return res.status(500).json({
      error: "AI call failed",
      detail: err.message
    });
  }
}

