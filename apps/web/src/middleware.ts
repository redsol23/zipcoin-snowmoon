// Security headers on every page and API response (lib/security-headers.ts). The CSP nonce is also put on the request,
// where Next picks it up and applies it to its own scripts while rendering.
import { NextResponse, type NextRequest } from "next/server";

import { makeNonce, securityHeaders } from "@/lib/security-headers";

export function middleware(req: NextRequest) {
  const nonce = makeNonce();
  const headers = securityHeaders({
    pathname: req.nextUrl.pathname,
    nonce,
    env: process.env,
    dev: process.env.NODE_ENV !== "production",
  });
  const request = new Headers(req.headers);
  request.set("x-nonce", nonce);
  request.set("Content-Security-Policy", headers["Content-Security-Policy"]);
  const res = NextResponse.next({ request: { headers: request } });
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export const config = {
  // Next's hashed static chunks and optimized images don't need a per-request policy
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
  runtime: "nodejs",
};
