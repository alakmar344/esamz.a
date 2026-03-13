const jwt = require("jsonwebtoken");

const SECRET         = process.env.ESAMZ_MASTER_SECRET;


// Plan durations in days
const PLAN_DURATION = { Plus: 30, Pro: 30, Max: 30 };

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

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

  const days    = PLAN_DURATION[tier];
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const token = jwt.sign(
    {
      tier,
      expiresAt: expiresAt.toISOString(),   // human readable expiry in token
      days,
    },
    SECRET,
    { expiresIn: `${days}d` }
  );

  return res.status(200).json({
    success:    true,
    token,
    tier,
    expiresAt:  expiresAt.toISOString(),
    days,
  });
};
