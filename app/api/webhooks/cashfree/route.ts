import { NextResponse } from 'next/server';
import crypto from 'crypto';
import mongoose from 'mongoose';

// 1. Database Connection Helper (Optimized for Serverless)
const connectDB = async () => {
  if (mongoose.connections[0].readyState) return;
  try {
    await mongoose.connect(process.env.MONGODB_URI!);
    console.log('📦 Connected to MongoDB');
  } catch (error) {
    console.error('MongoDB Connection Error:', error);
  }
};

// 2. User Schema
const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
  email: String,
  clerkId: String,
  tier: { type: String, default: 'free' },
  lastPaymentId: String, 
}));

export async function POST(req: Request) {
  try {
    const secretKey = process.env.CASHFREE_SECRET_KEY;
    if (!secretKey) {
      console.error('Webhook Error: CASHFREE_SECRET_KEY is missing.');
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    // Extract Headers
    const signature = req.headers.get('x-webhook-signature');
    const timestamp = req.headers.get('x-webhook-timestamp');
    const idempotencyKey = req.headers.get('x-idempotency-header');

    if (!signature || !timestamp) {
      return NextResponse.json({ error: 'Missing Required Headers' }, { status: 400 });
    }

    const rawBody = await req.text();

    // 3. SECURE Signature Verification (Prevents Timing Attacks)
    const signatureString = timestamp + rawBody;
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(signatureString)
      .digest('base64');

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      console.error('🚨 Webhook Error: Signature mismatch. Potential tampering.');
      return NextResponse.json({ error: 'Invalid Signature' }, { status: 401 });
    }

    // 4. Parse Payload Safely
    const payload = JSON.parse(rawBody);
    const successTypes = ['PAYMENT_FORM_ORDER_WEBHOOK', 'PAYMENT_SUCCESS_WEBHOOK', 'ORDER_PAID'];

    // 5. Handle Successful Payment
    if (successTypes.includes(payload.type) && payload.data?.order?.order_status === 'PAID') {
      const orderData = payload.data.order;
      const orderId = orderData.order_id;
      const amount = Number(orderData.order_amount); // Safely convert to number
      const customerEmail = orderData.customer_details?.customer_email;

      if (!customerEmail) {
        console.error(`Webhook Error: Email missing for order ${orderId}`);
        return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
      }

      await connectDB();

      // 6. IDEMPOTENCY CHECK: Prevent double-upgrades if Cashfree retries the webhook
      const existingUser = await User.findOne({ email: customerEmail });
      if (existingUser && existingUser.lastPaymentId === orderId) {
        console.log(`⚡ Order ${orderId} was already processed. Skipping.`);
        return NextResponse.json({ status: 'Already Processed' }, { status: 200 });
      }

      // 7. Determine Tier
      let newTier = 'plus';
      if (amount >= 499) newTier = 'max';
      else if (amount >= 199) newTier = 'pro';

      // 8. Update User
      await User.findOneAndUpdate(
        { email: customerEmail },
        { 
          tier: newTier, 
          lastPaymentId: orderId 
        },
        { upsert: true, new: true }
      );

      console.log(`🚀 SUCCESS: User ${customerEmail} upgraded to ${newTier.toUpperCase()}!`);
    }

    // Always return 200 OK so Cashfree knows we received it
    return NextResponse.json({ status: 'OK' }, { status: 200 });

  } catch (err) {
    console.error("Webhook Processing Error:", err);
    // Return 500 so Cashfree will retry if our server genuinely crashed
    return NextResponse.json({ error: 'Processing Failed' }, { status: 500 });
  }
}
