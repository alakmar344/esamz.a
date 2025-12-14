// /api/chat.js  –  serverless handler for Vercel
export default async function handler(req, res) {
  // ---------- CORS ----------
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  const { message, history = [] } = req.body || {};
  if (!message?.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }

  const system =
    'You are eSAMz AI by Alakmar Teenwala. Be warm, clear, helpful.be human like and you have 2m context window ' ';
   
  // Build OpenAI-compatible messages array
  const messages = [
    { role: 'system', content: system },
    ...history.slice(-10).map(h => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.content.trim()
    })),
    { role: 'user', content: message.trim() }
  ];

  try {
    const groqRes = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant', // 128k ctx, 7 500 free req/day
          messages,
          temperature: 0.7,
          max_tokens: message.length < 12 ? 512 : 4096
        })
      }
    );

    if (!groqRes.ok) {
      const txt = await groqRes.text();
      console.error('Groq error:', txt);
      throw new Error(txt);
    }

    const data = await groqRes.json();
    const reply = data.choices[0]?.message?.content?.trim() || '';

    return res.status(200).json({
      reply,
      model: 'llama-3.1-8b-instant',
      provider: 'groq'
    });
  } catch (e) {
    console.error('Fatal error:', e.message);
    return res.status(200).json({
      reply: "I'm currently at capacity. Please try again shortly."
    });
  }
}
