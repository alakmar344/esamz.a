import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import mongoose from "mongoose";

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

export async function GET() {
  const { userId } = await auth();
  const user = await currentUser();

  if (!userId || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await connectDB();
    const email = user.emailAddresses[0]?.emailAddress;
    const dbUser = await User.findOne({ email }).lean() as { tier?: string } | null;
    const rawTier = dbUser?.tier || 'free';
    // Capitalize: 'plus' -> 'Plus', 'pro' -> 'Pro', 'max' -> 'Max', 'free' -> 'Free'
    const tier = rawTier.charAt(0).toUpperCase() + rawTier.slice(1);
    return NextResponse.json({ tier });
  } catch (err) {
    console.error('[User Tier] MongoDB error:', err);
    return NextResponse.json({ tier: 'Free' });
  }
}
