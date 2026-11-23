import type {
  Citation,
  DecisionCommand,
  DocumentCommand,
} from "@kordos/contracts";
import type { Sql } from "postgres";
import { databaseScope } from "./identity.js";

type Scope = { workspaceId: string; projectId: string };
type AttachmentUpload = {
  mutationId: string;
  name: string;
  size: number;
  digest: string;
};

type CommandResult =
  | { result: "saved"; id: string }
  | { result: "conflict"; current?: unknown }
  | {
      result:
        | "unavailable"
        | "invalid_state"
        | "invalid_reference"
        | "mutation_conflict";
    };

export function knowledgeStore(client: Sql) {
  const scoped = databaseScope(client);
  return {
    documents(
      actor: string,
      { workspaceId, projectId }: Scope,
      archived: boolean,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] =
          await sql`SELECT kordos_knowledge.documents(${projectId}, ${archived}) AS value`;
        return row?.value;
      });
    },
    document(
      actor: string,
      { workspaceId, projectId }: Scope,
      id: string,
      revision: number | null,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] =
          await sql`SELECT kordos_knowledge.document(${projectId}, ${id}, ${revision}) AS value`;
        return row?.value;
      });
    },
    saveDocument(
      actor: string,
      { workspaceId, projectId }: Scope,
      id: string | null,
      command: DocumentCommand,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql<{ value: CommandResult }[]>`
          SELECT kordos_knowledge.save_document(${projectId}, ${id}, ${JSON.stringify(command)}::jsonb) AS value
        `;
        return row!.value;
      });
    },
    decisions(
      actor: string,
      { workspaceId, projectId }: Scope,
      id: string | null,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] =
          await sql`SELECT kordos_knowledge.decisions(${projectId}, ${id}) AS value`;
        return row?.value;
      });
    },
    saveDecision(
      actor: string,
      { workspaceId, projectId }: Scope,
      id: string | null,
      command: DecisionCommand,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql<{ value: CommandResult }[]>`
          SELECT kordos_knowledge.save_decision(${projectId}, ${id}, ${JSON.stringify(command)}::jsonb) AS value
        `;
        return row!.value;
      });
    },
    resolveCitation(actor: string, workspaceId: string, source: Citation) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] =
          await sql`SELECT kordos_knowledge.citation(${JSON.stringify(source)}::jsonb) AS value`;
        return row?.value;
      });
    },
    attachment(
      actor: string,
      { workspaceId, projectId }: Scope,
      document: string,
      id: string,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql<
          { value: { key: string; name: string; size: number } | null }[]
        >`
          SELECT kordos_knowledge.attachment(${projectId}, ${document}, ${id}) AS value
        `;
        return row?.value;
      });
    },
    upload(
      actor: string,
      { workspaceId, projectId }: Scope,
      document: string,
      input: AttachmentUpload,
      finish: boolean,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql<
          { value: CommandResult | { result: "pending"; key: string } }[]
        >`
          SELECT kordos_knowledge.upload(${projectId}, ${document}, ${JSON.stringify(input)}::jsonb, ${finish}) AS value
        `;
        return row!.value;
      });
    },
  };
}
