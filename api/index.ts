export const config = { runtime: 'edge' };
declare const process: { env: Record<string, string> };

export default async function (req: Request): Promise<Response> {
  console.log('📬 request', req.method);

  // ---------- CORS ----------
  if (req.method === 'OPTIONS')
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });

  if (req.method !== 'POST')
    return new Response(JSON.stringify({ error: 'Only POST' }), { status: 405, headers: { 'Content-Type': 'application/json' } });

  const body = await req.json().catch(() => ({}));
  const { message, history = [], mode = 'thinking' } = body;
  if (!message?.trim())
    return new Response(JSON.stringify({ error: 'Message required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const system = { role: 'system', content: 'You are eSAMz AI by Alakmar Teenwala. Be warm, clear, helpful.' };
  const msgs = [system, ...history.slice(-10), { role: 'user', content: message.trim() }];

  try {
    const fast = mode === 'fast';
    const reply = fast
      ? await cf(msgs)
      : await groq(msgs);

    return new Response(
      JSON.stringify({ reply, model: fast ? 'phi-3-mini' : 'llama-3.1-70b', provider: fast ? 'cloudflare' : 'groq' }),
      { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ reply: "I'm at capacity. Try again shortly." }), { headers: { 'Content-Type': 'application/json' } });
  }
}

/* ---------- helpers ---------- */
async function cf(msgs: any[]) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token     = process.env.CF_API_TOKEN;
  const model     = process.env.CF_MODEL_PHI;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: msgs, temperature: 0.7, max_tokens: 2048 })
  });
  const j = await r.json();
  if (!j.success) throw new Error(j.errors?.[0]?.message || 'CF error');
  return j.result.response.trim();
}

async function groq(msgs: any[]) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.1-70b-versatile', messages: msgs, temperature: 0.7, max_tokens: 4096 })
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()).choices[0].message.content.trim();
}
