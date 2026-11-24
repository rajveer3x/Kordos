import {
  personSchema,
  searchAnswerSchema,
  searchKinds,
  searchQuerySchema,
  searchResponseSchema,
  type SearchQuery,
  type SearchResult,
} from "@kordos/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { z } from "zod";
import {
  AsyncState,
  Button,
  PageHeading,
  StatusLabel,
} from "../../components/ui";
import { denied, read, request } from "../identity/api";
import { citationPath } from "../knowledge/knowledge-client";
import { planningRefresh, usePlanning } from "../planning/planning-client";
import {
  projectPath,
  workspacePath,
  type Project,
} from "../workspace/workspace-model";
import "./search.css";

const labels = {
  work: "Work item",
  document: "Document",
  decision: "Decision",
  meeting: "Meeting",
  github: "GitHub",
  email: "Shared email",
};

const modes = {
  exact: "Exact ID",
  hybrid: "Keyword and semantic search",
  lexical: "Keyword search",
};

const answerStates = {
  supported: "Answer from the sources",
  conflicting: "Sources disagree",
  insufficient: "Insufficient evidence for an answer",
};

const ownersSchema = z.array(personSchema);
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeZone: "UTC",
});

function ResultLink({ item }: { item: SearchResult }) {
  const { workspace } = usePlanning();
  const project = workspacePath(projectPath(item.projectId), workspace.id);
  const routes = {
    work: `/work/${item.id}`,
    document: `/documents/${item.id}/revisions/${item.revision}`,
    decision: `/documents/decisions/${item.id}`,
    meeting: `/meetings/${item.id}`,
    github: `/documents/sources/${item.id}?revision=${item.revision}`,
    email: `/documents/sources/${item.id}`,
  };
  return (
    <Link
      to={
        item.citation
          ? citationPath(workspace.id, item.citation)
          : project + routes[item.kind]
      }
    >
      {item.title}
    </Link>
  );
}

function Passages({
  items,
  citations = false,
}: {
  items: SearchResult[];
  citations?: boolean;
}) {
  const Heading = citations ? "h4" : "h3";
  return (
    <ul className="search-passages">
      {items.map((item) => (
        <li key={item.kind + item.id}>
          <article>
            <Heading>
              <ResultLink item={item} />
            </Heading>
            <p className="search-meta">
              {labels[item.kind]}
              {item.externalId && " · " + item.externalId} · {item.project}
            </p>
            {item.excerpt && <blockquote>{item.excerpt}</blockquote>}
            <p className="search-meta">
              {item.attribution}
              {item.date && (
                <>
                  {" "}
                  ·{" "}
                  <time dateTime={item.date}>
                    {dateFormat.format(new Date(item.date))}
                  </time>
                </>
              )}
            </p>
          </article>
        </li>
      ))}
    </ul>
  );
}

function Results({ input, params }: { input: SearchQuery; params: string }) {
  const { accessEpoch } = usePlanning();
  return <SearchResults key={accessEpoch} input={input} params={params} />;
}

function SearchResults({
  input,
  params,
}: {
  input: SearchQuery;
  params: string;
}) {
  const { api, key } = usePlanning();
  const results = useQuery({
    queryKey: [...key, "search", params],
    queryFn: ({ signal }) =>
      read(api + "/search?" + params, searchResponseSchema, signal),
    ...planningRefresh,
    retry: false,
  });
  const answer = useMutation({
    mutationFn: () =>
      request(api + "/search/answer", {
        method: "POST",
        body: input,
        schema: searchAnswerSchema,
      }),
    gcTime: 0,
  });
  if (results.isPending)
    return <AsyncState kind="loading" message="Searching the workspace…" />;
  if (results.isError)
    return (
      <AsyncState
        kind="error"
        message={
          denied(results.error)
            ? "This search is unavailable."
            : "Could not search the workspace."
        }
        retry={denied(results.error) ? undefined : () => void results.refetch()}
      />
    );

  const { items, mode, indexing, hasMore } = results.data;
  const currentAnswer = answer.data;
  const showAnswer = currentAnswer?.passages.every((passage) =>
    items.some((item) => JSON.stringify(item) === JSON.stringify(passage)),
  );
  return (
    <section
      className="planning-panel glass-panel search-results"
      aria-labelledby="search-results"
    >
      <div className="search-result-heading">
        <h2 id="search-results">Results</h2>
        <StatusLabel>
          {indexing ? "Indexing updated sources" : modes[mode]}
        </StatusLabel>
      </div>
      <p className="search-meta" role="status">
        {items.length === 0
          ? "No matching sources. Try another phrase or fewer filters."
          : hasMore
            ? "Showing the top 30 matches. Refine your search to narrow the results."
            : `${items.length} matching ${items.length === 1 ? "source" : "sources"}`}
      </p>
      {items.length > 0 && (
        <>
          <div className="search-answer">
            <Button
              variant="secondary"
              disabled={answer.isPending}
              onClick={() => answer.mutate()}
            >
              {answer.isPending
                ? "Reading sources…"
                : answer.isError
                  ? "Retry cited answer"
                  : "Get cited answer"}
            </Button>
            {answer.isPending && (
              <p role="status">Checking the available passages…</p>
            )}
            {answer.isError && (
              <p role="alert">Could not get a cited answer.</p>
            )}
            {currentAnswer && showAnswer && (
              <div className="search-answer-body">
                <h3 role="status">{answerStates[currentAnswer.status]}</h3>
                <Passages items={currentAnswer.passages} citations />
              </div>
            )}
          </div>
          <Passages items={items} />
        </>
      )}
    </section>
  );
}

function SearchForm({
  params,
  projects,
  submit,
}: {
  params: URLSearchParams;
  projects: readonly Project[];
  submit: (value: URLSearchParams) => void;
}) {
  const { api, key } = usePlanning();
  const owner = params.get("owner") ?? "";
  const project = params.get("project") ?? "";
  const type = params.get("type") ?? "";
  const owners = useQuery({
    queryKey: [...key, "search", "owners"],
    queryFn: ({ signal }) => read(api + "/search/owners", ownersSchema, signal),
    ...planningRefresh,
    retry: false,
  });
  return (
    <form
      className="planning-panel glass-panel search-form"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const next = new URLSearchParams();
        for (const [name, entry] of new FormData(event.currentTarget)) {
          if (typeof entry === "string" && entry.trim())
            next.set(name, entry.trim());
        }
        submit(next);
      }}
    >
      <div className="search-text">
        <label>
          Search workspace
          <input
            name="q"
            type="search"
            defaultValue={params.get("q") ?? ""}
            required
            maxLength={240}
            placeholder="Keywords, a question, or a PR ID"
          />
        </label>
        <Button type="submit">Search</Button>
      </div>
      <div className="search-filters">
        <label>
          Project
          <select name="project" defaultValue={project}>
            <option value="">All projects</option>
            {project && !projects.some(({ id }) => id === project) && (
              <option value={project}>Unavailable project</option>
            )}
            {projects.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select name="type" defaultValue={type}>
            <option value="">All types</option>
            {searchKinds.map((kind) => (
              <option key={kind} value={kind}>
                {labels[kind]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Owner
          <select name="owner" defaultValue={owner}>
            <option value="">Any owner</option>
            {owner && !owners.data?.some(({ id }) => id === owner) && (
              <option value={owner}>Selected owner</option>
            )}
            {(!owners.isError ? owners.data : undefined)?.map(
              ({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          From
          <input
            name="from"
            type="date"
            defaultValue={params.get("from") ?? ""}
          />
        </label>
        <label>
          Through
          <input name="to" type="date" defaultValue={params.get("to") ?? ""} />
        </label>
      </div>
      {owners.isError && (
        <p className="search-meta">
          Could not load owners.{" "}
          <Button variant="quiet" onClick={() => void owners.refetch()}>
            Retry
          </Button>
        </p>
      )}
    </form>
  );
}

export default function SearchPage({
  projects,
}: {
  projects: readonly Project[];
}) {
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const target = useRef<HTMLDivElement>(null);
  const parsed = searchQuerySchema.safeParse(Object.fromEntries(params));
  return (
    <div className="standard-page search-page">
      <title>Search · Kordos</title>
      <PageHeading title="Search" />
      <SearchForm
        key={query}
        params={params}
        projects={projects.filter(({ archived }) => !archived)}
        submit={(next) => {
          setParams(next);
          target.current?.focus();
        }}
      />
      <div tabIndex={-1} ref={target} role="region" aria-label="Search results">
        {parsed.success ? (
          <Results key={query} input={parsed.data} params={query} />
        ) : params.has("q") ? (
          <AsyncState
            kind="error"
            message="Check the search phrase and filters, then search again."
          />
        ) : (
          <p className="search-meta">
            Find work, decisions and source passages across this workspace.
          </p>
        )}
      </div>
    </div>
  );
}
