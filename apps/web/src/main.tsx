import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { LiveRoutes } from "./features/identity/live-routes";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const root = document.getElementById("root");
if (!root) throw new Error("Kordos needs a root element.");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <LiveRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
