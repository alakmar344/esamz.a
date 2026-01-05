// api/proxy.js
import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { runChat } from "./chat.js";

/* ---------- REDIS ---------- */
const redis = Redis.fromEnv();

/* ---------- LIMIT CONFIG ---------- */
const CHAT_LIMIT_PER_MIN = 10; // 10 messages per minute per user
const CHAT_TTL_SEC = 60; // 60 seconds TTL for rate limit

/* ---------- UTILS ---------- */
function sha256(x) {
  return crypto.createHash("sha256").update(x).digest("hex");
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

/* ---------- USER IDENTIFIER ---------- */
// sessionId preferred, IP fallback
function getUserKey(req, body) {
  if (body.sessionId && typeof body.sessionId === "string") {
    return `sid:${body.sessionId}`;
  }
  return `ip:${getIP(req)}`;
}

/* ---------- RATE LIMITS ---------- */
async function checkChatLimit(userKey) {
  const key = `rl:chat:${userKey}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, CHAT_TTL_SEC);
  return count <= CHAT_LIMIT_PER_MIN;
}

/* ---------- HANDLER ---------- */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    /* ----- SERVER INTEGRITY (emz + hash) ----- */
    const raw = process.env.ESAMZ_INTERNAL_KEY;
    const hash = process.env.ESAMZ_KEY_HASH;
    
    if (!raw || !hash || !timingSafeEqual(sha256(raw), hash)) {
      return res.status(500).json({ error: "Server auth failure" });
    }

    /* ----- BODY ----- */
    const {
      message,
      files = [],
      sessionId
    } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message required" });
    }

    /* ----- USER KEY ----- */
    const userKey = getUserKey(req, { sessionId });

    /* ----- CHAT LIMIT (BEFORE AI) ----- */
    if (!(await checkChatLimit(userKey))) {
      return res.status(429).json({
        error: "Chat limit exceeded. Please wait a moment."
      });
    }

    /* ----- PREPARE MESSAGE WITH FILES ----- */
    let fullMessage = message;
    if (Array.isArray(files) && files.length > 0) {
      const fileContext = files
        .map(f => `File: ${f.fileName}\n${f.content}`)
        .join("\n\n");
      fullMessage = `${message}\n\n${fileContext}`;
    }

    /* ----- CHAT (MONEY SPENT HERE ONLY) ----- */
    const reply = await runChat({
      message: fullMessage,
      sarvamKey: process.env.SARVAM_API_KEY
    });

    /* ----- RESPONSE ----- */
    return res.json({
      reply
    });

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
