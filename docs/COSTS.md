# Cost target

Target: approximately **$0–3/month of GCP infrastructure for light personal use**,
with scale-to-zero and available free quotas. This is a usage estimate, not a
spending guarantee. Amp credits/subscriptions and ChatGPT are separate.

Pricing checked against official documentation on 22 October 2026; USD, before
taxes. Region, shared account allowances, traffic and future prices affect totals.

| Component | Choice and free allowance |
| --- | --- |
| Cloud Run | Request-based billing; 1 vCPU / 1 GiB, recommend min 0 / max 1. Monthly allowances include 180,000 CPU-seconds, 360,000 GiB-seconds and 2M requests. |
| Firestore | One default Standard/Native database. Free daily allowance: 50,000 reads, 20,000 writes, 20,000 deletes; 1 GiB stored. |
| Cloud Tasks | One queue, dispatch concurrency 1. First 1M operations/month free. |
| Cloud Scheduler | One 15-minute recovery job. First three jobs/billing account free; otherwise $0.10/job/month. |
| Secret Manager | Three secret values, few active versions; six active versions and 10,000 accesses/month are free. |
| Images/builds | Retain two images, remove older artifacts. Registry storage and build minutes have separate allowances; occasional small overages can remain small. |

Sources: [Cloud Run](https://cloud.google.com/run/pricing),
[Firestore quotas](https://firebase.google.com/docs/firestore/quotas),
[Cloud Tasks](https://cloud.google.com/tasks/pricing),
[Scheduler](https://cloud.google.com/scheduler/pricing),
[Secret Manager](https://cloud.google.com/secret-manager/pricing),
[Artifact Registry](https://cloud.google.com/artifact-registry/pricing),
[Cloud Build](https://cloud.google.com/build/pricing).

## Why minimum 1 conflicts with the target

A continuously warm 1-vCPU / 1-GiB request-billed instance is roughly **$12.96 per
30 days before free credits**, even when idle: 2,592,000 seconds ×
($0.0000025 CPU + $0.0000025 memory). Free credits may reduce it, but cannot be
assumed unused. Always-allocated CPU costs more. Recommend minimum 0 and accept
cold starts; no minimum/maximum instance settings are applied by this repository.

## What the code does to keep usage small

- No Cloud SQL, Redis, permanent worker, polling subscription, VPC connector or
  Firebase Functions. Tasks wake the same Cloud Run service and hold the HTTP
  request until the bounded worker finishes.
- Ten job admissions/day, ten-minute maximum observation/job and a shared
  1800-second daily observation reservation budget by default. Queue one worker
  at a time. Admission reserves the whole timeout; normal completion releases
  unused seconds. Cancellation still counts toward the admission limit.
- At the default daily time budget, 30 days of monitoring is about 15 vCPU-hours
  plus startup/API overhead, below the 50-hour request-based CPU allowance if
  that allowance remains available. This is not a cap on all Cloud Run traffic.
- List counts are updated atomically instead of scanning every item. Item pages
  use indexed cursors. Job pages are bounded; large old-history offsets still
  incur skipped-document reads, so use small pages.
- Progress writes are coalesced once per ten seconds. Large JSON bodies are not
  indexed. There are no real-time Firestore listeners or automatic client polls.
- The recovery schedule makes 2,880 short requests in a 30-day month and bounded
  queries/deletions. It cleans expired auth/receipt records and 30-day terminal
  history without paid Firestore TTL deletion. Active jobs and list data are retained.

Remote Amp work can continue after HQ's observation timeout or stop request.
The code bounds GCP observation work; it does not cap Amp account spending.
Public request abuse, other services consuming free quotas, egress, extensive
history, extra image versions and builds can raise costs. Set a billing alert
and check actual usage; alerts and maximum instance counts are not spending caps.
