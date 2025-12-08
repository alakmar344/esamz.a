export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  // Validate message input
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  const raw = message.trim();
  const text = raw.toLowerCase();

  // Question detection
  const questionWords = [
    "what", "why", "how", "when", "where",
    "who", "which", "can", "does", "is",
    "are", "do", "should", "could", "will"
  ];
  
  const isQuestion =
    text.endsWith("?") ||
    questionWords.some(w => text.startsWith(w + " "));

  // Low-signal input detection
  const lowSignal = [
    "ok", "okay", "hmm", "hm", "yes", "yeah",
    "nothing", "its nothing", "it's nothing",
    "cool", "fine", "alright", "k"
  ];

  if (!isQuestion && lowSignal.includes(text)) {
    return res.status(200).json({
      reply: "Got it. I'm here if you want to ask or explore something."
    });
  }

  // Personality system prompt
  const PERSONALITY = `You are eSAMz v7, a generic AI assistant created by Alakmar Teenwala.
You were made by Alakmar Teenwala and no one else. Never claim to be made by Google or any other company.
You explain things simply and clearly with strategic nuance in everything you say.
You sound human, calm, and friendly.
If a question is simple, answer simply.
Keep responses concise and helpful.
Always think strategically and consider the deeper implications of questions.`;

  try {
    // Check for API key
    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY not configured");
      return res.status(200).json({
        reply: "Configuration error. Please contact support."
      });
    }

    // Call Gemini API with correct endpoint structure
    const apiKey = process.env.GEMINI_API_KEY;
    console.log('API Key exists:', !!apiKey);
    console.log('API Key length:', apiKey?.length || 0);
    
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: `${PERSONALITY}\n\nUser: ${raw}` }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 512,
            topP: 0.95,
            topK: 40
          },
          safetySettings: [
            {
              category: "HARM_CATEGORY_HARASSMENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              category: "HARM_CATEGORY_HATE_SPEECH",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            }
          ]
        })
      }
    );

    // Handle non-200 responses
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Gemini API error:", response.status, errorText);
      
      // TEMPORARY: Show error for debugging
      return res.status(200).json({
        reply: `API Error ${response.status}: ${errorText.substring(0, 300)}`
      });
    }

    const data = await response.json();

    // Check for valid response
    if (!data?.candidates?.length) {
      console.warn("No candidates in response:", data);
      return res.status(200).json({
        reply: "I'm here. What would you like to understand?"
      });
    }

    // Extract reply text
    const candidate = data.candidates[0];
    
    // Check if content was blocked
    if (candidate.finishReason === "SAFETY") {
      return res.status(200).json({
        reply: "I can't respond to that, but I'm happy to help with something else."
      });
    }

    const reply = candidate.content?.parts
      ?.map(p => p.text || "")
      .join("")
      .trim();

    if (reply) {
      return res.status(200).json({ reply });
    }

    // Fallback if no text extracted
    return res.status(200).json({
      reply: "Tell me a bit more and I'll explain it clearly."
    });

  } catch (err) {
    console.error("Handler error:", err);
    console.error("Error details:", {
      message: err.message,
      stack: err.stack
    });
    
    // Return friendly error to user
    return res.status(200).json({
      reply: "Something went wrong. Let me know if this keeps happening."
    });
  }
}
