import type {
  CollaborationScope,
  Comment,
  CommentChange,
  CommentCommand,
} from "@kordos/contracts";
import type { Sql } from "postgres";
import { databaseScope } from "./identity.js";

type Person = Comment["author"];
type Feed = {
  revision: string;
  events: CommentChange[];
  presence: Person[];
  more: boolean;
};
type Snapshot = {
  cursor: string;
  items: Comment[];
  older: string | null;
  canPost: boolean;
  canModerate: boolean;
  people: Person[];
};
type CommandResult =
  | { result: "saved"; id: string }
  | {
      result:
        | "unavailable"
        | "invalid_state"
        | "invalid_mention"
        | "conflict"
        | "mutation_conflict";
    };

export function collaborationStore(client: Sql) {
  const scoped = databaseScope(client);
  return {
    snapshot(
      actor: string,
      { workspaceId, projectId, subject }: CollaborationScope,
      before: string | null,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql<{ value: Snapshot | null }[]>`
          SELECT kordos_collaboration.snapshot(${projectId}, ${subject.kind}, ${subject.id}, ${before}) AS value
        `;
        return row?.value;
      });
    },
    feed(
      actor: string,
      { workspaceId, projectId, subject }: CollaborationScope,
      after: string,
      present: string[] = [],
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql<{ value: Feed | null }[]>`
          SELECT kordos_collaboration.feed(${projectId}, ${subject.kind}, ${subject.id}, ${after}::bigint, ${sql.array(present, 2950)}) AS value
        `;
        return row?.value;
      });
    },
    current(
      actor: string,
      { workspaceId, projectId, subject }: CollaborationScope,
      commentId: string,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql`
          SELECT id, body, version, mention_ids AS "mentionIds", resolved_at AS "resolvedAt"
          FROM public.comments
          WHERE (workspace_id, project_id, subject_kind, subject_id, id)
            = (${workspaceId}, ${projectId}, ${subject.kind}, ${subject.id}, ${commentId})
        `;
        return row;
      });
    },
    save(
      actor: string,
      { workspaceId, projectId, subject }: CollaborationScope,
      input: CommentCommand,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql<{ value: CommandResult }[]>`
          SELECT kordos_collaboration.save(${projectId}, ${subject.kind}, ${subject.id}, ${JSON.stringify(input)}::jsonb) AS value
        `;
        return row!.value;
      });
    },
    listen(wake: () => void) {
      return client.listen("kordos_collaboration", wake, wake);
    },
  };
}
