import type { WorkFields } from "@kordos/contracts";
import { workLabels } from "../planning/work-editor";

const labels: Record<keyof WorkFields, string> = {
  title: "Title",
  description: "Description",
  kind: "Type",
  status: "Status",
  ownerId: "Owner",
  estimateDays: "Estimate (working days)",
  deadline: "Deadline",
  commitment: "Committed date",
  blockerReason: "Blocker reason",
  blockerOwnerId: "Blocker owner",
  blockerResolution: "Blocker resolution",
};

export function ReviewDiff({
  before,
  after,
  owners = [],
  applied = false,
}: {
  before: WorkFields;
  after: WorkFields;
  owners?: { id: string; name: string }[];
  applied?: boolean;
}) {
  const changed = (Object.keys(labels) as (keyof WorkFields)[]).filter(
    (field) => before[field] !== after[field],
  );
  function value(item: WorkFields, field: keyof WorkFields) {
    if (field === "status") return workLabels[item.status];
    if (field === "ownerId" || field === "blockerOwnerId") {
      return item[field]
        ? (owners.find(({ id }) => id === item[field])?.name ?? item[field])
        : "Unassigned";
    }
    return item[field] ?? "None";
  }
  return changed.length ? (
    <dl className="review-diff">
      {changed.map((field) => (
        <div key={field}>
          <dt>{labels[field]}</dt>
          <dd>
            <span className="review-diff-label">
              {applied ? "Before" : "Current at review"}
            </span>
            <span>{value(before, field)}</span>
          </dd>
          <dd>
            <span className="review-diff-label">
              {applied ? "After" : "Proposed"}
            </span>
            <span>{value(after, field)}</span>
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="planning-help">The field values are identical.</p>
  );
}
