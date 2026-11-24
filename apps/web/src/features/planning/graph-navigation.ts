import { idSchema } from "@kordos/contracts";
import { z } from "zod";

export const graphReturnSchema = z.object({
  search: z.string(),
  itemId: idSchema,
  row: z.enum(["impact", "selection"]),
});

export function graphRowId(row: "impact" | "selection", itemId: string) {
  return `forecast-${row}-${itemId}`;
}
