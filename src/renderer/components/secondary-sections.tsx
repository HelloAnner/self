import { createElement as h } from "react";
import type { PageIrCitation, PageIrComponent } from "../../domains/artifact/index.ts";
import { label, rows, strings, text } from "./view-helpers.ts";

type ComponentProps = {
  component: PageIrComponent;
  citations: Map<string, PageIrCitation>;
};

export function KnowledgeGraph({ component }: ComponentProps) {
  const nodes = rows(component.payload.nodes);
  const edges = rows(component.payload.edges);
  const positions = new Map(
    nodes.map((node, index) => [text(node.id), point(index, nodes.length)]),
  );
  return h(
    "div",
    { className: "graph-wrap" },
    h(
      "svg",
      {
        viewBox: "0 0 900 520",
        role: "img",
        "aria-label": `${nodes.length} 个节点和 ${edges.length} 条关系的局部知识图谱`,
      },
      h(
        "g",
        { className: "edges" },
        edges.map((edge) => {
          const start = positions.get(text(edge.source));
          const end = positions.get(text(edge.target));
          return start && end
            ? h(
                "g",
                { key: text(edge.id) },
                h("line", { x1: start.x, y1: start.y, x2: end.x, y2: end.y }),
                h("text", { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, text(edge.label)),
              )
            : null;
        }),
      ),
      h(
        "g",
        { className: "nodes" },
        nodes.map((node) => {
          const position = positions.get(text(node.id)) ?? { x: 0, y: 0 };
          return h(
            "g",
            { key: text(node.id), transform: `translate(${position.x} ${position.y})` },
            h("circle", { r: 34 }),
            h("text", { textAnchor: "middle", y: 4 }, truncate(text(node.label), 12)),
            h("title", null, `${text(node.label)} · ${text(node.kind)}`),
          );
        }),
      ),
    ),
  );
}

export function Conflicts({ component, citations }: ComponentProps) {
  return h(
    "div",
    { className: "conflict-board" },
    h("p", null, text(component.payload.summary)),
    rows(component.payload.positions).map((position, index) =>
      h(
        "article",
        { key: text(position.conclusion_id) },
        h("span", null, `POSITION ${String(index + 1).padStart(2, "0")}`),
        h("h3", null, text(position.statement)),
        h(CitationLinks, { ids: strings(position.citation_ids), citations }),
      ),
    ),
  );
}

export function KnowledgeGaps({ component }: ComponentProps) {
  return h(
    "div",
    { className: "gap-list" },
    rows(component.payload.items).map((item) =>
      h(
        "article",
        { key: text(item.gap_id) },
        h(
          "span",
          { className: `severity severity-${text(item.severity)}` },
          label(text(item.severity)),
        ),
        h("h3", null, text(item.question)),
        h("p", null, text(item.reason)),
      ),
    ),
  );
}

export function SourceDirectory({ component }: ComponentProps) {
  return h(
    "ul",
    { className: "source-directory" },
    rows(component.payload.sources).map((source, index) =>
      h(
        "li",
        { key: text(source.source_id) },
        h("span", null, String(index + 1).padStart(2, "0")),
        h(
          "div",
          null,
          h("strong", null, text(source.name)),
          h(
            "small",
            null,
            source.logical_path ? text(source.logical_path) : label(text(source.kind)),
          ),
        ),
        h("b", null, `${text(source.citation_count)} 引用`),
      ),
    ),
  );
}

function CitationLinks({
  ids,
  citations,
}: {
  ids: string[];
  citations: Map<string, PageIrCitation>;
}) {
  return h(
    "div",
    { className: "citation-links", "aria-label": "引用" },
    ids.map((id, index) =>
      h(
        "a",
        { href: `#${id}`, key: id, title: citations.get(id)?.sourceName ?? id },
        `[${index + 1}]`,
      ),
    ),
  );
}

function point(index: number, count: number) {
  const angle = (Math.PI * 2 * index) / Math.max(count, 1) - Math.PI / 2;
  const radius = count < 5 ? 150 : 205;
  return { x: 450 + Math.cos(angle) * radius, y: 260 + Math.sin(angle) * radius };
}

function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
