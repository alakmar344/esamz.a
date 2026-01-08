import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  const auth = req.headers.authorization;

  if (!auth) {
    return res.json({ plan: "free", ads: true });
  }

  const key = auth.replace("Bearer ", "");
  const data = await kv.hgetall(`license:${key}`);

  if (!data || Date.now() > Number(data.expires)) {
    return res.json({ plan: "free", ads: true });
  }

  res.json({ plan: "adfree", ads: false });
}




export default router;
