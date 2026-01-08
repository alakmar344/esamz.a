import express from "express";
import { db } from "../db.js";
import { generateKey, hash } from "../utils.js";

const router = express.Router();
const INTERNAL_KEY = "CHANGE_THIS_SECRET";

router.post("/create-license", async (req, res) => {
  if (req.headers["x-internal-key"] !== INTERNAL_KEY) {
    return res.status(403).end();
  }

  const { email } = req.body;
  const key = generateKey();

  await db.run(
    "INSERT INTO license_keys (license_key, plan, email_hash) VALUES (?,?,?)",
    [key, "adfree", hash(email)]
  );

  res.json({ key });
});


export default router;
