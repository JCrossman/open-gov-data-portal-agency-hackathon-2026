import { NextRequest, NextResponse } from "next/server";

const ACCESS_CODE = process.env.ACCESS_CODE;

export function middleware(request: NextRequest) {
  if (!ACCESS_CODE) return NextResponse.next();

  const path = request.nextUrl.pathname;
  if (path.startsWith("/_next") || path === "/favicon.ico") {
    return NextResponse.next();
  }

  // Access-entry page is always reachable so unauth'd users can log in.
  if (path === "/access") {
    return NextResponse.next();
  }

  // Already authenticated via cookie.
  const cookie = request.cookies.get("opengov_access");
  if (cookie?.value === ACCESS_CODE) {
    return NextResponse.next();
  }

  // Code supplied as query param (e.g. shared URL).
  const code = request.nextUrl.searchParams.get("code");
  if (code !== null) {
    if (code === ACCESS_CODE) {
      const cleanUrl = new URL(path, request.url);
      request.nextUrl.searchParams.forEach((value, key) => {
        if (key !== "code") cleanUrl.searchParams.set(key, value);
      });
      const response = NextResponse.redirect(cleanUrl);
      response.cookies.set("opengov_access", ACCESS_CODE, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 30,
      });
      return response;
    }
    // Wrong code supplied — bounce to the entry page with an error flag.
    const loginUrl = new URL("/access", request.url);
    loginUrl.searchParams.set("from", path + request.nextUrl.search);
    loginUrl.searchParams.set("error", "invalid");
    return NextResponse.redirect(loginUrl);
  }

  // No code at all — show the entry page instead of a bare 403.
  const loginUrl = new URL("/access", request.url);
  if (path !== "/") {
    loginUrl.searchParams.set("from", path + request.nextUrl.search);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
