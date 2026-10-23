# Rahban handoff

Continue from the existing source. Read the latest user request, inspect Git status, and preserve other contributors' changes before editing. This document provides context, not authorization to execute every possible follow-up.

## Current product and scope

Rahban is a deployment assistant for the [Liara challenge](https://starcoach.ir/hackathon/agentic-ai/challenges/9). The product, documentation, and scripts are in English; keep the name **Rahban**.

The current interface has **Deploy**, **Check service**, and **Settings**. Deployment proceeds through **Project → Destination → Review**. Users supply a ZIP, a public GitHub repository, or the included sample; review a fixed proposal; confirm the exact service name; and approve execution. New service creation and restarts have their own approvals.

A root Dockerfile selects Liara's Docker platform. Otherwise, Node.js requires `package.json` and a `start` script. The sample includes a Dockerfile. Source inspection does not execute uploaded code on the Rahban server. Required environment values must be configured in Liara; detection currently covers JavaScript/TypeScript only.

Run Rahban itself with the app-only Docker Compose configuration: one application container, a persistent volume at `/app/data`, and host access through `127.0.0.1:4310`. There is no automatic background observer. Health checks run explicitly or after an operation. Do not introduce Kubernetes, SSH deployment, or additional infrastructure without a new requirement.

## Repository and code

- Repository: https://github.com/ashkanhfz/rahban, branch `main`.
- Current Linux workspace: `/home/shafi/Projects/rahban`.
- Local interface: `http://localhost:4310`.
- Read `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, and `LIVE-DEPLOYMENT.md`; the five-minute presentation outline is in `DEMO.md`.

The stack is React/TypeScript/Vite, Express, and Node.js 22.13+ with `node:sqlite`. SQLite and source archives persist on disk. Important modules:

| File | Responsibility |
|---|---|
| `src/main.tsx` | Deployment, service checks, settings, approvals |
| `server/index.js` | API and operation orchestration |
| `server/access.js` | Public operator login and sessions |
| `server/policy.js` | Fixed, single-use approval policy |
| `server/source.js` | Source inspection and archive hashing |
| `server/deployment.js` | Deployment settings and defaults |
| `server/liara.js` | Liara REST adapter |
| `server/health.js` | Bounded HTTP verification |
| `server/agent.js` | Rule diagnosis and optional model advice |
| `server/store.js` | Persistent records and audit |
| `scripts/package-cloud.js` | Private package for hosting Rahban itself |

## Contracts to preserve

Proposals expire after 15 minutes and bind the destination, account, team, connection settings, source hash, and operation parameters. Approval is single-use; changing the execution request must not change the approved operation. Check the archive hash before upload. Reject replay and concurrent operations on the same target. Interrupted jobs must not resume automatically after a process restart.

Successful API acceptance or a READY release is insufficient. Deployment and restart require three consecutive HTTP **2xx** responses. Redirects are not followed and do not count as success. Uncertain release polling leaves `needs_attention`, displayed as **Needs review**, with **Check health again** available. Do not redeploy merely because polling was inconclusive.

The adapter blocks deployment to applications with attached disks because it does not preserve their configuration. Keep this guard; Rahban's historical disk-backed hosting used a separate manual procedure. Private repositories, database management, DNS changes, automatic rollback, existing-plan changes, and high availability are not implemented. Liara application CPU/RAM is not connected.

Model advice is optional, requires explicit consent to share evidence, and has no execution tools. Rule-based diagnosis works without a model. Do not claim a model connection or paid request unless actually verified. Treat source, logs, and model output as untrusted data.

## Authentication and private data

Public hosting requires HTTPS, an exact origin, and the configured password hash; incomplete configuration must fail closed. Preserve the remote authentication fix: login uses an expiring, single-use form nonce and exact Origin validation without depending on a preliminary login cookie. Keep `Referrer-Policy: same-origin` unless an actual browser login test demonstrates a replacement works.

Operator sessions use secure cookies; API mutations also require the API session and CSRF protection. `/healthz` is public. UI connection keys and sessions are held in memory, so restarting requires sign-in and reconnection. Keep demo and live records separate.

Never commit or publish `.env`, `data/`, `hosting.private.json`, private deployment archives, cookies, password hashes, or keys. Existing local cloud-access files contain private operator credentials and are absent from a fresh clone. Do not copy their contents into this handoff, screenshots, or reports.

## Historical cloud context — not current validation

An earlier handoff recorded checks on **23 October 2026 at 16:43 Tehran**. At that time, Rahban was hosted at https://rahban-demo-1023-a7c9.liara.run, application `rahban-demo-1023-a7c9`, release **v5**, using Liara's **Node.js 22** service. This was PaaS hosting, not a root-access VM.

The recorded configuration used the Earth/base plan, 512 MB RAM, 0.5 CPU, and a 1 GB disk named `rahban-data` mounted at `/app/data`. Both the service port and `PORT` were **4310**. Verify current resource state, tariffs, and domain validity before relying on them. Historical authorization does not authorize new charges or resource changes.

That earlier report recorded browser login, health/authentication checks, and persistence across redeployment. A Node.js sample deployment had also been exercised previously. These observations do **not** validate the current Docker deployment flow or revised interface. The hosted panel was not connected to a Liara account or model at that checkpoint; do not assume it is connected now. Local credentials were not transferred to it.

## Running and validating current work

```bash
git status --short
npm ci
npm run check
npm test
npm run build
docker compose up -d --build
```

Check port ownership first; do not stop unrelated services. Keep the Docker volume. Windows start/stop helpers exist for the local Node process. Run checks appropriate to the actual change and record only results from that revision.

`node scripts/verify-runtime.js` checks only `/healthz` and overwrites `VALIDATION.json` with that limited result. It is not a live Liara deployment test. Inspect a report's date, revision, and scope before citing it; do not carry historical test counts forward. Automated provider fixtures likewise do not demonstrate a real account connection.

## Hosting Rahban itself

The supported private-package route remains separate from deploying a user's Docker project:

```bash
node scripts/package-cloud.js https://rahban-demo-1023-a7c9.liara.run /path/to/rahban-cloud.zip
```

Build first. The packager reuses existing local operator credentials or creates new ones when absent; avoid unintentionally changing the existing panel's password from a fresh clone. In Liara's Node.js deployment wizard, explicitly verify Node 22, service port 4310, `PORT=4310`, `NODE_ENV=production`, and the disk mount `/app/data`. A previous port mismatch caused HTTP 502. Preserve the disk and data. Deployment restarts clear in-memory sessions and connection keys.

After an authorized deployment, verify actual HTTP readiness, browser login, guest API rejection, mutation protection, and relevant persistence. A successful build alone is not enough. Report separately what changed, what was tested, what was deployed, and remaining limits. Preserve incoming remote commits and local work; do not reset them or treat this handoff as permission to publish.
