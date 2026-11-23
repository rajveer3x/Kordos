import {
  emailSchema,
  idSchema,
  inboxReasonSchema,
  type InboxFilter,
  type InboxPreferences,
} from "@kordos/contracts";
import postgres, { type Sql } from "postgres";
import { z } from "zod";
import { databaseScope } from "./identity.js";

export function inboxStore(client: Sql) {
  const scoped = databaseScope(client);
  return {
    directory([actor, workspace]: [string, string], filter: InboxFilter) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql`SELECT kordos_inbox.directory(
          ${filter.cursor ?? null}, ${filter.reason ?? null}, ${filter.state ?? null}, ${filter.digest ?? null}
        ) AS value`;
        return row?.value;
      });
    },
    entry([actor, workspace]: [string, string], id: string, read?: boolean) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          read === undefined
            ? await sql`SELECT kordos_inbox.detail(${id}) AS value`
            : await sql`SELECT kordos_inbox.mark_read(${id}, ${read}) AS value`;
        return row?.value;
      });
    },
    preferences(
      [actor, workspace]: [string, string],
      preferences?: InboxPreferences,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = preferences
          ? await sql`SELECT kordos_inbox.save_preferences(
              ${preferences.version}, ${JSON.stringify(preferences)}::jsonb
            ) AS value`
          : await sql`SELECT kordos_inbox.preferences() AS value`;
        return row?.value;
      });
    },
    home([actor, workspace]: [string, string], sort: "age" | "milestone") {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql`SELECT kordos_inbox.home(${sort}) AS value`;
        return row?.value;
      });
    },
  };
}

const emailJob = z.object({
  id: idSchema,
  workspaceId: idSchema,
  email: emailSchema,
  reason: inboxReasonSchema,
  digest: z.iso.date().nullable(),
  key: z.string(),
});
export type InboxEmailJob = z.infer<typeof emailJob>;

export function connectInboxWorker(url: string) {
  const client = postgres(url, {
    max: 2,
    connect_timeout: 2,
    connection: { statement_timeout: 2500 },
  });
  return {
    schedule: async () => {
      await client`SELECT kordos_inbox.schedule()`;
    },
    advance: async () => {
      await client`SELECT kordos_inbox.advance()`;
    },
    async email(
      send: (job: InboxEmailJob) => Promise<"sent" | "retry" | "failed">,
    ) {
      return client.begin(async (sql) => {
        const [row] = await sql`SELECT kordos_inbox.next_email() AS value`;
        if (!row?.value) return false;
        const job = emailJob.parse(row.value);
        const outcome = await send(job);
        await sql`SELECT kordos_inbox.finish_email(${job.id}, ${outcome})`;
        return true;
      });
    },
    close: () => client.end({ timeout: 3 }),
  };
}
