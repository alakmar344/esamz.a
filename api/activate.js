import express from "express";
import { db } from "../db.js";
import { hash } from "../utils.js";

const router = express.Router();

router.post("/activate", async (req, res) => {
  const { license_key, email } = req.body;

  const row = await db.get(
    "SELECT * FROM license_keys WHERE license_key=?",
    [license_key]
  );

  if (!row || row.is_activated) {
    return res.status(400).json({ error: "Invalid key" });
  }

  if (row.email_hash !== hash(email)) {
    return res.status(403).json({ error: "Email mismatch" });
  }

  const expires = new Date();
  expires.setDate(expires.getDate() + 30);

  await db.run(
    "UPDATE license_keys SET is_activated=1, expires_at=? WHERE license_key=?",
    [expires.toISOString(), license_key]
  );

  res.json({ plan: row.plan, expires_at: expires });
});

export default router;
