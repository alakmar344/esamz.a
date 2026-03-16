import { NextResponse } from 'next/server';
import crypto from 'crypto';
import mongoose from 'mongoose';

// 1. Database Connection Helper
const connectDB = async () => {
  if (mongoose.connections[0].readyState) return;
  await mongoose.connect(process.env.MONGODB_URI!);
};

// 2. Simple User Schema (Add to your models folder later)
const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
  email: String,
  clerkId: String,
  tier: { type: String, default: 'free' },
  lastPaymentId: String,
}));

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-webhook-signature');
    const timestamp = req.headers.get('x-webhook-timestamp');
    const secretKey = process.env.CASHFREE_SECRET_KEY!;

    // Verify the signature to ensure this actually came from Cashfree
    const signatureString = timestamp + rawBody;
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(signatureString)
      .digest('base64');

    if (signature !== expectedSignature) {
      return NextResponse.json({ error: 'Invalid Signature' }, { status: 401 });
    }

    const payload = JSON.parse(rawBody);

    // Handle Successful Payment
    if (payload.event === 'ORDER_PAID') {
      const { order_id, customer_details } = payload.data;
      const customerEmail = customer_details.customer_email;

      await connectDB();

      // Determine Tier from Order ID (e.g., "PRO_123" or "MAX_456")
      let newTier = 'plus';
      if (order_id.includes('PRO')) newTier = 'pro';
      if (order_id.includes('MAX')) newTier = 'max';

      await User.findOneAndUpdate(
        { email: customerEmail },
        { 
          tier: newTier, 
          lastPaymentId: order_id 
        },
        { upsert: true }
      );

      console.log(`🚀 User ${customerEmail} upgraded to ${newTier}`);
    }

    return NextResponse.json({ status: 'OK' }, { status: 200 });
  } catch (err) {
    console.error("Webhook Error:", err);
    return NextResponse.json({ error: 'Processing Failed' }, { status: 500 });
  }
}
