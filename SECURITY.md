# Security policy

Report suspected vulnerabilities privately to `[SECURITY EMAIL]`. Do not include live Shopify tokens, API keys, customer data, or production database contents in a report.

## Security design

- Shopify access and refresh tokens use AES-256-GCM authenticated encryption at rest.
- Public-app offline tokens are expiring and automatically rotated.
- Browser sessions are signed, HTTP-only, same-site cookies and become secure-only in production.
- OAuth callbacks and webhooks use separate Shopify HMAC verification procedures.
- External API keys are displayed once and stored only as peppered SHA-256 hashes.
- External APIs are rate limited.
- Published Shopify themes cannot be deployment or rollback targets.
- Deployment snapshots support recovery without storing unrelated theme files.
- Production responses suppress internal stack traces.
- Content Security Policy, frame denial, MIME sniffing protection, request size limits, and restrictive permissions headers are enabled.

## Operational requirements

- Rotate application secrets immediately after suspected exposure.
- Use a managed secret store rather than plaintext host files.
- Restrict database network access to the application runtime.
- Enable encrypted daily backups and test restoration quarterly.
- Apply dependency and base-image security updates regularly.
- Review audit events after changes to deployment or API-key behavior.
