import { NextResponse } from 'next/server';
import crypto from 'crypto';
import mongoose from 'mongoose';

// 1. Database Connection Helper
const connectDB = async () => {
  if (mongoose.connections[0].readyState) return;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI environment variable is not set');
  const uri = process.env.MONGODB_URI;
  // Warn if the URI uses the cluster name (e.g. "cluster0") as the database name.
  // The real database name should be something like "esamz", not the cluster name.
  const dbNameMatch = uri.match(/\.mongodb\.net\/([^?]+)/);
  if (dbNameMatch && /^cluster\d+/i.test(dbNameMatch[1])) {
    console.warn(
      '[DB] WARNING: MONGODB_URI appears to use the cluster name ("%s") as the database name. ' +
      'Update the URI to use your actual database name (e.g. "esamz"): ' +
      'mongodb+srv://<user>:<pass>@<host>/esamz?retryWrites=true&w=majority',
      dbNameMatch[1],
    );
  }
  await mongoose.connect(uri);
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
    const secretKey = process.env.CASHFREE_SECRET_KEY;
    if (!secretKey) {
      console.error('Webhook Error: CASHFREE_SECRET_KEY environment variable is not set');
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    const rawBody = await req.text();
    const signature = req.headers.get('x-webhook-signature');
    const timestamp = req.headers.get('x-webhook-timestamp');

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

    // Handle Successful Payment from Cashfree Forms
    if (payload.type === 'PAYMENT_FORM_ORDER_WEBHOOK' && payload.data?.order?.order_status === 'PAID') {
      const orderData = payload.data.order;
      const order_id = orderData.order_id;
      const order_amount = orderData.order_amount;
      const customerEmail = orderData.customer_details?.customer_email;
      if (!customerEmail) {
        console.error('Webhook Error: customer_email missing in payload');
        return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
      }

      await connectDB();

      // Determine Tier based on Amount Paid
      // Max = ₹499, Pro = ₹199, Plus = anything less
      let newTier = 'plus';
      if (order_amount >= 499) {
        newTier = 'max';
      } else if (order_amount >= 199) {
        newTier = 'pro';
      }

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
