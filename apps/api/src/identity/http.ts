import type { identityErrorSchema } from "@kordos/contracts";
import { z } from "zod";

type ErrorBody = z.infer<typeof identityErrorSchema>;
export class IdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorBody["code"],
    message: string,
    readonly current?: unknown,
  ) {
    super(message);
  }
}

export const unavailable = () =>
  new IdentityError(404, "unavailable", "This item is unavailable.");

export function parse<T>(schema: z.ZodType<T>, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new IdentityError(
    400,
    "invalid_input",
    "Check the information you entered.",
  );
}
