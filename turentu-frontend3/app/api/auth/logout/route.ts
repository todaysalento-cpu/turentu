import { NextResponse } from 'next/server';

export async function POST() {
  const response = NextResponse.json({ message: 'Logout effettuato' });
  response.cookies.set({
    name: 'token',
    value: '',
    path: '/',
    maxAge: 0, // scade subito
    httpOnly: true,
  });
  return response;
}
