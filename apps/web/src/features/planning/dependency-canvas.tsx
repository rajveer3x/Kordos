import type { Dependency, NodeForecast, ScheduleItem } from "@kordos/contracts";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ProjectDate } from "../workspace/project-view";

export function edgeKey({ predecessorId, successorId }: Dependency) {
  return `${predecessorId}:${successorId}`;
}

type WorkNode = Node<
  {
    item: ScheduleItem;
    finish: string | null;
    provisional: boolean;
    affected: boolean;
  },
  "scheduledWork"
>;

function ScheduledWorkNode({ data }: NodeProps<WorkNode>) {
  return (
    <div className="forecast-node" data-affected={data.affected}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span>{data.item.kind === "milestone" ? "Milestone" : "Task"}</span>
      <strong>{data.item.title}</strong>
      <span>
        <ProjectDate date={data.finish ?? undefined} />
        {data.provisional && " · Uncertain"}
      </span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { scheduledWork: ScheduledWorkNode };

export function DependencyCanvas({
  items,
  forecast,
  edges,
  selection,
  affected,
  path,
  onSelect,
}: {
  items: Map<string, ScheduleItem>;
  forecast: NodeForecast[];
  edges: Dependency[];
  selection: string | undefined;
  affected: Set<string>;
  path: Set<string>;
  onSelect: (id: string) => void;
}) {
  const rows = new Map<number, number>();
  const nodes: WorkNode[] = forecast.map(
    ({ id, depth, finish, provisional }) => {
      const item = items.get(id)!;
      const row = rows.get(depth) ?? 0;
      rows.set(depth, row + 1);
      return {
        id,
        type: "scheduledWork",
        position: { x: depth * 280, y: row * 150 },
        selected: id === selection,
        ariaLabel: item.title,
        data: { item, finish, provisional, affected: affected.has(id) },
      };
    },
  );
  const lines: Edge[] = edges.map((edge) => {
    const id = edgeKey(edge);
    const highlighted = path.has(id);
    const color = highlighted
      ? "var(--forecast-path)"
      : "var(--control-outline)";
    return {
      id,
      source: edge.predecessorId,
      target: edge.successorId,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: {
        stroke: color,
        strokeWidth: highlighted ? 3 : 1.5,
        strokeDasharray: highlighted ? "7 4" : undefined,
      },
      zIndex: highlighted ? 1 : 0,
    };
  });

  return (
    <div
      className="forecast-canvas"
      role="region"
      aria-label="Dependency canvas"
    >
      <ReactFlow
        nodes={nodes}
        edges={lines}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        fitView
        minZoom={0.1}
        maxZoom={1.6}
        fitViewOptions={{ maxZoom: 1 }}
        zoomOnScroll={false}
        panOnDrag
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
