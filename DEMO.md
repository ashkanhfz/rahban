# Five-minute demo

Use the sample project with its Dockerfile, or a public GitHub repository you control, and an account you are authorized to use. Show only operations and results that actually occurred.

| Time | Show |
|---|---|
| 00:00–00:30 | The problem: a developer has a project and needs to deploy it on Liara. Open **Deployments → New deployment** in the dark interface. |
| 00:30–01:20 | In **Project**, choose **GitHub** or **ZIP file**. The ZIP option also has **Use sample project**. Show platform detection and any required fixes. For GitHub, explain the pinned commit. |
| 01:20–02:10 | Connect through **Settings → Connect and continue**. In **Destination**, choose a compatible service or review a starter plan, its resources, and total cost. Show the optional **Runtime settings**. |
| 02:10–03:20 | Select **Review deployment**, then **Approve deployment**. Enter the service name, check the consent box, and choose **Approve and run**. Follow upload, release, and HTTP checks. |
| 03:20–04:20 | Show the result, **Open website**, and its deployment entry. Open **Check service** for evidence and the closed health schedule/domain sections. If demonstrating failure recovery, use a prepared real incident or clearly labeled Practice mode. |
| 04:20–05:00 | For a GitHub deployment, show the closed **GitHub updates** section and review mode. Explain that automatic mode needs separate permission. State the limitations and present the repository and demo links. |

If the build takes longer, show the history of that actual run. Clearly label the local demo. Without a connected account, do not claim a live Liara deployment. Distinguish local rules from optional model advice.

For recovery, select **Enable practice mode** under **Settings → Practice mode**, then **Check service → Test a failure → Trigger HTTP 503**, **Investigate**, and **Review recovery**. For a restart demonstration, use a local instance: show the unavailable/returned notice, persistent identity, changed boot ID, and recovered local API session. Do not interrupt a live deployment for the video.

Explain the scope: manual deployments and repairs require user approval. Optional scheduled health checks only observe; GitHub automatic deployment needs explicit standing authorization and pauses on restart or uncertainty. Raw CPU/RAM values have unknown units. Domain setup is guided, with API reads/checks; DNS edits, databases, arbitrary replica counts, and automatic rollback are not managed. Runtime attribution is not cryptographic authentication. Focus on user actions and visible results. Keep it around five minutes for submission.
