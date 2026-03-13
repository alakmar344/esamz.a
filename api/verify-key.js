const jwt = require("jsonwebtoken");

const SECRET         = process.env.ESAMZ_MASTER_SECRET;
const INTERNAL_TOKEN = process.env.ESAMZ_INTERNAL_TOKEN; // a random string only n8n knows

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  // Auth check — only n8n can call this
  const auth = req.headers["authorization"];
  if (!auth || auth !== `Bearer ${INTERNAL_TOKEN}`) {
    return res.status(401).json({ success: false, message: "Unauthorized." });
  }

  if (!SECRET) return res.status(500).json({ success: false, message: "Misconfiguration." });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const tier = (body.tier || "").trim();
  const validTiers = new Set(["Plus", "Pro", "Max"]);
  if (!validTiers.has(tier)) {
    return res.status(400).json({ success: false, message: "Invalid tier." });
  }

  const token = jwt.sign(
    { tier },
    SECRET,
    { expiresIn: "30d" }
  );

  return res.status(200).json({ success: true, token });
};
```

**Then in Vercel env vars, add:**
```
ESAMZ_INTERNAL_TOKEN = any_random_string_you_choose e.g. n8n-internal-2026
