# Current issues

## Hosted CI document passage selection

Feature 07. GitHub Actions timed out waiting for **Open selected passage** after the browser test set a textarea selection through JavaScript. The push, build and unit tests succeeded in the [reported run](https://github.com/rajveer3x/Kordos/actions/runs/45218107245/job/137844651059).

The original test reproduced the timeout twice in Ubuntu Chromium. The updated test foregrounds the lead's page, positions the caret, then extends the selection using Shift and the right arrow. It passed three times in Ubuntu Chromium and three times in macOS Chromium. Run `pnpm test:e2e --project=knowledge --no-deps --repeat-each=3 --workers=1 --trace=on` against a migrated test stack to repeat the check.

Close this issue after the commit containing the fix passes the hosted **CI / verify** job.

## Recording issues

When an issue affects a feature or release check, record the feature number, observed behavior, expected result, reproduction steps, and the evidence needed to close it. Link the issue from the affected tracker entry. On resolution, record the fix and the passing verification.
