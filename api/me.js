import express from "express";
import { db } from "../db.js";

const router = express.Router();

router.get("/me", async (req, res) => {
  const key = req.headers.authorization?.replace("Bearer ", "");

  if (!key) {
    return res.json({ plan: "free", ads: true });
  }

  const row = await db.get(
    "SELECT * FROM license_keys WHERE license_key=?",
    [key]
  );

  if (!row || new Date(row.expires_at) < new Date()) {
    return res.json({ plan: "free", ads: true });
  }

  res.json({
    plan: row.plan,
    ads: false,
    voice_limit: row.plan === "starter" ? 3 : 20
  });
});

export default router;
