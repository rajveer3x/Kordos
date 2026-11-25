# Current issues

## Hosted CI document passage selection

Feature 07. GitHub Actions timed out waiting for **Open selected passage** after the browser test set a textarea selection through JavaScript. The push, build and unit tests succeeded in the [reported run](https://github.com/rajveer3x/Kordos/actions/runs/45218107245/job/137844651059).

The original test reproduced the timeout twice in Ubuntu Chromium. The updated test foregrounds the lead's page, positions the caret, then extends the selection using Shift and the right arrow. It passed three times in Ubuntu Chromium and three times in macOS Chromium. Run `pnpm test:e2e --project=knowledge --no-deps --repeat-each=3 --workers=1 --trace=on` against a migrated test stack to repeat the check.

Close this issue after the commit containing the fix passes the hosted **CI / verify** job.

## Feature 22 release verification

The [release evidence](evidence/feature-22/README.md) records the application revision, fixture commands, expected outcomes and results. Keep v1 release verification open until these checks pass.

- **Live ranked search.** The local release-scale benchmark passed with 1,000 successful requests, 353 ms ingress p95, 100/100 labeled top-five matches and all eleven access probes passing. Run the equivalent workload with the designated release embedding model on staging and record latency, relevance, errors and actual provider cost.
- **Extraction quality.** The 30 meeting excerpts recovered 50 of 60 actions, 30 of 35 owner assignments and none of 30 dependencies. Run `pnpm test:release:extraction` to reproduce. Verify the labeled fields after addressing the missed action phrasing and dependency capture, and score the 30 briefs with a designated live model test account.
- **Connected release journeys.** The browser suite uses loopback Auth0, GitHub, Google, email and model fixtures. Complete the seven end-to-end journeys on the release revision with test provider installations, and repeat tenant isolation and ranked search after a timed staging restore. Record the environment, expected outcome and actual outcome for each journey.

The local action-audit gap is resolved for the measured operation classes. The browser journey reconciliation linked 140/140 records, including every measured risk evaluation, weekly capture and GitHub attempt. New records cover runs from the audit migration forward. See the [remediation evidence](evidence/feature-22/README.md#remediation-results).

## Recording issues

When an issue affects a feature or release check, record the feature number, observed behavior, expected result, reproduction steps, and the evidence needed to close it. Link the issue from the affected tracker entry. On resolution, record the fix and the passing verification.
