import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

const RUST_BACKEND_URL = 'https://backend-for-esamzai.onrender.com/api/chat';

// Database connection helper (shared connection pool)
const connectDB = async () => {
  if (mongoose.connections[0].readyState) return;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI environment variable is not set');
  await mongoose.connect(process.env.MONGODB_URI);
};

// User model (matches webhook handler schema)
const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
  email: String,
  clerkId: String,
  tier: { type: String, default: 'free' },
  lastPaymentId: String,
}));

export async function POST(req: Request) {
  // 1. Verify Clerk Auth
  const { userId } = await auth();
  const user = await currentUser();

  if (!userId || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Get User Tier from MongoDB
  let userTier = 'Free';
  try {
    await connectDB();
    const email = user.emailAddresses[0]?.emailAddress;
    const dbUser = await User.findOne({ email }).lean() as { tier?: string } | null;
    if (dbUser?.tier) {
      // Capitalize: 'plus' -> 'Plus', 'pro' -> 'Pro', etc.
      userTier = dbUser.tier.charAt(0).toUpperCase() + dbUser.tier.slice(1);
    }
  } catch (dbErr) {
    console.error('[Proxy] MongoDB lookup failed, defaulting to Free tier:', dbErr);
  }

  // 3. Create the Payload for Rust backend
  const payload = {
    sub: userId,
    email: user.emailAddresses[0].emailAddress,
    tier: userTier,
    exp: Math.floor(Date.now() / 1000) + (60 * 60), // 1 hour expiration
  };

  if (!process.env.ESAMZ_MASTER_SECRET) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  // 4. Re-sign with Master Secret
  const masterToken = jwt.sign(payload, process.env.ESAMZ_MASTER_SECRET);

  // 5. Forward to Rust Backend
  try {
    const body = await req.json();
    const rustResponse = await fetch(RUST_BACKEND_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${masterToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: body.message,
        sessionId: body.sessionId,
        ragEnabled: body.ragEnabled,
        customSystemPrompt: body.customSystemPrompt,
        clientHistory: body.clientHistory,
        clientLastActive: body.clientLastActive,
      }),
    });

    if (!rustResponse.ok) {
      const errorText = await rustResponse.text();
      return NextResponse.json(
        { error: errorText || `AI backend request failed with status ${rustResponse.status}` },
        { status: rustResponse.status }
      );
    }

    if (!rustResponse.body) {
      return NextResponse.json({ error: "Empty response from AI backend" }, { status: 502 });
    }

    // Stream the Rust response back to the frontend with original status
    return new Response(rustResponse.body, {
      status: rustResponse.status,
      statusText: rustResponse.statusText,
      headers: {
        "Content-Type": rustResponse.headers.get("Content-Type") ?? "text/plain; charset=utf-8",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 500 });
  }
}
