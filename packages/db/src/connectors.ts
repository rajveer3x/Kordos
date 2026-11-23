import {
  connectorClaimSchema,
  githubExecutionSchema,
  type GitHubRemoteReceipt,
  type ConnectorChange,
  type ConnectorQueueJob,
  type connectorDeliverySchema,
  type connectorIssueSchema,
} from "@kordos/contracts";
import postgres, { type Sql } from "postgres";
import type { z } from "zod";
import { databaseScope } from "./identity.js";

type Scope = [string, string];
type CommandResult = { result: string; id?: string; current?: unknown };
type Issue = z.infer<typeof connectorIssueSchema>;
type Delivery = z.infer<typeof connectorDeliverySchema>;

export function connectorStore(client: Sql) {
  const scoped = databaseScope(client);
  return {
    list([actor, workspace]: Scope) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql`SELECT kordos_connectors.directory() AS value`;
        return row?.value;
      });
    },
    manage(
      [actor, workspace]: Scope,
      id: string,
      input: object,
      credential: string | null,
      fingerprint: string,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<
          { value: CommandResult | null }[]
        >`SELECT kordos_connectors.manage(
          ${id}, ${JSON.stringify(input)}::text::jsonb, ${credential}, ${fingerprint}) AS value`;
        return row?.value;
      });
    },
    async receive(
      id: string,
      delivery: string,
      hash: string,
      payload: Delivery,
    ) {
      const [row] = await client<
        { value: CommandResult | null }[]
      >`SELECT kordos_connectors.receive(
        ${id}, ${delivery}, ${hash}, ${JSON.stringify(payload)}::text::jsonb) AS value`;
      return row?.value;
    },
    async githubReceive(
      workspace: string,
      installation: string,
      delivery: string,
      hash: string,
      scope: string,
      event: object,
    ) {
      const [row] = await client<
        { value: CommandResult | null }[]
      >`SELECT kordos_github.receive(
        ${workspace}, ${installation}, ${delivery}, ${hash}, ${scope}, ${JSON.stringify(event)}::text::jsonb) AS value`;
      return row?.value;
    },
    async githubInvalidate(
      workspace: string,
      installation: string,
      scopes: string[] | null,
    ) {
      await client`SELECT kordos_github.invalidate(${workspace}, ${installation}, ${scopes ? JSON.stringify(scopes) : null}::text::jsonb)`;
    },
    githubActivity(
      [actor, workspace]: Scope,
      project: string,
      work: string | null,
      cursor: string | null,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_github.activity(${project}, ${work}, ${cursor}) AS value`;
        return row?.value;
      });
    },
    githubLink(
      [actor, workspace]: Scope,
      project: string,
      source: string,
      input: { workId: string; mutationId: string; linked: boolean },
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<
          { value: CommandResult | null }[]
        >`SELECT kordos_github.link_work(
          ${project}, ${source}, ${input.workId}, ${input.mutationId}, ${input.linked}) AS value`;
        return row?.value;
      });
    },
    sources([actor, workspace]: Scope, project: string, cursor: string | null) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_connectors.sources(${project}, ${cursor}) AS value`;
        return row?.value;
      });
    },
    source(
      [actor, workspace]: Scope,
      project: string,
      id: string,
      revision: number | null,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] =
          await sql`SELECT kordos_connectors.source(${project}, ${id}, ${revision}) AS value`;
        return row?.value;
      });
    },
    share(
      [actor, workspace]: Scope,
      project: string,
      id: string,
      input: { mutationId: string; revision: number; excerpt: string },
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<
          { value: CommandResult | null }[]
        >`SELECT kordos_connectors.share(
          ${project}, ${id}, ${JSON.stringify(input)}::text::jsonb) AS value`;
        return row?.value;
      });
    },
    revoke(
      [actor, workspace]: Scope,
      project: string,
      id: string,
      mutation: string,
    ) {
      return scoped(actor, workspace, async (sql) => {
        const [row] = await sql<
          { value: CommandResult | null }[]
        >`SELECT kordos_connectors.revoke_share(
          ${project}, ${id}, ${mutation}) AS value`;
        return row?.value;
      });
    },
  };
}

export type ConnectorBatch = {
  changes: ConnectorChange[];
  audience: "project" | "private";
  checkpoint: string | null;
  rebuild: boolean;
  repositoryId?: string;
};

export function connectConnectorWorker(url: string) {
  const client = postgres(url, {
    max: 4,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  return {
    pending: () =>
      client<ConnectorQueueJob[]>`SELECT * FROM kordos_connectors.pending()`,
    async claim({ id, generation }: ConnectorQueueJob) {
      const [row] =
        await client`SELECT kordos_connectors.claim(${id}, ${generation}) AS value`;
      return row?.value ? connectorClaimSchema.parse(row.value) : null;
    },
    async finish(
      id: string,
      lease: string,
      batch: ConnectorBatch | null,
      issue: Issue | null,
    ) {
      await client`SELECT kordos_connectors.finish(${id}, ${lease}, ${batch ? JSON.stringify(batch) : null}::text::jsonb, ${issue})`;
    },
    githubPending: () =>
      client<{ id: string }[]>`SELECT id FROM kordos_github.pending()`,
    async githubClaim(id: string) {
      const [row] =
        await client`SELECT kordos_github.execute(${id}, 'claim', NULL, NULL) AS value`;
      return row?.value ? githubExecutionSchema.parse(row.value) : null;
    },
    async githubExecute(
      id: string,
      step: "start" | "complete" | "retry" | "refuse",
      lease: string,
      value?: GitHubRemoteReceipt | { audience: "project" | "private" },
    ) {
      const [row] =
        await client`SELECT kordos_github.execute(${id}, ${step}, ${lease}, ${value ? JSON.stringify(value) : null}::text::jsonb) AS value`;
      return row?.value === true;
    },
    close: () => client.end({ timeout: 3 }),
  };
}
