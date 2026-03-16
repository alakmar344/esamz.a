import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";

export async function POST(req: Request) {
  // 1. Verify Clerk Auth
  const { userId } = await auth();
  const user = await currentUser();

  if (!userId || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Get User Tier from your MongoDB (Mocking logic here)
  // In v11, you'd fetch the 'tier' field we saved during the Cashfree webhook
  const userTier = "Pro"; // Example: Should be dynamic

  // 3. Create the Payload for Rust
  const payload = {
    sub: userId,
    email: user.emailAddresses[0].emailAddress,
    tier: userTier,
    exp: Math.floor(Date.now() / 1000) + (60 * 60), // 1 hour expiration
  };

  // 4. Re-sign with your Master Secret
  const masterToken = jwt.sign(payload, process.env.ESAMZ_MASTER_SECRET!);

  // 5. Forward to Rust Backend
  try {
    const body = await req.json();
    const rustResponse = await fetch("https://your-rust-api.com/api/chat", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${masterToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: body.message,
        sessionId: body.sessionId,
        ragEnabled: body.ragEnabled,
      }),
    });

    // Stream the Rust response back to the frontend
    return new Response(rustResponse.body, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    return NextResponse.json({ error: "Backend unreachable" }, { status: 500 });
  }
}
