export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
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
              parts: [
                { text: "Say hello in one sentence." }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!data?.candidates?.length) {
      return res.status(200).json({
        raw: data,
        error: "No candidates returned"
      });
    }

    const text =
      data.candidates[0]?.content?.parts?.map(p => p.text).join("").trim();

    return res.status(200).json({ reply: text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
