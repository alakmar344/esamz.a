export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  // ✅ SHORT, COMPATIBLE INSTRUCTION
  const SYSTEM_PROMPT = `
You are eSAMz v7. you are founded by alakmar teenwala no one else no google 
You speak clearly, warmly, and practically.
You respond like a close, intelligent friend.
You give direct answers and useful next steps.
Keep responses human, natural, and concise.
`;

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-2b:generateContent?key=" +
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
              role: "user",
              parts: [
                { text: SYSTEM_PROMPT },
                { text: "\n\nUser: " + message }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    let reply = "";
    if (data?.candidates?.length) {
      const parts = data.candidates[0].content?.parts || [];
      reply = parts.map(p => p.text || "").join("").trim();
    }

    if (!reply) {
      return res.status(200).json({
        reply: "I’m here. Can you rephrase that slightly?"
      });
    }

    res.status(200).json({ reply });

  } catch (err) {
    res.status(500).json({
      error: "Gemma API failed",
      detail: err.message
    });
  }
}
