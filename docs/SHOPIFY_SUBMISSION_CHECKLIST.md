# Shopify submission checklist

## Dev Dashboard

- Public distribution selected before submission.
- App URL and OAuth callback use the final HTTPS domain.
- App icon, name, support email, and limited-visibility or public listing completed.
- `read_themes` and `write_themes` are the only requested store scopes.
- Protected theme-file exemption approved.
- Mandatory compliance webhooks configured.
- App uninstall webhook configured.

## Product behavior

- Published-theme writes are blocked.
- Every deployment shows its exact target theme.
- Generated sections contain a preset and can be removed through the theme editor.
- Projects and versions remain accessible after browser refresh.
- API keys are displayed once, hashed at rest, independently revocable, and rate limited.
- Store access tokens and refresh tokens are encrypted at rest.
- Expiring offline tokens rotate automatically before Admin API requests.
- Failed deployments are recorded without being represented as successful.
- Rollback is blocked if the target theme becomes the published theme.

## Privacy and security

- Privacy policy and terms are hosted at public URLs.
- Data request, customer redact, and shop redact webhooks return promptly.
- `shop/redact` removes the shop and its cascading project data.
- PostgreSQL backups and retention policy are documented.
- Secrets exist only in the host's encrypted environment.
- Production errors do not expose stack traces or credentials.
- HTTPS, CSP, secure cookies, HMAC verification, request size limits, and rate limits are enabled.

## Billing

- Final plan name, monthly price, currency, and trial length approved internally.
- Test charges verified on a Shopify development store.
- Paid features are not blocked when billing is intentionally disabled for agency/internal deployment.

## Review materials

- Reviewer test store and exact login steps prepared.
- Screen recording shows connect → create → compile → duplicate-theme deploy → theme editor controls → rollback.
- Protected-theme-access explanation matches the app's actual page-builder behavior.
- Support documentation covers CLI export while theme-write access is pending.
