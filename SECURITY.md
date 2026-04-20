# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please **do not open
a public issue**. Instead, report it privately so it can be addressed before
disclosure.

- Use **GitHub's private vulnerability reporting**:
  https://github.com/JCrossman/open-gov-data-portal-agency-hackathon-2026/security/advisories/new
- Include reproduction steps, affected files, and the impact you observed.
- You can expect an initial acknowledgement within 5 business days.

## Scope

This project is a hackathon prototype that queries publicly-available federal
open data. It is **not** a production system. In-scope reports include:

- Credential/secret leakage in the repository
- Authentication or authorization bypass on the access-gated web app
- SQL injection or LLM prompt-injection paths that exfiltrate data
- Dependencies with known critical vulnerabilities (also tracked via Dependabot)

Out of scope:
- DoS against the demo deployment
- Findings that depend on already-disclosed credentials
- Data accuracy concerns about the underlying open data (open issues for those)

## Supported Versions

Only the `main` branch is supported. There are no released versions.
