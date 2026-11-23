import {
  ArrowRight,
  CalendarDays,
  ChevronRight,
  FileText,
  Plus,
  TrendingUp,
  UserRound,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useOutletContext,
  useParams,
} from "react-router";
import { GlassArtwork } from "../../components/glass-artwork";
import { Sheet } from "../../components/sheet";
import { Button, PageHeading, StatusLabel } from "../../components/ui";
import {
  evidencePath,
  projectDestinations,
  projectPath,
  workspacePath,
  type Evidence,
  type Project,
  type ProjectDestination,
  type Workspace,
} from "./workspace-model";

const dateFormat = new Intl.DateTimeFormat("en", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function ProjectDate({ date }: { date?: string }) {
  return date ? (
    <time dateTime={date}>{dateFormat.format(new Date(date))}</time>
  ) : (
    <span className="unassigned">Not set</span>
  );
}

export function Breadcrumbs({ current }: { current: string }) {
  const { workspaceId } = useParams();
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <Link to={workspacePath("/projects", workspaceId)}>Projects</Link>
      <ChevronRight size={14} aria-hidden="true" />
      <span aria-current="page">{current}</span>
    </nav>
  );
}

function ProjectTabs({ project }: { project: Project }) {
  const { workspaceId } = useParams();
  return (
    <nav className="project-tabs glass-panel" aria-label="Project">
      {projectDestinations.map(({ id, label }) => (
        <NavLink
          key={id}
          to={workspacePath(projectPath(project.id, id), workspaceId)}
          end={id === "overview"}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function ProjectHeader({
  project,
  action,
}: {
  project: Project;
  action?: ReactNode;
}) {
  return (
    <header>
      <Breadcrumbs current={project.name} />
      <div className="project-heading glass-panel glass-panel--blur">
        <div className="project-heading__content">
          <PageHeading
            title={project.name}
            description={project.description}
            display
          />
          {action}
        </div>
        <GlassArtwork />
      </div>
      <ProjectTabs project={project} />
    </header>
  );
}

type ProjectSheet =
  { kind: "evidence"; source: Evidence } | { kind: "brief" } | { kind: "task" };

type ProjectContext = {
  project: Project;
  featuredEvidence?: Evidence;
  show: (opener: HTMLElement, sheet: ProjectSheet) => void;
};

export function ProjectView({ workspace }: { workspace: Workspace }) {
  const { projectId, workspaceId } = useParams();
  const project = workspace.projects.find(({ id }) => id === projectId);

  if (!project) {
    return (
      <div className="standard-page">
        <Breadcrumbs current="Project unavailable" />
        <PageHeading
          title="Project unavailable"
          description="Check the link or choose a project you can access."
        />
        <Link
          className="button button--secondary"
          to={workspacePath("/projects", workspaceId)}
        >
          Go to projects
        </Link>
      </div>
    );
  }

  return <ProjectLayout key={project.id} project={project} />;
}

function ProjectLayout({ project }: { project: Project }) {
  const [dialog, setDialog] = useState<{
    opener: HTMLElement;
    sheet: ProjectSheet;
  }>();
  const featuredEvidence = project.signals.find(
    ({ evidence }) => evidence,
  )?.evidence;
  const show: ProjectContext["show"] = (opener, sheet) =>
    setDialog({ opener, sheet });
  const action = featuredEvidence ? (
    <Button
      onClick={(event) =>
        show(event.currentTarget, {
          kind: "evidence",
          source: featuredEvidence,
        })
      }
      aria-haspopup="dialog"
    >
      <FileText size={16} aria-hidden="true" /> View evidence
    </Button>
  ) : (
    <Button
      onClick={(event) => show(event.currentTarget, { kind: "brief" })}
      aria-haspopup="dialog"
    >
      <Plus size={17} aria-hidden="true" /> Add a brief
    </Button>
  );

  return (
    <div className="project-page">
      <ProjectHeader project={project} action={action} />
      <Outlet
        context={{ project, featuredEvidence, show } satisfies ProjectContext}
      />
      {dialog && (
        <Sheet
          opener={dialog.opener}
          title={
            dialog.sheet.kind === "evidence"
              ? "Evidence"
              : dialog.sheet.kind === "brief"
                ? "Add a brief"
                : "Create task"
          }
          onDismiss={() => setDialog(undefined)}
        >
          {(dismiss) =>
            dialog.sheet.kind === "evidence" ? (
              <SourcePassage
                source={dialog.sheet.source}
                projectId={project.id}
                onNavigate={dismiss}
              />
            ) : (
              <p className="sheet-message">
                {dialog.sheet.kind === "brief"
                  ? "Brief uploads are not available yet."
                  : "Task creation is not available yet."}
              </p>
            )
          }
        </Sheet>
      )}
    </div>
  );
}

export function DateComparison({ project }: { project: Project }) {
  return (
    <dl className="project-facts">
      <div className="glass-panel">
        <dt>
          <CalendarDays size={16} aria-hidden="true" /> Committed date
        </dt>
        <dd>
          <ProjectDate date={project.commitment} />
        </dd>
      </div>
      <div className="glass-panel">
        <dt>
          <TrendingUp size={16} aria-hidden="true" /> Forecast
        </dt>
        <dd>
          <ProjectDate date={project.forecast} />
        </dd>
      </div>
      <div className="glass-panel">
        <dt>
          <UserRound size={16} aria-hidden="true" /> Accountable lead
        </dt>
        <dd>
          {project.lead ?? <span className="unassigned">Unassigned</span>}
        </dd>
      </div>
    </dl>
  );
}

function SourcePassage({
  source,
  projectId,
  onNavigate,
}: {
  source: Evidence;
  projectId?: string;
  onNavigate?: () => void;
}) {
  const { workspaceId } = useParams();
  return (
    <div className="source-passage glass-panel">
      <div className="source-passage__type">
        <FileText size={16} aria-hidden="true" /> {source.kind}
      </div>
      <p className="source-passage__title">{source.title}</p>
      <p className="source-passage__byline">
        {source.author} <span aria-hidden="true">·</span>{" "}
        <ProjectDate date={source.date} />
      </p>
      <blockquote>{source.excerpt}</blockquote>
      {projectId && (
        <Link
          className="source-link"
          to={workspacePath(evidencePath(projectId, source.id), workspaceId)}
          onClick={onNavigate}
        >
          Open source
        </Link>
      )}
    </div>
  );
}

export function ProjectOverview() {
  const { project, featuredEvidence, show } =
    useOutletContext<ProjectContext>();

  return (
    <>
      <title>{`${project.name} · Kordos`}</title>
      <DateComparison project={project} />
      <div className="overview-grid">
        <section aria-labelledby="signals-title">
          <div className="section-title">
            <h2 id="signals-title">Decisions and risks</h2>
          </div>
          {project.signals.length ? (
            <ol className="signal-list glass-panel">
              {project.signals.map((signal) => (
                <li key={signal.id}>
                  <div className="signal-row">
                    <div className="signal-copy">
                      <StatusLabel tone={signal.tone}>
                        {signal.status}
                      </StatusLabel>
                      <h3>{signal.title}</h3>
                      <p>{signal.description}</p>
                    </div>
                    {signal.evidence && (
                      <Button
                        variant="icon"
                        aria-label={`View evidence for ${signal.title}`}
                        aria-haspopup="dialog"
                        onClick={(event) => {
                          if (signal.evidence)
                            show(event.currentTarget, {
                              kind: "evidence",
                              source: signal.evidence,
                            });
                        }}
                      >
                        <FileText size={18} aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty-project glass-panel">
              <span className="empty-project__icon">
                <FileText size={22} aria-hidden="true" />
              </span>
              <h3>Start with a brief or a task</h3>
              <p>
                Capture the project goal in a brief, or create the first piece
                of work.
              </p>
              <div className="empty-project__actions">
                <Button
                  variant="secondary"
                  aria-haspopup="dialog"
                  onClick={(event) =>
                    show(event.currentTarget, { kind: "brief" })
                  }
                >
                  Add a brief
                </Button>
                <Button
                  variant="quiet"
                  aria-haspopup="dialog"
                  onClick={(event) =>
                    show(event.currentTarget, { kind: "task" })
                  }
                >
                  Create task
                </Button>
              </div>
            </div>
          )}
        </section>
        {featuredEvidence && (
          <aside className="evidence-preview" aria-labelledby="evidence-title">
            <h2 id="evidence-title">Evidence</h2>
            <SourcePassage source={featuredEvidence} projectId={project.id} />
          </aside>
        )}
      </div>
    </>
  );
}

export function ProjectSection({
  destination,
}: {
  destination: ProjectDestination;
}) {
  const { project } = useOutletContext<ProjectContext>();
  const { sourceId, workspaceId } = useParams();
  const sources = new Map(
    project.signals.flatMap(({ evidence }) =>
      evidence ? [[evidence.id, evidence] as const] : [],
    ),
  );
  const source = sourceId && sources.get(sourceId);

  return (
    <section
      className="project-section"
      aria-labelledby="project-section-title"
    >
      <title>{`${destination.label} · ${project.name} · Kordos`}</title>
      <h2 id="project-section-title">
        {source ? source.title : destination.label}
      </h2>
      {workspaceId && destination.id === "meetings" && (
        <Link
          to={workspacePath(
            projectPath(project.id, "documents") + "/decisions",
            workspaceId,
          )}
        >
          Decision register
        </Link>
      )}
      {source ? (
        <SourcePassage source={source} />
      ) : sourceId ? (
        <p className="empty-message">
          This source is unavailable in this project.
        </p>
      ) : destination.id === "documents" && sources.size ? (
        <ul className="destination-list">
          {[...sources.values()].map((item) => (
            <li key={item.id}>
              <Link
                to={workspacePath(
                  evidencePath(project.id, item.id),
                  workspaceId,
                )}
              >
                {item.title} <ArrowRight size={17} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-message">{destination.empty}</p>
      )}
    </section>
  );
}
