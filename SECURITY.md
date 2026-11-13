# Security policy

## Supported versions

Security fixes are made on `main` and released from there. Use the latest commit or the live site.

## Reporting a vulnerability

Please use GitHub's **Security → Report a vulnerability** form on this repository. If private reporting is unavailable, open an issue that only asks for a private channel. Do not include exploit details, personal data or real files in public issues.

Please give the maintainer a reasonable window to investigate and ship a fix before public disclosure. This community project does not offer a guaranteed response time.

## Processing boundary

Hidden Ink runs in your browser. Files you open are read into memory on your device and are not uploaded: the production site ships a Content-Security-Policy with `connect-src 'self'`, and there is no server endpoint that accepts user data. Imported content is rendered as text, never as HTML. Exported reports can contain parts of your input, so handle them as carefully as the original files.

## Scope

In scope: script injection through imported files, data leaving the browser, unsafe parsing that can freeze or crash the page, and supply-chain problems in the build. Out of scope: findings that require a compromised device or browser extension.

A clean verdict or clean-copy export is not a security certification. Detector false negatives and prompt text visible to people remain possible; investigate parser or execution vulnerabilities separately from heuristic coverage gaps.
