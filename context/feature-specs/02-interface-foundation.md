# 02 · Interface foundation

**Prerequisites** — [01](01-workspace-foundation.md)

## Implementation prompt

Create the responsive signed-in shell and visual primitives that all product screens will share. Follow the [session workflow](../ai-workflow-rules.md).

Implement semantic tokens from ui-context.md, font fallbacks, page headings, rail, project tabs, sheet, focus behavior, buttons and status labels. Build a project overview shell with a reusable header and original dot field in its outer margin.

Use fixture data in component previews and tests. Keep live shell content tied to real data or an empty state. Add a keyboard-accessible mobile drawer and shared error/loading patterns. Keep sign-in and protected route boundaries ready for the identity feature.

## Acceptance checks

- [ ] At desktop, tablet and phone widths the project name, primary action and active destination remain visible.
- [ ] At 320 px and 200% zoom the shell reflows; focus returns after sheet dismissal. Reduced-motion mode removes spatial transitions.
- [ ] Capture a populated and an empty overview at desktop and mobile sizes for comparison.

Record verification evidence and outstanding gaps in the [progress tracker](../progress-tracker.md).
