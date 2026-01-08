import express from "express";
import { db } from "../db.js";

const router = express.Router();

router.post("/voice", async (req, res) => {
  const key = req.headers.authorization?.replace("Bearer ", "");
  const today = new Date().toISOString().slice(0, 10);

  if (!key) return res.status(403).end();

  const license = await db.get(
    "SELECT * FROM license_keys WHERE license_key=?",
    [key]
  );

  if (!license) return res.status(403).end();

  const limit = license.plan === "starter" ? 3 : 20;

  const usage = await db.get(
    "SELECT * FROM voice_usage WHERE license_key=? AND date=?",
    [key, today]
  );

  if (usage && usage.count >= limit) {
    return res.status(429).json({ error: "Limit reached" });
  }

  await db.run(
    `INSERT INTO voice_usage (license_key, date, count)
     VALUES (?,?,1)
     ON CONFLICT(license_key,date)
     DO UPDATE SET count=count+1`,
    [key, today]
  );

  res.json({ ok: true });
});

export default router;
