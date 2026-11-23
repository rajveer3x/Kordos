import { createHash, sign } from "node:crypto";
import {
  connectorChangeSchema,
  githubDestinationSchema,
  githubNumberSchema,
  githubRepositorySchema,
  githubRemoteReceiptSchema,
  idSchema,
  type ConnectorChange,
  type GitHubDestination,
} from "@kordos/contracts";
import { z } from "zod";
import { ConnectorFailure } from "./adapter.js";

export type GitHubSettings = {
  appId: string;
  privateKey: string;
  endpoint: string;
  bindings: Record<string, string>;
};

const node = z.object({
  node_id: z.string().min(1).max(200),
  number: githubNumberSchema,
  title: z.string().trim().min(1),
  body: z.string().nullable(),
  updated_at: z.iso.datetime({ offset: true }),
  state: z.enum(["open", "closed"]),
  merged_at: z.iso.datetime({ offset: true }).nullable().optional(),
  draft: z.boolean().optional(),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }).optional(),
  pull_request: z.object({}).optional(),
});
const repository = z.object({
  id: githubNumberSchema,
  full_name: githubRepositorySchema,
  private: z.boolean(),
});
const grant = z.object({
  token: z.string().min(1).max(8192),
  permissions: z.object({
    issues: z.enum(["read", "write"]).optional(),
    pull_requests: z.enum(["read", "write"]).optional(),
  }),
});
const comment = z.object({
  id: githubNumberSchema,
  html_url: z.string(),
  body: z.string(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
  performed_via_github_app: z.object({ id: githubNumberSchema }).nullish(),
});

class GitHubResponseError extends Error {
  constructor(
    readonly status: number,
    readonly limited: boolean,
  ) {
    super("GitHub request failed");
  }
}

function decoded<T>(schema: z.ZodType<T>, data: unknown) {
  const value = schema.safeParse(data);
  if (!value.success) throw new ConnectorFailure("invalid_batch");
  return value.data;
}

function workIds(text: string) {
  const matches = text.matchAll(
    /(?:\bKordos-Work:\s*|\/work\/)([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})(?![\da-f-])/gi,
  );
  const ids = new Set<string>();
  for (const [, match] of matches) {
    const result = idSchema.safeParse(match?.toLowerCase());
    if (result.success) ids.add(result.data);
    if (ids.size === 50) break;
  }
  return [...ids];
}

function normalized(
  item: z.infer<typeof node>,
  repo: string,
  repoId: string,
  kind: GitHubDestination["kind"],
): ConnectorChange {
  const github = {
    repository: repo,
    repositoryId: repoId,
    kind,
    number: item.number,
    nodeId: item.node_id,
    state: item.merged_at ? "merged" : item.state,
    workIds: workIds(item.title + "\n" + (item.body ?? "")),
    ...(kind === "pull"
      ? {
          pull: {
            draft: item.draft ?? false,
            headSha: item.head?.sha ?? null,
            mergedAt: item.merged_at ?? null,
          },
        }
      : {}),
  };
  const body = (item.body ?? "").replaceAll("\0", "").slice(0, 16000);
  const title = item.title.replaceAll("\0", "").slice(0, 240);
  const observedAt = new Date(
    Math.max(
      Date.parse(item.updated_at),
      item.merged_at ? Date.parse(item.merged_at) : 0,
    ),
  ).toISOString();
  const revisionKey = createHash("sha256")
    .update(JSON.stringify([observedAt, title, body, github]))
    .digest("hex");
  return connectorChangeSchema.parse({
    kind: "upsert",
    externalId: `${kind}:${item.number}`,
    revisionKey,
    observedAt,
    title,
    body,
    url: `https://github.com/${repo}/${kind === "pull" ? "pull" : "issues"}/${item.number}`,
    github,
  });
}

export function githubFailure(error: unknown) {
  if (error instanceof ConnectorFailure) return error;
  if (error instanceof GitHubResponseError && !error.limited) {
    if (error.status === 401) return new ConnectorFailure("credential_revoked");
    if ([403, 404, 422].includes(error.status))
      return new ConnectorFailure("scope_unavailable");
    if (error.status < 500) return new ConnectorFailure("invalid_batch");
  }
  return new ConnectorFailure("provider_unavailable");
}

export function githubAdapter(settings: GitHubSettings) {
  const base = new URL(settings.endpoint.replace(/\/$/, "") + "/");
  const jwt = () => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({
        iat: now - 60,
        exp: now + 540,
        iss: settings.appId,
      }),
    ).toString("base64url");
    const message = `${header}.${claims}`;
    return `${message}.${sign("RSA-SHA256", Buffer.from(message), settings.privateKey).toString("base64url")}`;
  };
  let bot: string | undefined;

  async function request(
    path: string,
    token: string,
    within: AbortSignal,
    payload?: object,
  ) {
    const response = await fetch(new URL(path, base), {
      method: payload ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Kordos",
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      redirect: "error",
      signal: AbortSignal.any([within, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GitHubResponseError(
        response.status,
        response.status === 429 ||
          response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after"),
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ConnectorFailure("invalid_batch");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8_000_000) throw new ConnectorFailure("invalid_batch");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new ConnectorFailure("invalid_batch");
    }
    return {
      value,
      next: /;\s*rel="next"/.test(response.headers.get("link") ?? ""),
    };
  }

  async function* pages<T>(
    path: string,
    token: string,
    schema: z.ZodType<T>,
    within: AbortSignal,
  ) {
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 50; page++) {
      const { value, next } = await request(
        `${path}${separator}per_page=100&page=${page}`,
        token,
        within,
      );
      yield decoded(z.array(schema).max(100), value);
      if (!next) return;
    }
    throw new ConnectorFailure("invalid_batch");
  }

  return {
    async connect(
      workspace: string,
      installation: string,
      scope: string,
      write?: GitHubDestination,
    ) {
      if (settings.bindings[installation] !== workspace)
        throw new ConnectorFailure("credential_revoked");
      const repo = decoded(githubRepositorySchema, scope);
      const path = `repos/${repo}`;
      const within = AbortSignal.timeout(55_000);
      const appToken = jwt();
      // Mint an installation token for this repository alone. Verify the
      // repository appears in the installation token's own repository listing.
      const installationGrant = await request(
        `app/installations/${installation}/access_tokens`,
        appToken,
        within,
        {
          repositories: [repo.split("/")[1]],
          permissions: {
            issues: write?.kind === "issue" ? "write" : "read",
            pull_requests: write?.kind === "pull" ? "write" : "read",
          },
        },
      ).catch((error: unknown) => {
        if (error instanceof GitHubResponseError && error.status === 404) {
          throw new ConnectorFailure("credential_revoked");
        }
        throw error;
      });
      const { token, permissions } = decoded(grant, installationGrant.value);
      const { value } = await request(
        "installation/repositories?per_page=100",
        token,
        within,
      );
      const repos = decoded(
        z.object({ repositories: z.array(repository) }),
        value,
      );
      const allowed = repos.repositories.find(
        ({ full_name }) => full_name === repo,
      );
      if (
        !allowed ||
        (write &&
          (write.repositoryId !== String(allowed.id) ||
            permissions[write.kind === "issue" ? "issues" : "pull_requests"] !==
              "write"))
      ) {
        throw new ConnectorFailure("scope_unavailable");
      }
      const repoId = String(allowed.id);
      const itemPath = (kind: GitHubDestination["kind"], number: number) =>
        `${path}/${kind === "pull" ? "pulls" : "issues"}/${number}`;
      const comments = (target: GitHubDestination) =>
        `${path}/issues/${target.number}/comments`;
      const receipt = (
        item: z.infer<typeof comment>,
        target: GitHubDestination,
      ) => {
        const url = `https://github.com/${repo}/${target.kind === "pull" ? "pull" : "issues"}/${target.number}#issuecomment-${item.id}`;
        if (item.html_url.toLowerCase() !== url)
          throw new ConnectorFailure("invalid_batch");
        return githubRemoteReceiptSchema.parse({ id: String(item.id), url });
      };

      return {
        repositoryId: repoId,
        audience: allowed.private ? ("private" as const) : ("project" as const),
        async item(kind: GitHubDestination["kind"], number: number) {
          const { value: data } = await request(
            itemPath(kind, number),
            token,
            within,
          );
          const item = decoded(node, data);
          if (item.number !== number || (kind === "issue" && item.pull_request))
            throw new ConnectorFailure("scope_unavailable");
          return normalized(item, repo, repoId, kind);
        },
        async delivery({
          kind,
          number,
          repositoryId,
        }: Pick<GitHubDestination, "kind" | "number" | "repositoryId">) {
          if (repositoryId !== repoId)
            throw new ConnectorFailure("scope_unavailable");
          try {
            return [await this.item(kind, number)];
          } catch (error) {
            if (!(error instanceof GitHubResponseError) || error.status !== 404)
              throw error;
            // Confirm the repository remains authorized before treating an
            // absent issue or PR as a deletion.
            const result = await request(
              "installation/repositories?per_page=100",
              token,
              within,
            );
            if (
              !decoded(
                z.object({ repositories: z.array(repository) }),
                result.value,
              ).repositories.some(
                ({ id, full_name }) =>
                  String(id) === repoId && full_name === repo,
              )
            )
              throw new ConnectorFailure("scope_unavailable");
            const observedAt = new Date().toISOString();
            return [
              {
                kind: "delete",
                externalId: `${kind}:${number}`,
                revisionKey: `deleted:${observedAt}`,
                observedAt,
              },
            ] satisfies ConnectorChange[];
          }
        },
        async sync(checkpoint: string | null) {
          const now = Date.now();
          const start = new Date(now).toISOString();
          const [lastCheck = "", lastFull = ""] = checkpoint?.split("|") ?? [];
          const parsed = Date.parse(lastCheck);
          const full = Date.parse(lastFull);
          // Keep a short overlap for changes made while pages were being read.
          // A daily complete listing also repairs missed deletion webhooks.
          const cutoff =
            Number.isFinite(parsed) &&
            Number.isFinite(full) &&
            now - full < 86_400_000
              ? new Date(parsed - 120_000).toISOString()
              : null;
          const changes: ConnectorChange[] = [];
          let bytes = 0;
          function add(change: ConnectorChange) {
            bytes += Buffer.byteLength(JSON.stringify(change));
            if (bytes > 12_000_000) throw new ConnectorFailure("invalid_batch");
            changes.push(change);
          }
          const issues = `${path}/issues?state=all&sort=updated&direction=desc${cutoff ? `&since=${encodeURIComponent(cutoff)}` : ""}`;
          for await (const batch of pages(issues, token, node, within)) {
            for (const item of batch)
              if (!item.pull_request)
                add(normalized(item, repo, repoId, "issue"));
          }
          for await (const batch of pages(
            `${path}/pulls?state=all&sort=updated&direction=desc`,
            token,
            node,
            within,
          )) {
            for (const item of batch)
              if (!cutoff || Date.parse(item.updated_at) >= Date.parse(cutoff))
                add(normalized(item, repo, repoId, "pull"));
            if (
              cutoff &&
              batch.some(
                ({ updated_at }) => Date.parse(updated_at) < Date.parse(cutoff),
              )
            )
              break;
          }
          return {
            changes,
            checkpoint: start + "|" + (cutoff ? lastFull : start),
            rebuild: !cutoff,
            repositoryId: repoId,
          };
        },
        async check(target: GitHubDestination) {
          const item = await this.item(target.kind, target.number);
          if (
            item.kind !== "upsert" ||
            !item.github ||
            JSON.stringify(githubDestinationSchema.parse(item.github)) !==
              JSON.stringify(githubDestinationSchema.parse(target))
          ) {
            throw new ConnectorFailure("scope_unavailable");
          }
        },
        async publish(target: GitHubDestination, body: string) {
          const result = await request(comments(target), token, within, {
            body,
          });
          const item = decoded(comment, result.value);
          if (item.body !== body) throw new ConnectorFailure("invalid_batch");
          return receipt(item, target);
        },
        async reconcile(target: GitHubDestination, body: string) {
          let matched;
          for await (const batch of pages(
            `${comments(target)}?since=${encodeURIComponent(new Date(Date.now() - 86400_000).toISOString())}`,
            token,
            comment,
            within,
          )) {
            for (const item of batch) {
              if (item.body !== body) continue;
              if (
                !item.performed_via_github_app &&
                item.user?.type === "Bot" &&
                !bot
              ) {
                const app = await request("app", appToken, within);
                bot =
                  decoded(z.object({ slug: z.string().min(1) }), app.value)
                    .slug + "[bot]";
              }
              if (
                String(item.performed_via_github_app?.id) !== settings.appId &&
                (item.performed_via_github_app ||
                  item.user?.type !== "Bot" ||
                  item.user.login !== bot)
              )
                continue;
              if (matched) return null;
              matched = receipt(item, target);
            }
          }
          return matched ?? null;
        },
      };
    },
  };
}

export type GitHubAdapter = ReturnType<typeof githubAdapter>;

export function githubRefused(error: unknown) {
  return (
    error instanceof GitHubResponseError &&
    !error.limited &&
    [400, 401, 403, 404, 410, 422].includes(error.status)
  );
}
