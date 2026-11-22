import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { WorkspaceRoutes } from "../src/app";
import type { Workspace } from "../src/features/workspace/workspace-model";

const workspace: Workspace = {
  name: "Northstar Studio",
  member: { name: "Maya Chen", initials: "MC" },
  projects: [
    {
      id: "checkout",
      name: "Checkout modernization",
      description:
        "A faster, more resilient checkout for teams shipping across regions.",
      commitment: "2027-01-24",
      forecast: "2027-01-28",
      lead: "Maya Chen",
      signals: [
        {
          id: "provider-signoff",
          title: "Payment certification is at risk",
          status: "At risk",
          tone: "risk",
          description:
            "Provider sign-off now lands four days after the committed release date.",
          evidence: {
            id: "payments-sync",
            title: "Payments integration sync",
            kind: "Meeting note",
            author: "Maya Chen",
            date: "2027-01-12",
            excerpt:
              "The provider moved certification to January 28. We can finish integration testing before then, but we need sign-off before opening the rollout.",
          },
        },
        {
          id: "rollout",
          title: "Rollout starts with a regional pilot",
          status: "Confirmed",
          tone: "confirmed",
          description:
            "The team will watch payment recovery and support volume before expanding.",
          evidence: {
            id: "rollout-review",
            title: "Checkout rollout review",
            kind: "Decision note",
            author: "Rohan Shah",
            date: "2027-01-10",
            excerpt:
              "We agreed to start in one region and review payment recovery and support volume before expanding.",
          },
        },
        {
          id: "migration",
          title: "Legacy webhook migration",
          status: "In review",
          tone: "neutral",
          description:
            "Platform engineering is reviewing the cutover and rollback plan.",
        },
      ],
    },
    {
      id: "developer-portal",
      name: "Developer portal",
      description:
        "A single place to find internal guides, APIs, and team-owned services.",
      signals: [],
    },
  ],
};

const root = document.getElementById("root");
if (!root) throw new Error("Kordos needs a root element.");
const queryClient = new QueryClient();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <WorkspaceRoutes workspace={workspace} />
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
