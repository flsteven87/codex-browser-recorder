## Summary

Describe the focused change and the approved issue or use case.

## Privacy and security

- [ ] The change preserves explicit consent, one approved origin, and local-only output.
- [ ] Fixtures and evidence contain no recordings, raw frames, full URLs, credentials, tokens, Browser/CDP diagnostics, or personal data.
- [ ] Authenticated and sensitive recording flows remain unsupported.

## Verification

- [ ] For behavior changes, I observed the new or changed test fail for the expected reason before implementation.
- [ ] `npm run check`
- [ ] `npm run check:release-candidate`
- [ ] Relevant validators and focused integration tests
- [ ] `git diff --check`

For documentation-only changes, link the stale source or describe the verified
mismatch instead of manufacturing a failing code test. List the RED and GREEN
commands when applicable, plus every check not run.
