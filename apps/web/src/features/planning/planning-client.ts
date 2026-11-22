import {
  projectCommandResponseSchema,
  type ProjectDetails,
  type WorkspaceSummary,
} from "@kordos/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import type { Project } from "../workspace/workspace-model";
import { ApiError, errorMessage, request } from "../identity/api";

export const PlanningScope = createContext<{
  workspace: WorkspaceSummary;
  actorId: string;
} | null>(null);
export const planningRefresh = { gcTime: 0, refetchInterval: 5_000 } as const;

export function usePlanning() {
  const scope = useContext(PlanningScope);
  if (!scope) throw new Error("A workspace is required.");
  const { workspace, actorId } = scope;
  return {
    workspace,
    actorId,
    api: `/workspaces/${workspace.id}`,
    key: ["planning", actorId, workspace.id, workspace.role] as const,
  };
}

export function usePlanningCommand() {
  const { key, actorId, workspace } = usePlanning();
  const client = useQueryClient();
  const pending = useRef(false);
  const lastRequest = useRef<{ signature: string; id: string }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; current?: unknown }>();
  const [notice, setNotice] = useState("");
  async function save(
    path: string,
    method: "POST" | "PATCH",
    fields: object,
    success: (id: string) => void,
    message = "Changes saved.",
  ) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    setError(undefined);
    const signature = JSON.stringify([path, method, fields]);
    if (lastRequest.current?.signature !== signature) {
      lastRequest.current = { signature, id: crypto.randomUUID() };
    }
    try {
      const result = await request(path, {
        method,
        body: { ...fields, mutationId: lastRequest.current.id },
        schema: projectCommandResponseSchema,
      });
      if (!result) throw new Error("Missing command response.");
      lastRequest.current = null;
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({
          queryKey: ["identity", "workspace", actorId, workspace.id],
        }),
      ]);
      success(result.id);
      setNotice(message);
    } catch (failure) {
      setError({
        message: errorMessage(failure),
        current: failure instanceof ApiError ? failure.current : undefined,
      });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    notice,
    save,
    clearError: () => setError(undefined),
    invalid: (message: string) => {
      setNotice("");
      setError({ message });
    },
  };
}

export type LiveProjectContext = { project: Project; details: ProjectDetails };

export function useLiveProject() {
  return useOutletContext<LiveProjectContext>();
}

export function retainEdits<T extends object>(
  draft: T,
  original: T,
  latest: T,
): T {
  return Object.assign(
    { ...latest },
    Object.fromEntries(
      Object.entries(draft).filter(
        ([key, value]) => value !== original[key as keyof T],
      ),
    ),
  );
}
