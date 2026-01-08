import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { email, license_key } = req.body;
  if (!email || !license_key)
    return res.status(400).json({ error: "Missing fields" });

  const data = await kv.hgetall(`license:${license_key}`);
  if (!data) return res.status(400).json({ error: "Invalid key" });

  if (data.email !== email)
    return res.status(403).json({ error: "Email mismatch" });

  res.json({ success: true });
}

  res.json({ plan: row.plan, expires_at: expires });
});

export default router;
