import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { HealthPage } from "./features/health/health-page";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const root = document.getElementById("root");
if (!root) throw new Error("Kordos needs a root element.");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/health" replace />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="*" element={<Navigate to="/health" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
