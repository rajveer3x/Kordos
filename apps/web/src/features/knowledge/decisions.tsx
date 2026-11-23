import {
  decisionCommandSchema,
  decisionDirectorySchema,
  decisionSchema,
  type Citation,
  type Decision,
} from "@kordos/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Button, StatusLabel } from "../../components/ui";
import { denied, read } from "../identity/api";
import {
  planningRefresh,
  usePlanningCommand,
} from "../planning/planning-client";
import { KnowledgeHeading, KnowledgeState } from "./documents";
import { EvidencePassage, useCitation } from "./evidence";
import {
  citationFromLink,
  citationPath,
  useKnowledge,
} from "./knowledge-client";

function useDecisionDirectory() {
  const { api, key } = useKnowledge();
  return useQuery({
    queryKey: [...key, "decisions"],
    queryFn: ({ signal }) =>
      read(api + "/decisions", decisionDirectorySchema, signal),
    ...planningRefresh,
  });
}

export function Decisions() {
  const { base, writable } = useKnowledge();
  const registry = useDecisionDirectory();
  const [search, setSearch] = useSearchParams();
  const filter = search.get("q") ?? "";
  const items = registry.data?.items.filter(({ question }) =>
    question.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  return (
    <section className="planning-panel glass-panel knowledge-panel">
      <Link to={base}>All documents</Link>
      <KnowledgeHeading title="Decision register">
        {writable && (
          <Link className="button button--primary" to={base + "/decisions/new"}>
            Draft decision
          </Link>
        )}
      </KnowledgeHeading>
      {denied(registry.error) || !items ? (
        <KnowledgeState
          name="Decision register"
          unavailable={denied(registry.error)}
          loading={registry.isPending}
          retry={() => void registry.refetch()}
        />
      ) : (
        <>
          {!!registry.data?.items.length && (
            <label className="knowledge-search planning-filters">
              Find a decision
              <input
                type="search"
                value={filter}
                onChange={(event) =>
                  setSearch(
                    event.target.value ? { q: event.target.value } : {},
                    { replace: true },
                  )
                }
              />
            </label>
          )}
          {items.length ? (
            <ul className="knowledge-list">
              {items.map((item) => (
                <li key={item.id}>
                  <Link to={base + "/decisions/" + item.id}>
                    {item.question}
                  </Link>
                  <span className="planning-help">
                    {item.accountable.name} ·{" "}
                    <time dateTime={item.effectiveDate}>
                      {item.effectiveDate}
                    </time>
                  </span>
                  <DecisionStatus item={item} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-message">
              {filter ? "No decisions match your search." : "No decisions yet."}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function DecisionStatus({
  item,
}: {
  item: Pick<Decision, "supersededById" | "confirmedAt">;
}) {
  if (item.supersededById) return <StatusLabel>Superseded</StatusLabel>;
  if (item.confirmedAt)
    return <StatusLabel tone="confirmed">Confirmed</StatusLabel>;
  return <StatusLabel>Draft</StatusLabel>;
}

export function DecisionPage() {
  const { decisionId } = useParams();
  const { api, base, key, writable, details, actorId, workspaceId } =
    useKnowledge();
  const path = api + "/decisions/" + decisionId;
  const command = usePlanningCommand();
  const result = useQuery({
    queryKey: [...key, "decision", decisionId],
    queryFn: ({ signal }) => read(path, decisionSchema, signal),
    ...planningRefresh,
  });
  const item = result.data;
  if (denied(result.error) || !item) {
    return (
      <KnowledgeState
        name="Decision"
        unavailable={denied(result.error)}
        loading={result.isPending}
        retry={() => void result.refetch()}
      />
    );
  }
  const lead = writable && details.role === "lead";
  return (
    <div className="knowledge-stack">
      <section className="planning-panel glass-panel knowledge-panel">
        <Link to={base + "/decisions"}>Decision register</Link>
        <KnowledgeHeading title={item.question}>
          <DecisionStatus item={item} />
        </KnowledgeHeading>
        <dl className="knowledge-facts">
          <div>
            <dt>Accountable person</dt>
            <dd>{item.accountable.name}</dd>
          </div>
          <div>
            <dt>Effective date</dt>
            <dd>
              <time dateTime={item.effectiveDate}>{item.effectiveDate}</time>
            </dd>
          </div>
          {item.supersededOn && (
            <div>
              <dt>Superseded on</dt>
              <dd>
                <time dateTime={item.supersededOn}>{item.supersededOn}</time>
              </dd>
            </div>
          )}
          <div>
            <dt>Drafted by</dt>
            <dd>{item.author.name}</dd>
          </div>
          {item.confirmedBy && item.confirmedAt && (
            <div>
              <dt>Confirmed by</dt>
              <dd>
                {item.confirmedBy.name} ·{" "}
                <time dateTime={item.confirmedAt}>
                  {new Date(item.confirmedAt).toLocaleString()}
                </time>
              </dd>
            </div>
          )}
        </dl>
        <h3>Conclusion</h3>
        <p className="knowledge-text">{item.conclusion}</p>
        <div className="knowledge-actions">
          {item.supersedesId && (
            <Link to={base + "/decisions/" + item.supersedesId}>
              View earlier decision
            </Link>
          )}
          {item.supersededById && (
            <Link to={base + "/decisions/" + item.supersededById}>
              View superseding decision
            </Link>
          )}
          {!item.confirmedAt &&
            writable &&
            (lead || item.author.id === actorId) && (
              <Link to={base + "/decisions/" + item.id + "/edit"}>
                Edit draft
              </Link>
            )}
          {!item.confirmedAt && lead && (
            <Button
              disabled={command.busy}
              onClick={() =>
                void command.save(
                  path,
                  "PATCH",
                  { action: "confirm", expectedVersion: item.version },
                  () => {},
                  "Decision confirmed.",
                )
              }
            >
              Confirm decision
            </Button>
          )}
          {item.confirmedAt && !item.supersededById && writable && (
            <Link
              to={
                base +
                "/decisions/new?" +
                new URLSearchParams({ supersedes: item.id })
              }
            >
              Draft a superseding decision
            </Link>
          )}
        </div>
        {command.error && (
          <p role="alert" className="planning-error">
            {command.error.message}
          </p>
        )}
        <span role="status">{command.notice}</span>
      </section>
      <section className="planning-panel glass-panel knowledge-panel">
        <h2>Evidence</h2>
        {result.isError ? (
          <KnowledgeState
            name="Evidence"
            unavailable={false}
            loading={false}
            retry={() => void result.refetch()}
          />
        ) : item.evidence.length ? (
          <div className="knowledge-stack">
            {item.evidence.map((entry, index) => (
              <EvidencePassage
                key={citationPath(workspaceId, entry.source) + "#" + index}
                entry={entry}
              />
            ))}
          </div>
        ) : (
          <p className="planning-help">No evidence available.</p>
        )}
      </section>
    </div>
  );
}

export function DecisionEditor() {
  const { decisionId } = useParams();
  const { api, key, writable, details, actorId, workspaceId } = useKnowledge();
  const registry = useDecisionDirectory();
  const [search] = useSearchParams();
  const existing = useQuery({
    queryKey: [...key, "decision", decisionId],
    queryFn: ({ signal }) =>
      read(api + "/decisions/" + decisionId, decisionSchema, signal),
    enabled: !!decisionId,
    ...planningRefresh,
  });
  if (
    !writable ||
    denied(existing.error) ||
    denied(registry.error) ||
    existing.data?.confirmedAt ||
    (existing.data &&
      existing.data.author.id !== actorId &&
      details.role !== "lead")
  ) {
    return (
      <KnowledgeState
        name="Decision editing"
        unavailable
        loading={false}
        retry={() => {}}
      />
    );
  }
  if (!registry.data || (decisionId && !existing.data)) {
    return (
      <KnowledgeState
        name="Decision editor"
        unavailable={false}
        loading={registry.isPending || (!!decisionId && existing.isPending)}
        retry={() => {
          void registry.refetch();
          if (decisionId) void existing.refetch();
        }}
      />
    );
  }
  const source = citationFromLink(search.get("source") ?? "", workspaceId);
  return (
    <DecisionForm
      key={decisionId ?? "new"}
      item={existing.data}
      directory={registry.data}
      source={source}
      supersedes={search.get("supersedes") ?? ""}
    />
  );
}

function DecisionForm({
  item,
  directory,
  source,
  supersedes,
}: {
  item?: Decision;
  directory: NonNullable<ReturnType<typeof useDecisionDirectory>["data"]>;
  source?: Citation;
  supersedes: string;
}) {
  const { api, base, workspaceId } = useKnowledge();
  const navigate = useNavigate();
  const command = usePlanningCommand();
  const [initialVersion, setInitialVersion] = useState(item?.version);
  const predecessors = directory.items.filter(
    (entry) => entry.confirmedAt && !entry.supersededById,
  );
  const [fields, setFields] = useState({
    question: item?.question ?? "",
    conclusion: item?.conclusion ?? "",
    accountableId: item?.accountable.id ?? "",
    effectiveDate: item?.effectiveDate ?? "",
    supersedesId:
      item?.supersedesId ??
      predecessors.find(({ id }) => id === supersedes)?.id ??
      "",
  });
  const [sources, setSources] = useState<Citation[]>(
    item?.evidence.map(({ source }) => source) ?? (source ? [source] : []),
  );
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState("");
  const changed = !!item && item.version !== initialVersion;
  function addEvidence() {
    const next = citationFromLink(link, workspaceId);
    if (!next) {
      setLinkError("Paste a Kordos evidence link from this workspace.");
      return;
    }
    const url = citationPath(workspaceId, next);
    if (!sources.some((entry) => citationPath(workspaceId, entry) === url))
      setSources([...sources, next]);
    setLink("");
    setLinkError("");
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (changed) return;
    const data = {
      ...fields,
      evidence: sources,
      supersedesId: fields.supersedesId || null,
    };
    const body = item
      ? { ...data, action: "edit", expectedVersion: initialVersion }
      : { ...data, action: "draft" };
    if (
      !decisionCommandSchema.safeParse({
        ...body,
        mutationId: crypto.randomUUID(),
      }).success
    ) {
      command.invalid(
        "Enter a question, conclusion, accountable person, effective date, and at least one evidence link.",
      );
      return;
    }
    void command.save(
      api + "/decisions" + (item ? "/" + item.id : ""),
      item ? "PATCH" : "POST",
      body,
      (id) => navigate(base + "/decisions/" + id),
      "Decision draft saved.",
    );
  }
  return (
    <section className="planning-panel glass-panel knowledge-panel">
      <Link to={item ? base + "/decisions/" + item.id : base + "/decisions"}>
        {item ? "Back to decision" : "Decision register"}
      </Link>
      <KnowledgeHeading
        title={item ? "Edit decision draft" : "Draft decision"}
      />
      <form className="planning-form" onSubmit={submit}>
        <label>
          Question
          <input
            value={fields.question}
            maxLength={160}
            required
            readOnly={command.busy}
            onChange={(event) =>
              setFields({ ...fields, question: event.target.value })
            }
          />
        </label>
        <label>
          Conclusion
          <textarea
            value={fields.conclusion}
            rows={5}
            maxLength={6000}
            required
            readOnly={command.busy}
            onChange={(event) =>
              setFields({ ...fields, conclusion: event.target.value })
            }
          />
        </label>
        <label>
          Accountable person
          <select
            value={fields.accountableId}
            required
            disabled={command.busy}
            onChange={(event) =>
              setFields({ ...fields, accountableId: event.target.value })
            }
          >
            <option value="">Choose a teammate</option>
            {directory.people.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Effective date
          <input
            type="date"
            value={fields.effectiveDate}
            required
            readOnly={command.busy}
            onChange={(event) =>
              setFields({ ...fields, effectiveDate: event.target.value })
            }
          />
        </label>
        <label>
          Supersedes
          <select
            value={fields.supersedesId}
            disabled={command.busy}
            onChange={(event) =>
              setFields({ ...fields, supersedesId: event.target.value })
            }
          >
            <option value="">No earlier decision</option>
            {predecessors.map(({ id, question }) => (
              <option key={id} value={id}>
                {question}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="knowledge-evidence-fields">
          <legend>Evidence</legend>
          {sources.length > 0 && (
            <ul className="knowledge-list">
              {sources.map((entry) => (
                <li key={citationPath(workspaceId, entry)}>
                  <DraftEvidence source={entry} />
                  <Button
                    variant="quiet"
                    disabled={command.busy}
                    onClick={() =>
                      setSources(sources.filter((source) => source !== entry))
                    }
                  >
                    Remove evidence
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {sources.length < 12 && (
            <>
              <label>
                Evidence link
                <input
                  value={link}
                  readOnly={command.busy}
                  onChange={(event) => setLink(event.target.value)}
                />
              </label>
              <p className="planning-help">
                Open a selected document passage or a comment’s citation to copy
                its link.
              </p>
              <Button
                variant="secondary"
                disabled={!link.trim() || command.busy}
                onClick={addEvidence}
              >
                Add evidence
              </Button>
              {linkError && (
                <p role="alert" className="planning-error">
                  {linkError}
                </p>
              )}
            </>
          )}
        </fieldset>
        {changed && (
          <div className="knowledge-conflict">
            <p>A teammate saved a newer draft. Review it before continuing.</p>
            <strong>{item.question}</strong>
            <p className="knowledge-text">{item.conclusion}</p>
            <Button
              variant="secondary"
              onClick={() => {
                setInitialVersion(item.version);
                command.clearError();
              }}
            >
              Keep my edits on latest draft
            </Button>
          </div>
        )}
        {command.error && (
          <p role="alert" className="planning-error">
            {command.error.message}
          </p>
        )}
        <Button type="submit" disabled={command.busy || changed}>
          {command.busy ? "Saving…" : "Save decision draft"}
        </Button>
        <span role="status">{command.notice}</span>
      </form>
    </section>
  );
}

function DraftEvidence({ source }: { source: Citation }) {
  const citation = useCitation(source);
  if (!citation.data || citation.isError)
    return (
      <span>
        {citation.isPending ? "Checking evidence…" : "Evidence unavailable."}
      </span>
    );
  return <EvidencePassage entry={citation.data} />;
}
