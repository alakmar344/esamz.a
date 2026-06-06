import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import mongoose from "mongoose";

const PRIVACY_POLICY_URL = "https://esamz.info/privacypolicy";

const connectDB = async () => {
  if (mongoose.connections[0].readyState) return;
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI environment variable is not set");
  await mongoose.connect(process.env.MONGODB_URI);
};

const User = mongoose.models.User || mongoose.model("User", new mongoose.Schema({
  email: String,
  clerkId: String,
  name: String,
  tier: { type: String, default: "free" },
  lastPaymentId: String,
  privacyPolicyAccepted: { type: Boolean, default: false },
  privacyPolicyAcceptedAt: Date,
  privacyPolicyAcceptanceLog: {
    acceptedAt: Date,
    policyUrl: String,
    name: String,
    email: String,
    plan: String,
    userAgent: String,
    ip: String,
  },
}));

export async function POST(req: Request) {
  const { userId } = await auth();
  const user = await currentUser();

  if (!userId || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    if (body?.accepted !== true) {
      return NextResponse.json({ error: "Privacy policy acceptance is required" }, { status: 400 });
    }

    await connectDB();

    const acceptedAt = new Date();
    const email = user.emailAddresses[0]?.emailAddress;
    const name = user.fullName
      || [user.firstName, user.lastName].filter(Boolean).join(" ").trim()
      || user.username
      || "unknown";
    const userAgent = req.headers.get("user-agent") || "unknown";
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("x-real-ip")
      || "unknown";

    // Capture the user's current plan (tier) at the moment of acceptance.
    const existing = await User.collection.findOne<{ tier?: string }>(
      { $or: [{ clerkId: userId }, { email }] },
      { projection: { tier: 1 } }
    );
    const plan = existing?.tier || "free";

    await User.collection.updateOne(
      { $or: [{ clerkId: userId }, { email }] },
      {
        $set: {
          email,
          clerkId: userId,
          name,
          privacyPolicyAccepted: true,
          privacyPolicyAcceptedAt: acceptedAt,
          privacyPolicyAcceptanceLog: {
            acceptedAt,
            policyUrl: body.policyUrl || PRIVACY_POLICY_URL,
            name,
            email,
            plan,
            userAgent,
            ip,
          },
        },
        $setOnInsert: { tier: "free" },
      },
      { upsert: true }
    );

    console.log("[Privacy Policy] User accepted privacy policy", {
      userId,
      name,
      email,
      plan,
      acceptedAt: acceptedAt.toISOString(),
    });

    return NextResponse.json({
      accepted: true,
      acceptedAt: acceptedAt.toISOString(),
      name,
      email,
      plan,
      policyUrl: body.policyUrl || PRIVACY_POLICY_URL,
    });
  } catch (err) {
    console.error("[Privacy Policy] Acceptance log failed:", err);
    return NextResponse.json({ error: "Failed to log privacy policy acceptance" }, { status: 500 });
  }
}
