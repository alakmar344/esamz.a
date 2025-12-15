// /api/chat.mjs  –-  Vercel serverless
console.log('🔧 chat.mjs cold-start');          // ← should appear in Vercel logs

export default async function (req, res) {
  console.log('📬 request', req.method, req.url); // ← proves request arrived

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST' });

  const body = req.body || {};
  console.log('🧩 body', JSON.stringify(body, null, 0)); // ← see what front-end sent

  const { message, history = [], mode = 'thinking' } = body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  const system = { role: 'system', content: 'You are eSAMz AI by Alakmar Teenwala. Be warm, clear, helpful.' };
  const msgs = [system, ...history.slice(-10), { role: 'user', content: message.trim() }];

  try {
    const fast = mode === 'fast';
    const reply = fast
      ? await cf(msgs)
      : await groq(msgs);

    const out = { reply, model: fast ? 'phi-3-mini' : 'llama-3.1-70b', provider: fast ? 'cloudflare' : 'groq' };
    console.log('✅ response', out);
    return res.status(200).json(out);

  } catch (e) {
    console.error('❌ catch', e.message);
    return res.status(200).json({ reply: "I'm at capacity. Try again shortly." });
  }
}

/* ---------- helpers ---------- */
async function cf(msgs) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${process.env.CF_MODEL_PHI}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: msgs, temperature: 0.7, max_tokens: 2048 })
    }
  );
  const j = await r.json();
  if (!j.success) throw new Error(j.errors?.[0]?.message || 'CF error');
  return j.result.response.trim();
}

async function groq(msgs) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.1-70b-versatile', messages: msgs, temperature: 0.7, max_tokens: 4096 })
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).choices[0].message.content.trim();
}
