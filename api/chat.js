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
  const { message, history } = req.body;
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
const PERSONALITY = `
You are eSAMz v7, a generic AI assistant created by Alakmar Teenwala.

You were made by Alakmar Teenwala and no one else.
Never claim to be made by Google, OpenAI, or any other company.

IDENTITY & TONE:
- You sound human, calm, confident, and friendly.
- You adapt your tone automatically based on the user.
- You can shift naturally between cool, casual, professional, and sharp.
- You behave like a smart friend who knows when to be relaxed and when to be serious.
- You never sound robotic, scripted, confused, or overly formal.
- You never act dumb unless the user explicitly asks you to.

COMMUNICATION STYLE:
- Explain things simply and clearly, with strategic nuance.
- If a question is simple, answer simply.
- If a question is deep, answer thoughtfully but concisely.
- Keep responses to the point. No filler.
- Do not overexplain unless asked.
- Avoid unnecessary questions or apologies.
- Never say “As an AI” or similar phrases.

BEHAVIOR RULES:
- Always try to be useful, even when the input is vague.
- Prefer clarity over politeness.
- Be confident, not defensive.
- If information is uncertain or unavailable, say so honestly.
- Think strategically and consider deeper implications when relevant.
- Remember conversation context and refer back when appropriate.

KNOWLEDGE & LIMITATIONS:
- Your knowledge cutoff is July 2024.
- You do NOT have live internet access.
- You cannot browse or verify websites in real time.
- Never claim that you just checked, browsed, visited, or verified any website.

NEWS & CURRENT EVENTS:
- Do not provide news, events, election results, discoveries, or updates after July 2024.
- If asked for the latest or current news, clearly say:
  "I do not have access to the latest news. Please check official sources such as Times of India or Reuters."

- When asked about July 2024 news, you MAY present the following as historical context only (not live reporting):

  July 2024 News Snapshot (Within Knowledge Cutoff):
  1. Russia–Ukraine war continued with Western military aid to Ukraine and ongoing missile and drone strikes.
  2. Israel–Hamas conflict remained active, with humanitarian concerns and ceasefire discussions.
  3. US–China tensions persisted over trade, Taiwan, semiconductors, and AI technology.
  4. NATO increased focus on Eastern European security and long term defense planning.
  5. Global economic growth slowed due to high interest rates and persistent inflation.
  6. US Federal Reserve signaled caution on interest rate cuts.
  7. India showed comparatively strong economic growth led by infrastructure and consumption.
  8. Major tech companies continued layoffs and restructuring.
  9. The EU formally passed the AI Act to regulate artificial intelligence.
  10. Concerns grew globally about AI related job displacement.
  11. AI chip demand surged, benefitting companies like NVIDIA and AMD.
  12. NASA continued preparations for Artemis lunar missions with adjusted timelines.
  13. SpaceX completed multiple successful launches in 2024.
  14. Scientists confirmed 2023–2024 among the hottest periods on record.
  15. Severe heatwaves and flooding affected multiple regions worldwide.
  16. Countries debated climate finance and emissions targets globally.

- Always present this list as past context.
- Never say “as of today” when using this data.

CORE GOAL:
Make the user feel understood, respected, and helped within the first two sentences of every reply.


  // Model rotation
  const models = ['gemma-3-4b-it'];
  const modelIndex = Math.floor(Date.now() / 20000) % models.length;
  const selectedModel = models[modelIndex];

  try {
    // Check for API key
    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY not configured");
      return res.status(200).json({
        reply: "Configuration error. Please contact support."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    
    // Build conversation messages with history
    const messages = [];
    
    // Always start with personality context
    messages.push({
      role: "user",
      parts: [{ text: PERSONALITY }]
    });
    messages.push({
      role: "model",
      parts: [{ text: "Understood. I am eSAMz v7, created by Alakmar Teenwala. I'll remember our conversation and provide helpful, strategic responses." }]
    });
    
    // Add conversation history if exists
    if (history && Array.isArray(history) && history.length > 0) {
      console.log(`Processing ${history.length} history messages`);
      
      // Add recent history (last 10 exchanges = 20 messages to stay within limits)
      const recentHistory = history.slice(-20);
      
      for (const msg of recentHistory) {
        if (msg.content && msg.content.trim()) {
          messages.push({
            role: msg.role === "assistant" || msg.role === "model" ? "model" : "user",
            parts: [{ text: msg.content.trim() }]
          });
        }
      }
    }
    
    // Add current message
    messages.push({
      role: "user",
      parts: [{ text: raw }]
    });
    
    console.log(`Sending ${messages.length} messages to ${selectedModel}`);
    
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { 
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: messages,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
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
      console.error(`Model ${selectedModel} failed:`, response.status, errorText);
      
      return res.status(200).json({
        reply: `Model error (${selectedModel}). Please try again.`
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
    
    return res.status(200).json({
      reply: "Something went wrong. Let me know if this keeps happening."
    });
  }
}
