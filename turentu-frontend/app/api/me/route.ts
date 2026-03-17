import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'segreto-di-test');

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get('token')?.value;
    if (!token) return NextResponse.json({ role: null });

    const { payload } = await jwtVerify(token, JWT_SECRET);
    return NextResponse.json({ role: (payload as any).role || null });
  } catch (err) {
    return NextResponse.json({ role: null });
  }
}
