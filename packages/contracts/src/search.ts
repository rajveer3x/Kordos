import { z } from "zod";
import { idSchema } from "./identity.js";
import { citationSchema } from "./knowledge.js";

export const searchKinds = [
  "work",
  "document",
  "decision",
  "meeting",
  "github",
  "email",
] as const;
export const searchKindSchema = z.enum(searchKinds);

export const searchQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine((value) => !value.includes("\0")),
    project: idSchema.optional(),
    type: searchKindSchema.optional(),
    owner: idSchema.optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .refine(({ from, to }) => !from || !to || from <= to);

export const searchResultSchema = z.object({
  id: idSchema,
  kind: searchKindSchema,
  projectId: idSchema,
  project: z.string(),
  title: z.string(),
  excerpt: z.string(),
  attribution: z.string(),
  date: z.iso.date().nullable(),
  revision: z.number().int().positive(),
  externalId: z.string().nullable(),
  citation: citationSchema.nullable(),
});

export const searchResponseSchema = z.object({
  items: z.array(searchResultSchema),
  hasMore: z.boolean(),
  indexing: z.boolean(),
  mode: z.enum(["exact", "hybrid", "lexical"]),
});

export const searchAnswerSchema = z.object({
  status: z.enum(["supported", "conflicting", "insufficient"]),
  passages: z.array(searchResultSchema),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchAnswer = z.infer<typeof searchAnswerSchema>;

export const searchEmbeddingDimensions = 512;

export const searchModelEnv = {
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .default("https://api.openai.com/v1/"),
  OPENAI_SEARCH_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  OPENAI_SEARCH_EMBEDDING_MODEL: z.string().min(1).max(120).optional(),
  OPENAI_SEARCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(15000)
    .default(3000),
};
