export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const response = await fetch('https://esamz.site/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',

        // 🔒 KEY IS ADDED HERE (SERVER ONLY)
        'x-esamz-key': process.env.ESAMZ_BACKEND_KEY
      },
      body
    });

    const data = await response.text();

    res.status(response.status).send(data);
  } catch (e) {
    res.status(500).json({ error: 'Proxy failed' });
  }
}
