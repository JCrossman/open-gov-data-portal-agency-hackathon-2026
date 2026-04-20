import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Enter access code · Open Data Accountability Platform",
};

function sanitizeReturnPath(raw: string | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.startsWith("/access")) return "/";
  return raw;
}

async function login(formData: FormData) {
  "use server";

  const submittedCode = (formData.get("code") ?? "").toString().trim();
  const rawFrom = (formData.get("from") ?? "").toString();
  const from = sanitizeReturnPath(rawFrom);
  const expected = process.env.ACCESS_CODE;

  if (!expected || submittedCode !== expected) {
    const params = new URLSearchParams({ error: "invalid" });
    if (rawFrom) params.set("from", rawFrom);
    redirect(`/access?${params.toString()}`);
  }

  const jar = await cookies();
  jar.set("opengov_access", expected, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });

  redirect(from);
}

export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const params = await searchParams;
  const from = params.from ?? "";
  const hasError = params.error === "invalid";

  return (
    <div
      style={{
        minHeight: "calc(100vh - 12rem)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem 1rem",
      }}
    >
      <section
        aria-labelledby="access-heading"
        style={{
          width: "100%",
          maxWidth: "26rem",
          background: "var(--gc-surface, #fff)",
          border: "1px solid var(--gc-border, #d1d5db)",
          borderRadius: "0.75rem",
          padding: "2rem",
          boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
        }}
      >
        <h1
          id="access-heading"
          style={{
            fontSize: "1.5rem",
            fontWeight: 700,
            marginBottom: "0.5rem",
            color: "var(--gc-text-primary, #0f172a)",
          }}
        >
          Enter access code
        </h1>
        <p
          style={{
            color: "var(--gc-text-secondary, #475569)",
            fontSize: "0.9375rem",
            lineHeight: 1.5,
            marginBottom: "1.25rem",
          }}
        >
          This is a private hackathon demo. Please enter the access code shared
          with you to continue.
        </p>

        {hasError ? (
          <div
            role="alert"
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              padding: "0.625rem 0.875rem",
              borderRadius: "0.5rem",
              fontSize: "0.875rem",
              marginBottom: "1rem",
            }}
          >
            That code isn&apos;t recognised. Please check the code and try again.
          </div>
        ) : null}

        <form action={login} noValidate>
          <input type="hidden" name="from" value={from} />

          <label
            htmlFor="access-code"
            style={{
              display: "block",
              fontSize: "0.875rem",
              fontWeight: 600,
              marginBottom: "0.375rem",
              color: "var(--gc-text-primary, #0f172a)",
            }}
          >
            Access code
          </label>
          <input
            id="access-code"
            name="code"
            type="text"
            autoComplete="one-time-code"
            autoFocus
            required
            aria-required="true"
            aria-invalid={hasError || undefined}
            aria-describedby={hasError ? "access-code-error" : undefined}
            spellCheck={false}
            autoCapitalize="characters"
            style={{
              width: "100%",
              padding: "0.625rem 0.75rem",
              fontSize: "1rem",
              border: `1px solid ${hasError ? "#dc2626" : "var(--gc-border, #d1d5db)"}`,
              borderRadius: "0.5rem",
              outlineOffset: "2px",
              minHeight: "2.75rem",
              boxSizing: "border-box",
            }}
          />
          {hasError ? (
            <span
              id="access-code-error"
              style={{
                display: "block",
                marginTop: "0.375rem",
                fontSize: "0.8125rem",
                color: "#991b1b",
              }}
            >
              Incorrect access code.
            </span>
          ) : null}

          <button
            type="submit"
            style={{
              marginTop: "1.25rem",
              width: "100%",
              padding: "0.75rem 1rem",
              minHeight: "2.75rem",
              fontSize: "1rem",
              fontWeight: 600,
              color: "white",
              background: "var(--gc-primary, #0b3d68)",
              border: "1px solid var(--gc-primary, #0b3d68)",
              borderRadius: "0.5rem",
              cursor: "pointer",
            }}
          >
            Continue
          </button>
        </form>

        <p
          style={{
            marginTop: "1.25rem",
            fontSize: "0.8125rem",
            color: "var(--gc-text-secondary, #475569)",
            lineHeight: 1.5,
          }}
        >
          Don&apos;t have a code? Contact the project owner for access.
        </p>
      </section>
    </div>
  );
}
