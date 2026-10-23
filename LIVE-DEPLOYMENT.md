# Verify a live Liara deployment

A live deployment was verified on 23 October 2026 using the recording instance at `http://localhost:4330`:

- App: `rahban-video-node-1023`, created specifically for the demo.
- Source: the public `liara-cloud/nodejs-getting-started` repository, deployed as Node.js on port 3005.
- Deployment job: `e6e80835-ced9-4ae2-a3a3-e190569ebdac`.
- Result: Liara reported the release as READY, and Rahban confirmed three consecutive successful HTTP health responses.
- Website: [rahban-video-node-1023.liara.run](https://rahban-video-node-1023.liara.run).

This is actual cloud-operation evidence. The separate Practice mode failure/recovery sequence uses a local sandbox. The recording previews management and automatic-update controls without claiming that a destructive operation or a new-commit-triggered automatic deployment ran. The main Docker instance at `http://localhost:4310` was also rebuilt and restarted with these changes. Its health endpoint passed, the Liara connection was restored, and all three account services were synchronized. The restart retained the instance identity and generated a new boot ID, with recovery detected.

## Reproduce the workflow

1. Open **Settings**, enter a valid **Liara API token**, and select **Connect and continue**. Keep the key out of reports, screenshots, and the repository.
2. Select **New deployment → ZIP file → Use sample project** and continue to **Destination**. Review port 3000, health path `/`, and build settings under **Runtime settings**. Alternatively, import `https://github.com/liara-cloud/nodejs-getting-started` from GitHub, leaving the branch blank to use its default branch, for a Node.js app on port 3005.
3. Choose **Existing app**, or use **New app** with a unique name. An empty account starts with New app selected and a recommended plan loaded. Review the total estimate before approving creation. The created app becomes the selected destination. Creating a service may incur charges; the user funds the account.
4. Select **Review deployment**, then **Approve deployment**. Confirm the exact service name, check the approval box, and select **Approve and run**.
5. Follow the upload, release progress, READY state, and three consecutive HTTP 2xx responses on the deployment detail screen. Use **Open website** after success; API acceptance alone does not establish website health. Return to **Deployments** to see separate past runs.
6. Record the time, project type, job result, and HTTP evidence from that run. If the job shows **Needs review**, inspect the release and logs and use **Verify outcome** before deploying again.

A Node.js project without a Dockerfile requires a Node.js destination. Deployment to applications with attached disks is blocked. Configure required environment variables before deployment through **Check service → Environment variables** with separate approval, or in the Liara console.

`node scripts/verify-runtime.js` checks only Rahban's own health. Its result is not evidence of a Liara deployment or model connection. The demo video should show the actual deployment outcome and relevant limitations.
