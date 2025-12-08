export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-2b:generateContent?key=" +
        process.env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: message
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    // ✅ SAFELY EXTRACT TEXT
    let reply = "";

    if (data?.candidates?.length) {
      const parts = data.candidates[0]?.content?.parts || [];
      reply = parts.map(p => p.text).join("").trim();
    }

    // ✅ HANDLE BLOCKED / EMPTY RESPONSES
    if (!reply) {
      return res.status(200).json({
        reply: "The model did not return a text response for this prompt."
      });
    }

    return res.status(200).json({ reply });

  } catch (err) {
    return res.status(500).json({
      error: "Gemma API call failed",
      detail: err.message
    });
  }
}
