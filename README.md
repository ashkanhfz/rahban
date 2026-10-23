# Rahban

A deployment assistant for Liara. Rahban inspects a project, prepares a deployment proposal, asks for approval, and checks the release and HTTP response. It supports projects with a Dockerfile and Node.js projects without one.

The dark interface keeps the main workflow in **Deploy**, with **Check service** and **Settings** alongside it.

## Run with Docker

```bash
docker compose up -d --build
```

Open `http://localhost:4310`. Compose runs one application container, binds the host port to `127.0.0.1:4310`, and keeps application data in a named volume. The port must be free. Keep the volume when restarting or updating the application.

For local development, use Node.js 22.13 or later:

```bash
npm ci
npm run build
npm start
```

The server reads `.env` from the project root. It is optional for the local demo; use `.env.example` for connection settings. Local data is stored in `data/rahban.sqlite`.

On Windows, `scripts/start-local.ps1` builds and starts the application in the background. `scripts/stop-local.ps1` stops only the recorded process whose command matches this project. These scripts use the default port, 4310.

## First deployment

1. Open **Settings**, enter the **Liara API token**, and use **Team account** for an optional team ID. Select **Connect and continue**. Connecting lists applications without creating or deploying one.
2. In **Deploy → Project**, choose **Use sample project**, **Choose ZIP file**, or **Import from GitHub**. GitHub imports resolve the selected branch to a commit SHA before downloading the source. A root `Dockerfile` selects Docker; otherwise, Node.js requires `package.json` with a `start` script. The sample includes a Dockerfile. Uploaded code is not executed on the Rahban server.
3. Continue to **Destination** and select a matching service. Under **Create a new service**, use **Get recommended plan**, then **Review cost and create** if needed. Account funding remains the user's responsibility.
4. **Advanced settings** lets you change the detected port or 3000, health path `/`, five-second timeout, and enabled build cache. Empty fields use defaults. Set required environment variables in Liara; Rahban does not write their values automatically.
5. Select **Review deployment**, then **Approve deployment**. In the confirmation dialog, enter the exact service name, check the approval box, and choose **Approve and run**. Rahban uploads the inspected archive and creates a release.
6. Follow the release and HTTP checks. Success requires three consecutive 2xx responses. An uncertain release result shows **Needs review**; use **Check health again** before attempting another deployment. A successful deployment offers **Open website**.

Without a token, the local demo supports an HTTP failure, diagnosis, and recovery with approval. It does not demonstrate a live Liara deployment.

## Analysis and limits

Deployments require a reviewed proposal and user approval. Service health checks run on request or after an operation; there is no periodic observer. Local diagnosis uses logs and HTTP evidence. An optional model requires a Chat Completions-compatible endpoint, model ID, API key, and explicit consent to share evidence. It provides advice and cannot execute operations. Model requests use the provider account's credit.

Rahban keeps an instance identity in its data volume and creates a new boot ID on restart. The interface reports lost connectivity and return, and renews its local API session after a restart. Public hosting may still require operator login, and keys entered in the UI must be reconnected. Responses, jobs, and reports carry Rahban attribution. The `rahban:<instanceId>` signature identifies the application instance; it is not a cryptographic proof of identity.

Deployment to applications with attached disks, private repositories, database management, DNS changes, replica management, and automatic rollback are not supported. Environment-variable detection covers JavaScript/TypeScript source only. Liara application CPU/RAM data is not connected, and suggested capacity is not based on load testing.

To host the Rahban panel itself on Liara, build it and create a private package:

```bash
node scripts/package-cloud.js https://YOUR-APP.liara.run /path/to/rahban-cloud.zip
```

The generated password stays in `data/cloud-access.txt`; the package contains its hash. Deploy this package through Liara's Node.js service with a `rahban-data` disk mounted at `/app/data`. Set both the Liara service port and `PORT` environment variable to `4310`, using Node.js 22. Re-enter Liara and model keys in the hosted panel. See [SECURITY.md](SECURITY.md).

## Checks and documentation

```bash
npm run check
npm test
npm run build
node scripts/verify-runtime.js
```

The last command checks only the running application's `/healthz` endpoint and overwrites `VALIDATION.json` with that result. It does not test Liara deployment or make a paid model request. Automated tests use temporary data and simulated provider responses. Record results for the current revision after running the checks.

[Architecture and API](ARCHITECTURE.md) · [Security](SECURITY.md) · [Demo](DEMO.md) · [Live deployment procedure](LIVE-DEPLOYMENT.md)
