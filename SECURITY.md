# Security and access

- Access is local by default. Public hosting requires an exact HTTPS `PUBLIC_ORIGIN` and an operator password hash. Login uses scrypt, attempt limits, and an eight-hour session with Secure, HttpOnly, and SameSite cookies.
- The API validates Host and Origin. Mutations require a session and CSRF token. Sensitive operations also require single-use approval of the exact target name.
- Keys entered in the UI stay in server memory. `.env`, `data/`, and `hosting.private.json` are excluded from Git and the Docker build context. Private deployment packages contain a password hash. Do not publish `data/cloud-access.*`.
- The Liara API destination is fixed, and credentialed requests do not follow redirects. Reports redact known secret patterns; this does not guarantee removal of every sensitive value.
- User archives are neither executed nor extracted to disk. Suspicious paths, symlinks, and oversized input are rejected. Review source files for secrets before publication.
- The model has no execution tools. Evidence sharing requires explicit consent. The model key and infrastructure token serve separate purposes.
- HTTP checks target the local sandbox or a derived `liara.run` hostname. Redirects are not followed. `/healthz` exposes only basic application health.
- Audit entries form a hash chain. Someone able to rewrite the whole database could also rewrite that chain. Restrict access to the data file and backups.

This is a single-operator MVP. Multi-user secret management, SSO, organizational RBAC, and independent backups are not implemented. Inspect the destination after an interrupted operation; Rahban does not blindly repeat cloud mutations.
