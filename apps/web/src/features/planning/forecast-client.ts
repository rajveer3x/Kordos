import { graphSchema } from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { read } from "../identity/api";
import { planningRefresh, usePlanning } from "./planning-client";

export function useForecast(projectId: string, enabled = true) {
  const { api, key } = usePlanning();
  const path = `${api}/projects/${projectId}`;
  const query = useQuery({
    queryKey: [...key, "graph", projectId],
    queryFn: ({ signal }) => read(`${path}/graph`, graphSchema, signal),
    enabled,
    ...planningRefresh,
  });
  return { query, path, key: [...key, "scenario", projectId] as const };
}
