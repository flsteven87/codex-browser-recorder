## Summary

Describe the problem, the focused change, and the related issue when one exists.

## Privacy and security

- [ ] Fixtures and evidence contain no recordings, raw frames, private URLs, credentials, tokens, Browser/CDP diagnostics, or personal data.
- [ ] If this changes recording behavior, it preserves explicit consent, the non-blocking Content Warning, one approved site, and local-only output.

## Verification

- [ ] `npm run check` (or explain why it does not apply)
- [ ] Relevant focused tests or validators
- [ ] `npm run check:release-candidate` when public docs, metadata, packaging, or release behavior changed
- [ ] `git diff --check`

For behavior changes, list the failing test observed before implementation when
applicable. For documentation-only changes, describe the verified mismatch
instead. List anything you did not run.
