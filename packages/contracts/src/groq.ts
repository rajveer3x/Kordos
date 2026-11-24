import { z } from "zod";

export const groqModelEnv = {
  GROQ_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  GROQ_TEXT_MODEL: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .default("openai/gpt-oss-20b"),
  GROQ_FIXTURE_URL: z
    .url({ protocol: /^https?$/, hostname: /^127\.0\.0\.1$/ })
    .optional(),
};

type Environment = z.infer<z.ZodObject<typeof groqModelEnv>>;

export function groqModelSettings(settings: Environment, nodeEnv?: string) {
  if (!settings.GROQ_API_KEY) return;
  return {
    provider: "groq" as const,
    apiKey: settings.GROQ_API_KEY,
    baseUrl:
      (nodeEnv !== "production" ? settings.GROQ_FIXTURE_URL : undefined) ??
      "https://api.groq.com/openai/v1/",
    model: settings.GROQ_TEXT_MODEL,
  };
}
