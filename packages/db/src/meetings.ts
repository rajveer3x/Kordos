import type {
  MeetingExtractedItem,
  MeetingFailure,
  MeetingJob,
  MeetingSegment,
} from "@kordos/contracts";
import postgres, { type Sql } from "postgres";
import { databaseScope } from "./identity.js";

type Scope = { workspaceId: string; projectId: string };
type Command = {
  result: string;
  id?: string;
  key?: string;
  proposalId?: string;
};

export function meetingsStore(client: Sql) {
  const scoped = databaseScope(client);
  return {
    directory(
      actor: string,
      { workspaceId, projectId }: Scope,
      cursor: string | null,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] =
          await sql`SELECT kordos_meetings.directory(${projectId},${cursor}) AS value`;
        return row?.value;
      });
    },
    detail(
      actor: string,
      { workspaceId, projectId }: Scope,
      id: string,
      revision: number | null,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] =
          await sql`SELECT kordos_meetings.detail(${projectId},${id},${revision}) AS value`;
        return row?.value;
      });
    },
    write(
      actor: string,
      { workspaceId, projectId }: Scope,
      id: string | null,
      input: object,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql<
          { value: Command }[]
        >`SELECT kordos_meetings.write(${projectId},${id},${JSON.stringify(input)}::text::jsonb) AS value`;
        return row!.value;
      });
    },
    item(
      actor: string,
      { workspaceId, projectId }: Scope,
      id: string,
      itemId: string,
      input: object,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql<
          { value: Command }[]
        >`SELECT kordos_meetings.write_item(${projectId},${id},${itemId},${JSON.stringify(input)}::text::jsonb) AS value`;
        return row!.value;
      });
    },
    upload(
      actor: string,
      { workspaceId, projectId }: Scope,
      id: string,
      input: object,
      finished: boolean,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] = await sql<
          { value: Command }[]
        >`SELECT kordos_meetings.upload(${projectId},${id},${JSON.stringify(input)}::text::jsonb,${finished}) AS value`;
        return row!.value;
      });
    },
    audio(
      actor: string,
      { workspaceId, projectId }: Scope,
      id: string,
      media: string,
    ) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] =
          await sql`SELECT kordos_meetings.audio(${projectId},${id},${media}) AS value`;
        return row?.value;
      });
    },
    origin(actor: string, { workspaceId, projectId }: Scope, work: string) {
      return scoped(actor, workspaceId, async (sql) => {
        const [row] =
          await sql`SELECT kordos_meetings.work_origin(${projectId},${work}) AS value`;
        return row?.value;
      });
    },
  };
}

type MeetingOutcome =
  | { failure: MeetingFailure }
  | { segments: MeetingSegment[]; items: MeetingExtractedItem[] };
export function connectMeetingWorker(url: string) {
  const sql = postgres(url, {
    connect_timeout: 2,
    connection: { statement_timeout: 3000 },
  });
  return {
    pending: () => sql<MeetingJob[]>`SELECT * FROM kordos_meetings.pending()`,
    async claim(job: MeetingJob) {
      const [row] =
        await sql`SELECT kordos_ops.claim_meeting(${job.id},${job.generation}) AS value`;
      return row?.value;
    },
    async finish(id: string, lease: string, outcome: MeetingOutcome) {
      await sql`SELECT kordos_meetings.finish(${id},${lease},
        ${"segments" in outcome ? JSON.stringify(outcome.segments) : null}::text::jsonb,
        ${"items" in outcome ? JSON.stringify(outcome.items) : null}::text::jsonb,
        ${"failure" in outcome ? outcome.failure : null})`;
    },
    cleanup: () =>
      sql<
        { id: string; key: string }[]
      >`SELECT * FROM kordos_meetings.cleanup()`,
    async cleaned(id: string) {
      await sql`SELECT kordos_meetings.cleaned(${id})`;
    },
    close: () => sql.end({ timeout: 3 }),
  };
}
