/* ----------  DEBUG CONFIG  ---------- */
console.log('>>> BACKEND LOADED');

/* ----------  in-memory thread store  ---------- */
const threads    = new Map();
const timers     = new Map();
const THREAD_TTL = 10 * 60 * 1000;

/* ----------  Web Search (with detailed logging)  ---------- */
async function performWebSearch(query) {
  console.log('>>> SEARCH STARTED:', query);
  
  try {
    const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    console.log('>>> FETCHING:', searchUrl);
    
    const response = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log('>>> RESPONSE STATUS:', response.status);
    
    if (!response.ok) {
      console.error('>>> SEARCH FAILED - Status:', response.status);
      return null;
    }
    
    const html = await response.text();
    console.log('>>> HTML LENGTH:', html.length);
    
    // More robust parsing
    const results = [];
    let match;
    let count = 0;
    
    // DuckDuckGo HTML structure
    const resultRegex = /<div class="result"[\s\S]*?<a class="result__a"[^>]*>(.*?)<\/a>[\s\S]*?<div class="result__snippet">(.*?)<\/div>/gi;
    
    while ((match = resultRegex.exec(html)) !== null && count < 3) {
      const title = match[1].replace(/<[^>]*>/g, '').trim();
      const snippet = match[2].replace(/<[^>]*>/g, '').trim();
      
      if (title && snippet) {
        results.push(`${count + 1}. ${title}\n${snippet}`);
        count++;
      }
    }
    
    console.log('>>> EXTRACTED', results.length, 'RESULTS');
    
    if (results.length > 0) {
      const resultText = `Web search results for "${query}":\n\n${results.join('\n\n')}`;
      console.log('>>> RETURNING SEARCH CONTEXT');
      return resultText;
    }
    
    console.log('>>> NO RESULTS FOUND');
    return null;
  } catch (error) {
    console.error('>>> SEARCH ERROR:', error.message, error.stack);
    return null;
  }
}

/* ---------- ranked Groq models ---------- */
const MODELS = [
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b',
  'deepseek-r1-distill-llama-70b',
  'moonshotai/kimi-k2-instruct-0905',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-120b',
  'meta-llama/llama-guard-4-12b'
];

/* ---------- helper: try one model ---------- */
async function tryModel(model, messages, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  console.log('>>> TRYING MODEL:', model);
  
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method : 'POST',
    signal : controller.signal,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type' : 'application/json'
    },
    body: JSON.stringify({ model, messages })
  });
  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text().catch(() => '{}');
    throw new Error(`Groq ${res.status} – ${body}`);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (!reply) throw new Error('Empty reply from Groq');
  console.log('>>> MODEL SUCCESS:', model);
  return { model, reply };
}

module.exports = async function handler(req, res) {
  console.log('>>> REQUEST RECEIVED');
  
  /* ---------- CORS ---------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    console.log('>>> INVALID METHOD:', req.method);
    return res.status(405).json({ error: 'POST only' });
  }

  /* ---------- read body ---------- */
  let raw = '';
  try {
    await new Promise((resolve, reject) => {
      req.on('data', c => (raw += c));
      req.on('end', resolve);
      req.on('error', reject);
    });
  } catch (e) {
    console.error('>>> BODY READ ERROR:', e);
    return res.status(400).json({ error: 'Failed to read body' });
  }

  console.log('>>> RAW BODY:', raw.substring(0, 200) + '...');

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch (e) {
    console.error('>>> JSON PARSE ERROR:', raw);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('>>> PARSED BODY:', JSON.stringify(body, null, 2));

  const { message, threadId = 'default', webSearch = false, files = [], context = [] } = body;
  
  if (!message || typeof message !== 'string') {
    console.log('>>> MISSING MESSAGE');
    return res.status(400).json({ error: 'message required' });
  }

  console.log('>>> WEB SEARCH FLAG:', webSearch);
  console.log('>>> MESSAGE:', message);

  /* ---------- thread ---------- */
  if (!threads.has(threadId)) threads.set(threadId, []);
  const msgs = threads.get(threadId);
  console.log('>>> THREAD SIZE:', msgs.length);
  
  /* ---------- Web Search Logic ---------- */
  let searchContext = null;
  if (webSearch && message.toLowerCase().includes('search')) {
    const searchQuery = message.replace(/search/gi, '').trim();
    console.log('>>> SEARCH QUERY EXTRACTED:', searchQuery);
    if (searchQuery) {
      searchContext = await performWebSearch(searchQuery);
      console.log('>>> SEARCH CONTEXT:', searchContext ? 'FOUND' : 'NULL');
    }
  }
  
  // Build messages for Groq
  const groqMessages = [
    {
      role: 'system',
      content: 'You are esamz ai created by alakmar teenwala only and no one else. Be helpful, human-like, concise.' +
               (searchContext ? `\n\nUse these web search results to answer (cite sources):\n${searchContext}` : '')
    },
    ...msgs,
    { role: 'user', content: message }
  ];

  console.log('>>> GROQ MESSAGES COUNT:', groqMessages.length);

  /* ---------- auto-failover loop ---------- */
  let finalModel, finalReply;
  for (const model of MODELS) {
    try {
      const res = await tryModel(model, groqMessages, process.env.GROQ_API_KEY);
      finalModel = res.model;
      finalReply = res.reply;
      break;
    } catch (e) {
      console.warn('>>> MODEL FAILED:', model, e.message);
    }
  }

  if (!finalReply) {
    console.error('>>> ALL MODELS FAILED');
    return res.status(502).json({ error: 'All models unreachable' });
  }

  /* ---------- store conversation ---------- */
  msgs.push({ role: 'user', content: message });
  msgs.push({ role: 'assistant', content: finalReply });

  clearTimeout(timers.get(threadId));
  timers.set(
    threadId,
    setTimeout(() => {
      threads.delete(threadId);
      timers.delete(threadId);
      console.log('>>> THREAD EXPIRED:', threadId);
    }, THREAD_TTL)
  );

  console.log('>>> RESPONSE SENT');
  return res.json({
    provider: 'groq',
    model   : finalModel,
    reply   : finalReply,
    threadId,
    searchUsed: !!searchContext
  });
};
