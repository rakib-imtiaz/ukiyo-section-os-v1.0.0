# Launch decisions required from the owner

The software is configured so these decisions can be made without rewriting the application.

## 1. Product identity

- Confirm the public name: **Ukiyo Section OS**, **Section OS**, or another final name.
- Confirm the legal company name displayed in policies and billing.
- Select the production domain.
- Select the public support and privacy email addresses.

## 2. Distribution

- Choose a public searchable Shopify App Store listing or a limited-visibility public listing installed through a direct link.
- Create the public app in Shopify's Dev Dashboard before installing it on unrelated merchant stores.
- Submit the protected theme-file exemption as a page-builder/developer-tooling product.

## 3. Pricing

Billing remains disabled until the following are approved:

- Monthly plan price.
- Trial duration.
- Whether one plan is sufficient for launch.
- Limits, if any, on stores, projects, versions, exports, or deployments.

A simple launch recommendation is one plan with unlimited section compiling and a clear fair-use policy. Do not introduce usage billing until real customer behavior shows that it is necessary.

## 4. Infrastructure

- Choose the container host.
- Choose managed PostgreSQL.
- Set backup retention.
- Choose uptime and error monitoring.
- Generate production encryption, session, and API-key secrets.

## 5. Legal and support

- Have counsel approve the privacy and terms templates.
- Add every infrastructure provider to the privacy policy.
- Define the support response window.
- Define the data backup and deletion windows.

## 6. Shopify review evidence

Prepare a short review video that demonstrates:

1. Connecting a development store.
2. Creating a section in the visual builder.
3. Editing its JSON design contract.
4. Compiling native Shopify files.
5. Saving a project and creating another version.
6. Selecting an unpublished duplicate theme.
7. Installing the section.
8. Editing its controls inside Shopify's theme editor.
9. Rolling the deployment back.
10. Creating and revoking an external AI-platform key.

## Recommended launch order

1. Internal agency deployment across controlled client stores.
2. Five to ten private beta merchants.
3. Fix onboarding and compiler edge cases from beta usage.
4. Enable billing.
5. Submit a limited-visibility public app.
6. Make the listing searchable only after support and onboarding are proven.
