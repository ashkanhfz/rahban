# Demo recording — 4 minutes 30 seconds

Record the running product and its actual results. Produce two silent MP4 files with identical timing: a clean recording and a copy with Persian subtitles. Keep the timestamped narration text separately so the presenter can read it while adding their own voice. The product interface stays in English.

## Recording sequence

| Time | Product view | Explain |
|---|---|---|
| 00:00–00:18 | Deployments home | Rahban helps a developer inspect, deploy, and maintain a website on Liara. |
| 00:18–00:35 | Settings | Masked API token, optional Team ID, connection status. Never reveal credentials. |
| 00:35–00:59 | New deployment → GitHub | Import the official Node.js example, inspect its pinned commit, start command, and port. ZIP and Dockerfile projects are also supported. |
| 00:59–01:22 | Destination | Review CPU, RAM, bundle features, estimated cost, and an existing private network. Create a dedicated demo app only after approval. A starter plan is a heuristic, not a load-test result. |
| 01:22–01:40 | Runtime settings | Port, health path, timeout, and build cache have defaults. Show Refresh retaining the deployment draft and browser Back retaining navigation. |
| 01:40–02:02 | Review and approval | Show the exact destination and source, exact-name confirmation, consent, and operation progress. Explain Human-in-the-Loop. |
| 02:02–02:23 | Deployment result and website | Show the actual release reaching READY, three consecutive HTTP successes, and the deployed website. Do not replace a failed live run with simulated success. |
| 02:23–02:41 | A recorded failed operation | Explain the actual error and next step. Show Edit and retry restoring editable settings without running another write. |
| 02:41–03:00 | GitHub updates | Explain interval-based polling, review mode, separately authorized automatic mode, and pause conditions. These controls do not prove a new commit was deployed during the recording. |
| 03:00–03:20 | Check service | Show HTTP evidence, logs, available CPU/RAM data or explicit API limitations, and scheduled read-only checks. |
| 03:20–03:37 | Custom domain and management | Show DNS/SSL guidance, environment variable names, and start/stop/restart/delete controls. Opening these controls is not evidence that each operation ran. |
| 03:37–03:58 | Practice mode → Test a failure → Investigate | Label this local sandbox explicitly. Trigger HTTP 503 and show evidence-based hypotheses from the log and HTTP response. |
| 03:58–04:16 | Review recovery → Approve and run | Restore the local configuration after approval, verify three health responses, and show the downloadable incident report. |
| 04:16–04:30 | Resolved result or Deployments home | Briefly explain React, Node.js, SQLite, Liara API integration, and the unsupported automatic rollback/plan-change operations. |

Actual cloud builds may take longer than their video segment. Record the real operation, then cut its idle waiting time while preserving the order and outcome. Keep both video versions synchronized. If the live run fails, show that result and its investigation; revise the narration rather than claiming success.

## Before recording

- Use a dedicated demo app and a public repository. Leave unrelated account resources unchanged.
- Confirm that project inspection, plan/network reads, release progress, and the website work with the connected account. Test the practice failure and recovery separately.
- Keep API keys, environment values, unrelated applications, browser account details, and filesystem paths outside the recording.
- Confirm that the captioned copy has readable Persian shaping, punctuation, and mixed English technical terms; check for cropping and timing errors.
- Record the current revision and validation results separately. Automated provider fixtures are not evidence of a live cloud deployment.

The narration should distinguish local deterministic diagnosis from optional LLM advice. Only describe a model response if a model was configured, evidence sharing was approved, and that request actually succeeded. Model configuration alone is not a demonstration of model reasoning.

## Limits to state accurately

DNS and registrar edits remain manual. Resource-summary units may be undocumented, so raw values are not treated as CPU/RAM saturation. GitHub updates use polling rather than a webhook and require a verified public GitHub deployment first. Scheduled checks need Rahban running and connected; they do not automatically repair services. Existing-plan changes, arbitrary replica counts, and automatic rollback are unsupported. A successful health route does not prove every application feature works.

The required submission is a public demo-video link and the runnable GitHub repository with architecture, API connection, interaction, and limitations documented. Review the chosen video before submitting: the challenge form permits only one submission. The clean copy is for recording the presenter's voice; the captioned copy makes the same walkthrough readable without audio.
