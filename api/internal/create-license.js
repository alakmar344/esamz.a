import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  if (req.headers["x-internal-key"] !== process.env.INTERNAL_KEY) {
    return res.status(403).end();
  }

  const { email } = req.body;
  if (!email) return res.status(400).end();

  const key =
    "ESAMZ-ADFREE-" +
    crypto.randomBytes(3).toString("hex").toUpperCase();

  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;

  await redis.hset(`license:${key}`, {
    email,
    expires
  });

  res.json({ key });
}
