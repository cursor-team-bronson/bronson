"use client";

import { useMemo } from "react";

type DagNode = {
  id: string;
  dependencies: string[];
  humanGateFrom: string[];
  aiGateFrom: string[];
};

/** Preview-only node inserted between a step and a human-gated dependency. */
type PreviewNode = DagNode & {
  humanReview?: { upstreamId: string; downstreamId: string };
};

function humanReviewNodeId(upstreamId: string, downstreamId: string) {
  return `human__${upstreamId}__${downstreamId}`;
}

/** Inserts a "Human review" box between each human-gated edge and its downstream step. */
function expandHumanReviewNodes(input: DagNode[]): PreviewNode[] {
  const updated = new Map(
    input.map((node) => [
      node.id,
      {
        ...node,
        dependencies: [...node.dependencies],
        humanGateFrom: [...node.humanGateFrom],
        aiGateFrom: [...node.aiGateFrom],
      } satisfies DagNode,
    ])
  );

  const inserted: PreviewNode[] = [];

  for (const src of input) {
    const cur = updated.get(src.id);
    if (!cur) continue;

    for (const upstreamId of src.humanGateFrom ?? []) {
      if (!cur.dependencies.includes(upstreamId)) continue;
      const sid = humanReviewNodeId(upstreamId, src.id);
      inserted.push({
        id: sid,
        dependencies: [upstreamId],
        humanGateFrom: [],
        aiGateFrom: [],
        humanReview: { upstreamId, downstreamId: src.id },
      });
      cur.dependencies = cur.dependencies.filter((d) => d !== upstreamId);
      cur.dependencies.push(sid);
    }
    cur.humanGateFrom = [];
  }

  return [...input.map((n) => updated.get(n.id)! as PreviewNode), ...inserted];
}

type EdgeKind = "default" | "human" | "ai";

export default function DagPreview({ nodes }: { nodes: DagNode[] }) {
  const graph = useMemo(() => {
    const previewNodes = expandHumanReviewNodes(nodes);
    const nodeById = new Map(previewNodes.map((node) => [node.id, node]));
    const memoDepth = new Map<string, number>();
    const stack = new Set<string>();

    const getDepth = (id: string): number => {
      if (memoDepth.has(id)) return memoDepth.get(id) ?? 0;
      if (stack.has(id)) return 0;

      stack.add(id);
      const dependencies = nodeById.get(id)?.dependencies ?? [];
      const depth = dependencies.length
        ? Math.max(
            ...dependencies.map((depId) => (nodeById.has(depId) ? getDepth(depId) + 1 : 1))
          )
        : 0;
      stack.delete(id);
      memoDepth.set(id, depth);
      return depth;
    };

    for (const node of previewNodes) getDepth(node.id);

    const lanes = new Map<number, string[]>();
    for (const node of previewNodes) {
      const depth = memoDepth.get(node.id) ?? 0;
      const lane = lanes.get(depth) ?? [];
      lane.push(node.id);
      lanes.set(depth, lane);
    }

    const layerIndexes = Array.from(lanes.keys()).sort((a, b) => a - b);
    const layerCount = Math.max(layerIndexes.length, 1);
    const maxLaneCount = Math.max(1, ...Array.from(lanes.values()).map((lane) => lane.length));

    const nodeWidth = 180;
    const nodeHeight = 58;
    /** Horizontal gap between sibling nodes on the same row */
    const hGap = 32;
    /** Vertical gap between dependency layers (top → bottom) */
    const vGap = 72;
    /** Used only to place rows; final viewBox is derived from content bbox */
    const layoutWidth = maxLaneCount * nodeWidth + Math.max(0, maxLaneCount - 1) * hGap;
    const margin = 24;

    const nodePositions = new Map<string, { x: number; y: number }>();
    for (const [row, depth] of layerIndexes.entries()) {
      const lane = lanes.get(depth) ?? [];
      const blockWidth = lane.length * nodeWidth + Math.max(0, lane.length - 1) * hGap;
      const xStart = (layoutWidth - blockWidth) / 2 + margin;
      for (const [index, id] of lane.entries()) {
        nodePositions.set(id, {
          x: xStart + index * (nodeWidth + hGap),
          y: margin + row * (nodeHeight + vGap),
        });
      }
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pos of nodePositions.values()) {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + nodeWidth);
      maxY = Math.max(maxY, pos.y + nodeHeight);
    }
    /** Padding so strokes, markers, and vertical beziers stay inside the viewBox */
    const viewPad = 48;
    const hasNodes = Number.isFinite(minX);
    const viewBoxX = hasNodes ? minX - viewPad : 0;
    const viewBoxY = hasNodes ? minY - viewPad : 0;
    const viewBoxW = hasNodes ? Math.max(1, maxX - minX + viewPad * 2) : 200;
    const viewBoxH = hasNodes ? Math.max(1, maxY - minY + viewPad * 2) : 120;

    const edges: Array<{
      key: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
      depId: string;
      nodeId: string;
      kind: EdgeKind;
    }> = [];
    for (const node of previewNodes) {
      const nodePosition = nodePositions.get(node.id);
      if (!nodePosition) continue;
      const aiSet = new Set(node.aiGateFrom ?? []);
      for (const depId of node.dependencies) {
        const depPosition = nodePositions.get(depId);
        if (!depPosition) continue;
        let kind: EdgeKind = "default";
        if (depId.startsWith("human__")) kind = "human";
        else if (aiSet.has(depId)) kind = "ai";
        edges.push({
          key: `${depId}->${node.id}-${kind}`,
          from: {
            x: depPosition.x + nodeWidth / 2,
            y: depPosition.y + nodeHeight,
          },
          to: {
            x: nodePosition.x + nodeWidth / 2,
            y: nodePosition.y,
          },
          depId,
          nodeId: node.id,
          kind,
        });
      }
    }

    return {
      viewBoxX,
      viewBoxY,
      viewBoxW,
      viewBoxH,
      nodeWidth,
      nodeHeight,
      edges,
      nodePositions,
      nodeById,
      previewNodes,
    };
  }, [nodes]);

  return (
    <svg
      viewBox={`${graph.viewBoxX} ${graph.viewBoxY} ${graph.viewBoxW} ${graph.viewBoxH}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full max-h-full w-full max-w-full shrink-0"
      role="img"
      aria-label="Workflow dependency graph"
    >
      <defs>
        <marker
          id="arrow-head-default"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-zinc-500 dark:fill-zinc-400" />
        </marker>
        <marker
          id="arrow-head-human"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-amber-600 dark:fill-amber-400" />
        </marker>
        <marker
          id="arrow-head-ai"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="fill-sky-600 dark:fill-sky-400" />
        </marker>
      </defs>

      {graph.edges.map((edge) => {
        const dy = Math.max(24, (edge.to.y - edge.from.y) * 0.45);
        const curve = `M ${edge.from.x} ${edge.from.y} C ${edge.from.x} ${edge.from.y + dy}, ${edge.to.x} ${
          edge.to.y - dy
        }, ${edge.to.x} ${edge.to.y}`;
        const strokeClass =
          edge.kind === "human"
            ? "fill-none stroke-amber-600 dark:stroke-amber-400"
            : edge.kind === "ai"
              ? "fill-none stroke-sky-600 dark:stroke-sky-400"
              : "fill-none stroke-zinc-400 dark:stroke-zinc-500";
        const marker =
          edge.kind === "human" ? "url(#arrow-head-human)" : edge.kind === "ai" ? "url(#arrow-head-ai)" : "url(#arrow-head-default)";
        return (
          <path
            key={edge.key}
            d={curve}
            className={strokeClass}
            strokeWidth={edge.kind === "default" ? 2 : 2.25}
            markerEnd={marker}
          />
        );
      })}

      {graph.previewNodes.map((node) => {
        const position = graph.nodePositions.get(node.id);
        if (!position) return null;
        const isHumanReview = Boolean(node.humanReview);
        const depsLabel = `deps: ${graph.nodeById.get(node.id)?.dependencies.join(", ") || "none"}`;
        return (
          <g key={node.id} transform={`translate(${position.x}, ${position.y})`}>
            <rect
              width={graph.nodeWidth}
              height={graph.nodeHeight}
              rx={10}
              className={
                isHumanReview
                  ? "fill-amber-50 stroke-amber-400 dark:fill-amber-950/40 dark:stroke-amber-500/80"
                  : "fill-white stroke-zinc-300 dark:fill-zinc-900 dark:stroke-zinc-700"
              }
            />
            <foreignObject
              x={0}
              y={0}
              width={graph.nodeWidth}
              height={graph.nodeHeight}
              className="overflow-hidden rounded-[10px]"
            >
              <div
                className={`flex h-full w-full flex-col items-center justify-center gap-0.5 px-2.5 py-1 text-center ${
                  isHumanReview ? "text-amber-950 dark:text-amber-50" : "text-zinc-900 dark:text-zinc-100"
                }`}
              >
                {isHumanReview && node.humanReview ? (
                  <>
                    <span className="text-[11px] font-semibold leading-tight">Human review</span>
                    <span className="line-clamp-2 w-full max-w-full break-all font-mono text-[9px] leading-snug opacity-90">
                      {`${node.humanReview.upstreamId} → ${node.humanReview.downstreamId}`}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="line-clamp-2 w-full max-w-full break-all font-mono text-[12px] font-semibold leading-tight">
                      {node.id}
                    </span>
                    <span
                      className="line-clamp-2 w-full max-w-full break-all font-mono text-[9px] leading-snug text-zinc-500 dark:text-zinc-400"
                      title={depsLabel}
                    >
                      {depsLabel}
                    </span>
                  </>
                )}
              </div>
            </foreignObject>
          </g>
        );
      })}
    </svg>
  );
}
