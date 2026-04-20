import { NextRequest, NextResponse } from "next/server";

const ACCESS_CODE = process.env.ACCESS_CODE;

export function middleware(request: NextRequest) {
  // Skip if no access code configured
  if (!ACCESS_CODE) return NextResponse.next();

  // Skip for static assets and API health checks
  const path = request.nextUrl.pathname;
  if (path.startsWith("/_next") || path === "/favicon.ico") {
    return NextResponse.next();
  }

  // Check cookie first
  const cookie = request.cookies.get("opengov_access");
  if (cookie?.value === ACCESS_CODE) {
    return NextResponse.next();
  }

  // Check URL param
  const code = request.nextUrl.searchParams.get("code");
  if (code === ACCESS_CODE) {
    // Set cookie so they don't need the code on every page
    const response = NextResponse.redirect(
      new URL(path, request.url),
    );
    response.cookies.set("opengov_access", ACCESS_CODE, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return response;
  }

  // Block access
  return new NextResponse("Access denied. Append ?code=YOUR_CODE to the URL.", {
    status: 403,
    headers: { "Content-Type": "text/plain" },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
