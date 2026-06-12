export const runtime = 'edge';
import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const PRIVACY_POLICY_URL = "https://esamz.info/privacypolicy";

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

    const acceptedAt = body.localAcceptedAt ? new Date(body.localAcceptedAt) : new Date();

    return NextResponse.json({
      accepted: true,
      acceptedAt: acceptedAt.toISOString(),
      policyUrl: body.policyUrl || PRIVACY_POLICY_URL,
    });
  } catch (err) {
    return NextResponse.json({ error: "Failed to log privacy policy acceptance" }, { status: 500 });
  }
}
