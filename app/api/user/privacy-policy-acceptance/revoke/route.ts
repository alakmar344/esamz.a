import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import mongoose from "mongoose";

const connectDB = async () => {
  if (mongoose.connections[0].readyState) return;
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI environment variable is not set");
  await mongoose.connect(process.env.MONGODB_URI);
};

const User = mongoose.models.User || mongoose.model("User", new mongoose.Schema({
  email: String,
  clerkId: String,
  tier: { type: String, default: "free" },
  lastPaymentId: String,
  privacyPolicyAccepted: { type: Boolean, default: false },
  privacyPolicyAcceptedAt: Date,
  privacyPolicyAcceptanceLog: {
    acceptedAt: Date,
    policyUrl: String,
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
    await connectDB();

    const email = user.emailAddresses[0]?.emailAddress;

    const { deletedCount } = await User.collection.deleteOne(
      { $or: [{ clerkId: userId }, { email }] }
    );

    console.log("[Privacy Policy] User revoked privacy policy consent — user record hard-deleted", {
      userId,
      email,
      deletedCount,
    });

    return NextResponse.json({
      revoked: true,
      deleted: deletedCount > 0,
    });
  } catch (err) {
    console.error("[Privacy Policy] Revocation failed:", err);
    return NextResponse.json({ error: "Failed to revoke privacy policy consent" }, { status: 500 });
  }
}
