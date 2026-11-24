import { idSchema } from "@kordos/contracts";
import { useLocation } from "react-router";

export function useActivityReturn(workspace: string) {
  const { state } = useLocation();
  const target: unknown = state?.activityReturn;
  if (typeof target !== "string") return;
  const pathname = target.split("?")[0] ?? "";
  const match = /^\/w\/([^/]+)\/projects\/([^/]+)\/activity$/.exec(pathname);
  if (match?.[1] === workspace && idSchema.safeParse(match[2]).success) {
    return target;
  }
}
