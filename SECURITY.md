# Security Policy

## Supported Versions

This project is in early development. Security fixes are applied to `main`.

## Reporting a Vulnerability

Please do **not** open public issues for security vulnerabilities.

Report privately via GitHub Security Advisories:
- Go to **Security** tab in this repository
- Click **Report a vulnerability**

Include:
- A clear description of the issue
- Reproduction steps / proof of concept
- Potential impact

We will acknowledge reports as soon as possible and coordinate a fix + disclosure timeline.

## Security-by-default Rules for Contributors

- Never commit secrets (`.env`, tokens, API keys, credentials)
- Never hardcode machine-specific paths
- Use environment variables and documented defaults
- Prefer least-privilege for all integrations
