# Contributing

This is a hackathon prototype. Contributions and forks are welcome, but the
`main` branch is **protected** — direct pushes are blocked and every change
must arrive through a pull request that:

1. Passes the CI checks (CodeQL, lint, type-check).
2. Receives an approving review from a code owner (see `CODEOWNERS`).
3. Is up to date with `main` before merge.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in your own credentials
npm run dev                  # http://localhost:3000
```

## Tests

```bash
npx playwright test tests/audit/
```

## Reporting security issues

Please follow [SECURITY.md](SECURITY.md) — do not open public issues for
vulnerabilities.
