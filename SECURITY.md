# Security Policy

## Reporting a vulnerability

Please do not disclose bot credentials, Web tokens, user IDs, or a suspected
vulnerability in a public issue.

Use GitHub's private vulnerability reporting for this repository when
available. Include the affected version, reproduction steps, impact, and any
safe mitigation.

## Deployment guidance

- Keep `web.host` bound to `127.0.0.1` unless remote access is intentional.
- Set a long, randomly generated `web.token` before exposing the Web console.
- Do not commit `config.json`, `config.local.json`, plugin configs, or `.env`
  files containing credentials.
