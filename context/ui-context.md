# Kordos UI and UX

Use **Kordos** in the app shell and browser titles. On sign-in and introductory screens, use “The AI workspace for software teams” when a description helps orient the user.

## Visual direction

Use a light canvas with soft lavender and blue gradients, a floating navigation rail and near-white frosted panels. Keep violet as the action and focus color. Use white edges and soft shadows to show elevation. Reuse the shared `glass-panel` style and add `glass-panel--blur` to prominent surfaces such as the navigation rail, header and sign-in card. Keep tables, forms, and evidence on stable, near-opaque surfaces with simple dividers.

The three translucent panes in `GlassArtwork` are decorative and aria-hidden. Use them sparingly on sign-in and roomy project headers. The project header leaves the artwork out on phones. Use the solid surface fallback when blur is unavailable or the user prefers reduced transparency.

## Design tokens

| Role | Default | Application |
|---|---|---|
| Canvas / surface / inset | #F1F4FB / #FFFFFF / #EDF0F9 | Background, opaque inputs and neutral inset |
| Ink / secondary | #22263B / #505973 | Headings and body / metadata and descriptions |
| Hairline / control outline | #D6DCED / #7A84A1 | Dividers / interactive boundaries |
| Action / hover / accent surface | #5142AC / #423490 / #EBE8FD | Primary actions, focus, active navigation and quotes |
| Glass panel | 66% white / #FAFBFF solid fallback | Floating navigation, headings and cards |
| At risk / confirmed / critical | #824400 / #226346 / #A02C35 | Text and icon on pale matching backgrounds with a visible label |
| Typography | Geist / IBM Plex Mono | Display and operating text / IDs and timestamps |
| Spacing / radius | 4, 8, 12, 16, 24, 32, 48, 64 px / 10 and 20 px | Smaller radius for controls and larger radius for panels |

Use shared semantic variables from [styles.css](../apps/web/src/styles.css) and the bundled fonts with system fallbacks. Project titles scale from 30 to 50 px in Geist. Use 24–32 px for operating headings, 16 px for body text and 14 px for controls and tables. Reserve 12–13 px for secondary metadata. Let headings wrap and use tabular numbers for comparisons.

## Shell and layout

Desktop at 1280 px and above uses a floating workspace rail within the first 228 px of the shell, a fluid content column and an optional 320–360 px detail inspector. Allow 32 px content padding. At 768–1279 px collapse the rail to icons and show the inspector as a dismissible sheet when needed. Below 768 px use a navigation drawer, 16 px gutters, task summary rows and full-screen details with a Back action. Keep body text readable at 320 CSS px. Tables and graph canvases can scroll inside labeled regions.

Anchor the workspace switcher and primary navigation in the rail. Use a violet inset and stronger type for the active rail link. Place breadcrumbs above the project header and one contextual action beside or below the title. A project’s Work, Graph, Documents, Meetings and Activity tabs stay in a consistent order following Overview. Keep tabs together in a shallow frosted panel and use the violet inset for the active tab. Let the tabs wrap at narrow widths. Show a count only when it helps a user prioritize visible work.

## Three signature screens

**Project overview.** Put the project name, summary and primary action inside a compact frosted header. Keep artwork in the open area to the right. Below the tabs, give committed date, forecast and accountable lead three aligned cards. On narrow phones, stack them as label and value rows. Show decisions and risks in a single list. Place the featured evidence next to the list on desktop and use the detail sheet at narrower widths. An empty project starts with “Add a brief” and “Create task.”

**Work and forecast.** Keep list, board and graph on the same URL-addressable project. An affected path uses a strong blue stroke plus a distinct line style and task labels. A text list presents the same ordered path. The inspector separates “Committed”, “Forecast” and “Assumptions”; a source row names the author and time. Use a date picker for a hypothetical handoff, a “Reset preview” action and a deliberate “Submit for review” button. Reserve warning amber for actual schedule risk.

**Review and evidence.** A queue row names the action, target, requester and age. The detail screen opens with “Move checkout launch” or another specific command. Stack current → proposed values, source passage and affected people in reading order. On a provider write, display destination and exact outgoing text together. Put “Approve change”, “Request edit” and “Reject” in a stable action bar. Stale data replaces approval with “Review latest changes.” A receipt links to the effect and audit record.

## Shared components and states

Reuse WorkspaceShell, PageHeading, ProjectTabs, StatusLabel, DateComparison, SourcePassage and AsyncState. Add EvidenceLink, TaskInspector and ReviewDiff with their first consumers. Use design tokens for all. A source passage includes title, revision or timestamp, and a permitted deep link. Graph, search, meeting and review views reuse it. Present genuine source data or a purposeful empty state in every screen.

Use 120–180 ms ease-out for selection and drawer transitions. Honor reduced motion and keep keyboard focus stable during updates. Pair every drag interaction with a button or menu alternative. Return focus to the opener after dismissal. Offer skip navigation, visible keyboard focus, live status announcements and approximately 44 px touch targets on mobile. Aim for at least 4.5:1 normal text contrast and 3:1 meaningful UI boundaries. Verify token combinations in context.

## Visual sign-off

Check populated and empty views and the relevant loading, denied and error states. As those features arrive, include a long task title, a multi-line source, a denied citation, a stale approval and a failed job. Inspect at 1440, 1024 and 390 px plus 320 px reflow and 200% zoom. Confirm the primary action, committed date, forecast date and source are easy to find. Verify contrast against the strongest tint that can appear under text or focus. Check the opaque fallback with reduced transparency enabled.
