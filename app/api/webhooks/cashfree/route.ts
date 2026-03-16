import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    // This tells Cashfree: "I received the data!"
    return NextResponse.json({ status: 'OK' }, { status: 200 });
  } catch (err) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
