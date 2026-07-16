# Security Policy

## Supported versions

This repository contains pre-release software. Security fixes are prepared on
the latest commit on `main`; there is no supported public release yet.

## Reporting a vulnerability

Do not disclose vulnerabilities or sensitive recording contents in a public
issue. Use GitHub's private vulnerability reporting at:

<https://github.com/flsteven87/codex-browser-recorder/security/advisories/new>

Include a minimal reproduction, affected commit, impact, and any suggested
mitigation. Remove tokens, credentials, private URLs, raw frames, and personal
data before submitting the report.

## Security boundary

The recorder must not bypass Codex Browser approvals, workspace policy, site
permissions, authentication, CAPTCHA, MFA, or operating-system protections. It
must not inspect browser profile data or upload recordings without a separate,
explicit user request and approval.
