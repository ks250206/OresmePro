---
title: Open in Oresme proposal
description: A future design for handing documentation examples to the app.
---

Today, **Open OresmePro** opens the app. Copy the example, paste it into the Command Window, and run it there.

## Proposed workflow

1. Pass a versioned ID such as `sample=sine-v1` in a link. The app would resolve the ID against a bundled allowlist and show the matching source. Link input would accept IDs only and reject arbitrary code, remote URLs, and file names.
2. Show the full source and destination before execution. Select a fresh experiment by default to protect ongoing work. After confirmation, insert the code in the Command Window for the user to run through the usual controls.
3. For unknown IDs, incompatible versions, or failed lookups, display an error and offer the copy workflow with no experiment changes. Publish matching sample IDs and source in both build outputs.

Python can access the active experiment's waves and files. Executing code in response to an incoming URL or message would let a link trigger changes to that data. Browser storage is origin-scoped, so the documentation's scripts and host are part of the same trust boundary when the app and docs share an origin.
