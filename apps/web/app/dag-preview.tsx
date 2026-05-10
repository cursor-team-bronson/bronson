"use client";

import { useEffect } from "react";
import { useNiceDag } from "@ebay/nice-dag-react";

type DagNode = {
  id: string;
  dependencies: string[];
};

export default function DagPreview({ nodes }: { nodes: DagNode[] }) {
  const { niceDagEl, render, reset } = useNiceDag({
    initNodes: nodes,
    editable: false,
    graphLabel: { rankdir: "TB", ranksep: 40, nodesep: 30 },
    getNodeSize: () => ({ width: 210, height: 58 }),
    renderNode: ({ node }) =>
      (
        <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
          <div className="font-semibold">{node.id}</div>
          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            deps: {(node.dependencies ?? []).join(", ") || "none"}
          </div>
        </div>
      ) as any,
  });

  useEffect(() => {
    reset();
  }, [nodes, reset]);

  return (
    <div ref={niceDagEl} className="h-full w-full">
      {render()}
    </div>
  );
}
