# Kordos interface direction

Use **Kordos** in the app shell and browser titles. On sign-in and introductory screens, use “The AI workspace for software teams” when a description helps orient the user.

## Translate the reference

The reference homepage uses an oversized italic serif headline, relatively small sans-serif controls, pill navigation and an irregular blue pixel field around a clean white center. It gives the main subject room to breathe. Carry that hierarchy into project overviews and weekly reports. Use compact, stable geometry for execution screens. Create original compositions, patterns, type pairings and copy. [Visual reference](https://andreas.vision/)

## Design tokens

| Role | Default | Application |
|---|---|---|
| Canvas / surface / inset | #F7F8F5 / #FFFFFF / #EEF1EF | Page, detail panel, selected section background |
| Ink / secondary | #161C20 / #485660 | Titles and body / metadata and descriptions |
| Hairline / control outline | #D7DEDF / #75818A | Group separation / interactive boundaries |
| Action / focus | #174FA3 / #174FA3 | One primary action, links, selected path, visible focus ring |
| Sky wash | #DFEDFA | Overview margin, quoted-source selection, current navigation |
| At risk / confirmed / critical | #824400 / #226346 / #A02C35 | Text and icon on pale matching backgrounds; always add a label |
| Typography | Instrument Serif italic, Geist, IBM Plex Mono | Report and overview titles / all operating UI / IDs, timestamps and date changes |
| Spacing / radius | 4, 8, 12, 16, 24, 32, 48, 64 px / 6, 10, 16 px | Compact controls, panel padding and section rhythm. Full pill for segmented navigation only. |

Self-host licensed font files where available, with Georgia, system-ui and monospace fallbacks. Use 44–60 px serif on a desktop project title, 34–40 px on mobile. Operating page titles use 24–32 px sans. Body is 15–16 px with 1.45–1.6 line height. Tables use 14 px and tabular numbers. Use 12–13 px for secondary labels. Let meaningful headings wrap and keep full titles available.

## Shell and layout

Desktop at 1280 px and above uses a 216 px workspace rail, a fluid content column and an optional 320–360 px detail inspector. Allow 32 px content padding. At 768–1279 px collapse the rail and show the inspector as a dismissible sheet when needed. Below 768 px use a navigation drawer, 16 px gutters, task summary rows and full-screen details with a Back action. Keep body text readable at 320 CSS px. Tables and graph canvases can scroll inside labeled regions.

Anchor the workspace switcher and primary navigation in the rail. The header contains breadcrumbs and one contextual action. A project’s Work, Graph, Documents, Meetings and Activity tabs stay in a consistent order following Overview. Show a count only when it helps a user prioritize visible work. Leave navigation destinations clearly labeled.

## Three signature screens

**Project overview.** Set the actual project name in serif over a quiet top band. In its outer right margin, render a small original CSS dot matrix whose horizontal bands align to the project header. The pattern is decorative, aria-hidden and clipped away from text. Below it, line up committed date, forecast and accountable lead. The main section is a ranked list of decisions or risks with an adjacent evidence inspector. An empty project starts with “Add a brief” and “Create task.”

**Work and forecast.** Keep list, board and graph on the same URL-addressable project. An affected path uses a strong blue stroke plus a distinct line style and task labels. A text list presents the same ordered path. The inspector separates “Committed”, “Forecast” and “Assumptions”; a source row names the author and time. Use a date picker for a hypothetical handoff, a “Reset preview” action and a deliberate “Submit for review” button. Reserve warning amber for actual schedule risk.

**Review and evidence.** A queue row names the action, target, requester and age. The detail screen opens with “Move checkout launch” or another specific command. Stack current → proposed values, source passage and affected people in reading order. On a provider write, display destination and exact outgoing text together. Put “Approve change”, “Request edit” and “Reject” in a stable action bar. Stale data replaces approval with “Review latest changes.” A receipt links to the effect and audit record.

## Shared components and states

Build WorkspaceShell, PageHeading, ProjectTabs, StatusLabel, DateComparison, EvidenceLink, SourcePassage, TaskInspector, ReviewDiff and AsyncState as their first consumers arrive. Use design tokens for all. A source passage includes title, revision or timestamp, and a permitted deep link. Graph, search, meeting and review views reuse it. Present genuine source data or a purposeful empty state in every screen.

Use 120–180 ms ease-out for selection and drawer transitions. Honor reduced motion and keep keyboard focus stable during updates. Pair every drag interaction with a button or menu alternative. Return focus to the opener after dismissal. Offer skip navigation, visible keyboard focus, live status announcements and approximately 44 px touch targets on mobile. Aim for at least 4.5:1 normal text contrast and 3:1 meaningful UI boundaries. Verify token combinations in context.

## Visual sign-off

Check a populated project, an empty project, a long task title, a multi-line source, a denied citation, a stale approval and a failed job. Inspect at 1440, 1024 and 390 px, plus a narrow 320 px reflow check. Confirm the action, current date, forecast date and source are identifiable in one scan. Keep entry animations, decorative typography and textures out of task rows, long transcripts and approval diffs.
