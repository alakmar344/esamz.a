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

    // ─── 1. Delete user from MongoDB ────────────────────────────────────
    const { deletedCount } = await User.collection.deleteOne(
      { $or: [{ clerkId: userId }, { email }] }
    );

    console.log("[Account Deletion] User record hard-deleted from MongoDB", {
      userId,
      email,
      deletedCount,
    });

    // ─── 2. Delete all MongoDB logs for this user ────────────────────────
    // Remove any conversation logs, chat history, or other collections
    // that may be associated with this user's clerkId or email.
    const db = mongoose.connection.db;
    const collectionsToClean = ["logs", "conversations", "sessions", "chatlogs"];

    for (const colName of collectionsToClean) {
      try {
        const collection = db.collection(colName);
        const exists = await db.listCollections({ name: colName }).toArray();
        if (exists.length > 0) {
          const logResult = await collection.deleteMany({
            $or: [{ clerkId: userId }, { userId }, { email }]
          });
          if (logResult.deletedCount > 0) {
            console.log(`[Account Deletion] Deleted ${logResult.deletedCount} documents from "${colName}"`, { userId, email });
          }
        }
      } catch (colErr) {
        console.warn(`[Account Deletion] Could not clean collection "${colName}":`, colErr);
      }
    }

    // ─── 3. Delete user from Clerk via Backend API ───────────────────────
    let clerkDeleted = false;
    if (process.env.CLERK_SECRET_KEY) {
      try {
        const clerkRes = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${process.env.CLERK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
        });

        if (clerkRes.ok) {
          clerkDeleted = true;
          console.log("[Account Deletion] User deleted from Clerk", { userId });
        } else {
          const errBody = await clerkRes.text();
          console.error("[Account Deletion] Clerk deletion failed:", {
            status: clerkRes.status,
            body: errBody,
          });
        }
      } catch (clerkErr) {
        console.error("[Account Deletion] Clerk API call failed:", clerkErr);
      }
    } else {
      console.error("[Account Deletion] CLERK_SECRET_KEY not set — cannot delete user from Clerk");
    }

    return NextResponse.json({
      revoked: true,
      deleted: deletedCount > 0,
      clerkDeleted,
      logsCleared: true,
    });
  } catch (err) {
    console.error("[Account Deletion] Failed:", err);
    return NextResponse.json({ error: "Failed to delete account" }, { status: 500 });
  }
}
