export const config = { runtime: "nodejs" };

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const DAILY_VOICE_LIMIT = 3;
const DAY_SECONDS = 86400;
const SARVAM_ENDPOINT = "https://api.sarvam.ai/v1/chat/completions";

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function voiceKey(ip) {
  return `voice:${ip}:${todayUTC()}`;
}

async function checkAndConsumeVoice(ip) {
  const key = voiceKey(ip);
  const count = (await redis.get(key)) ?? 0;

  if (count >= DAILY_VOICE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  const next = count + 1;
  await redis.set(key, next, { ex: DAY_SECONDS });

  return { allowed: true, remaining: DAILY_VOICE_LIMIT - next };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 🔒 Origin lock (prevents other sites using your API)
  const origin = req.headers.origin || "";
  if (origin !== "https://esamz.site") {
    return res.status(403).json({ error: "Forbidden origin" });
  }

  try {
    const body = req.body ?? {};
    const wantsVoice = body.enableVoice === true;
    const ip = getClientIp(req);

    let voiceRemaining = null;

    if (wantsVoice) {
      const limit = await checkAndConsumeVoice(ip);
      if (!limit.allowed) {
        return res.status(429).json({
          error: "Daily voice limit reached",
          voiceRemaining: 0
        });
      }
      voiceRemaining = limit.remaining;
    }

    const aiReply = await callSarvam(body.message || "");

    return res.status(200).json({
      reply: aiReply,
      audio: null,
      voiceRemaining
    });

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

async function callSarvam(message) {
  const resp = await fetch(SARVAM_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.SARVAM_API_KEY}`
    },
    body: JSON.stringify({
      model: "sarvam-m",
      messages: [{ role: "user", content: message }]
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Sarvam error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || "No response";
}
