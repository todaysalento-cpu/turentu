import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'segreto-di-test');

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Percorsi pubblici: home, login, register, api
  const publicPaths = ['/', '/login', '/register', '/api'];
  if (publicPaths.some(path => pathname.startsWith(path))) return NextResponse.next();

  const token = req.cookies.get('token')?.value;

  if (!token) {
    // Se il percorso non è pubblico, redirect a login
    return NextResponse.redirect(new URL('/login', req.url));
  }

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);

    // Se l'utente prova ad andare sulla root, puoi decidere se redirect automatico in base al ruolo
    // oppure lasciarla pubblica
    // return NextResponse.next();

    return NextResponse.next();
  } catch (err) {
    console.error('❌ Middleware JWT error:', err);
    return NextResponse.redirect(new URL('/login', req.url));
  }
}

export const config = {
  matcher: ['/autista/:path*', '/cliente/:path*', '/admin/:path*'], // NON include la root
};
