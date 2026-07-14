import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PageIrCitation, PageIrComponent, PageIrV1 } from "../../domains/artifact/index.ts";
import {
  Conflicts,
  KnowledgeGaps,
  KnowledgeGraph,
  SourceDirectory,
} from "./secondary-sections.tsx";
import { label, row, rows, short, strings, text } from "./view-helpers.ts";

type Row = Record<string, unknown>;

export function renderKnowledgeAtlas(
  page: PageIrV1,
  options: { css: string; cssHref?: string },
): string {
  const body = h(Page, { page });
  const markup = renderToStaticMarkup(
    h(
      "html",
      { lang: "zh-CN" },
      h(
        "head",
        null,
        h("meta", { charSet: "utf-8" }),
        h("meta", { name: "viewport", content: "width=device-width,initial-scale=1" }),
        h("meta", { name: "generator", content: "Self Page IR v1" }),
        h("title", null, `${page.topic.title} · Self`),
        options.cssHref
          ? h("link", { rel: "stylesheet", href: options.cssHref })
          : h("style", null, options.css),
      ),
      h("body", null, body),
    ),
  );
  return `<!doctype html>${markup}\n`;
}

function Page({ page }: { page: PageIrV1 }) {
  const citations = new Map(page.citations.map((citation) => [citation.citationId, citation]));
  return h(
    "div",
    { className: "page-shell" },
    h("a", { className: "skip-link", href: "#report" }, "跳到报告"),
    h(Masthead, { page }),
    h(
      "div",
      { className: "report-grid" },
      h(Navigation, { page }),
      h(
        "main",
        { id: "report" },
        page.components.map((component, index) =>
          h(Component, { key: component.key, component, citations, index }),
        ),
      ),
    ),
    h(
      "footer",
      null,
      h("span", null, "SELF / LOCAL EVIDENCE"),
      h("span", null, `BUILD ${short(page.artifact.buildId)}`),
      h("span", null, "此页面完全离线，不访问模型或公网。"),
    ),
  );
}

function Masthead({ page }: { page: PageIrV1 }) {
  return h(
    "header",
    { className: "masthead" },
    h("div", { className: "brand-mark", "aria-hidden": "true" }, "S"),
    h(
      "div",
      null,
      h("p", { className: "brand" }, "SELF / KNOWLEDGE OPERATING SYSTEM"),
      h("p", null, "可重建专题档案"),
    ),
    h(
      "div",
      { className: "build-meta" },
      h("span", null, `SNAPSHOT ${page.topic.snapshotSequence.toString().padStart(2, "0")}`),
      h("span", null, formatDate(page.topic.generatedAt)),
    ),
  );
}

function Navigation({ page }: { page: PageIrV1 }) {
  return h(
    "aside",
    { className: "rail", "aria-label": "报告目录" },
    h("p", { className: "rail-label" }, "INDEX"),
    h(
      "ol",
      null,
      page.components.map((component, index) =>
        h(
          "li",
          { key: component.key },
          h(
            "a",
            { href: `#${component.key}` },
            h("b", null, String(index + 1).padStart(2, "0")),
            component.title,
          ),
        ),
      ),
    ),
    h(
      "div",
      { className: `status-stamp status-${page.topic.healthStatus}` },
      h("span", null, "REPORT HEALTH"),
      h("strong", null, label(page.topic.healthStatus)),
    ),
  );
}

function Component({
  component,
  citations,
  index,
}: {
  component: PageIrComponent;
  citations: Map<string, PageIrCitation>;
  index: number;
}) {
  const props = { component, citations };
  let content: ReactNode;
  if (component.type === "hero") content = h(Hero, props);
  else if (component.type === "conclusion_cards") content = h(ConclusionCards, props);
  else if (component.type === "evidence_blocks") content = h(EvidenceBlocks, props);
  else if (component.type === "timeline") content = h(Timeline, props);
  else if (component.type === "comparison_matrix") content = h(Comparison, props);
  else if (component.type === "knowledge_graph") content = h(KnowledgeGraph, props);
  else if (component.type === "conflicts") content = h(Conflicts, props);
  else if (component.type === "knowledge_gaps") content = h(KnowledgeGaps, props);
  else content = h(SourceDirectory, props);
  return h(
    "section",
    {
      id: component.key,
      className: `report-section section-${component.type}`,
      "data-component": component.type,
    },
    component.type === "hero" ? null : h(SectionHeading, { component, index }),
    content,
  );
}

function SectionHeading({ component, index }: { component: PageIrComponent; index: number }) {
  return h(
    "div",
    { className: "section-heading" },
    h("span", null, String(index + 1).padStart(2, "0")),
    h("h2", null, component.title),
    component.confidenceLevel ? h(Confidence, { value: component.confidenceLevel }) : null,
  );
}

function Hero({ component }: ComponentProps) {
  const payload = component.payload;
  const metrics = row(payload.metrics);
  return h(
    "div",
    { className: "hero" },
    h("p", { className: "eyebrow" }, text(payload.eyebrow)),
    h("h1", null, component.title),
    h("p", { className: "dek" }, text(payload.summary)),
    h(
      "div",
      { className: "scope-note" },
      h("span", null, "SCOPE"),
      h("p", null, text(payload.scope)),
    ),
    h(
      "dl",
      { className: "metric-strip" },
      metric("CLAIMS", metrics.claims),
      metric("SOURCES", metrics.independent_source_lineages),
      metric("EVIDENCE", metrics.evidence_items),
      metric("GAPS", metrics.knowledge_gaps),
    ),
  );
}

function ConclusionCards({ component, citations }: ComponentProps) {
  return h(
    "div",
    null,
    h("p", { className: "section-summary" }, text(component.payload.summary)),
    h(
      "div",
      { className: "card-grid" },
      rows(component.payload.conclusions).map((item, index) =>
        h(
          "article",
          { className: "conclusion-card", key: text(item.conclusion_id) },
          h(
            "div",
            { className: "card-top" },
            h("span", null, `C${String(index + 1).padStart(2, "0")}`),
            h(Confidence, { value: text(item.confidence) }),
          ),
          h("h3", null, text(item.statement)),
          h("p", { className: "claim-type" }, label(text(item.type))),
          h(TrustDetails, { explanation: row(item.explanation) }),
          h(CitationLinks, { ids: strings(item.citation_ids), citations }),
        ),
      ),
    ),
  );
}

function EvidenceBlocks({ component }: ComponentProps) {
  return h(
    "div",
    { className: "evidence-list" },
    rows(component.payload.citations).map((item) =>
      h(
        "details",
        { className: "evidence", id: text(item.citationId), key: text(item.citationId) },
        h(
          "summary",
          null,
          h("span", null, text(item.sourceName)),
          h("small", null, `${label(text(item.role))} · ${label(text(item.directness))}`),
        ),
        h("blockquote", null, text(item.excerpt)),
        h(
          "dl",
          { className: "evidence-chain" },
          chain("Claim", item.claimId),
          chain("Chunk", item.chunkId),
          chain("Revision", item.revisionId),
          chain("Snapshot", item.snapshotId),
          chain("Source", item.sourceId),
        ),
        item.logicalPath ? h("p", { className: "path" }, text(item.logicalPath)) : null,
      ),
    ),
  );
}

function Timeline({ component }: ComponentProps) {
  return h(
    "ol",
    { className: "timeline" },
    rows(component.payload.events).map((event) =>
      h(
        "li",
        { key: text(event.claim_id) },
        h("time", null, [event.from, event.to].filter(Boolean).map(text).join(" — ") || "时间未知"),
        h("p", null, text(event.label)),
        h(Confidence, { value: text(event.confidence) }),
      ),
    ),
  );
}

function Comparison({ component }: ComponentProps) {
  return h(
    "div",
    { className: "table-wrap" },
    h(
      "table",
      null,
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, "类别"),
          h("th", null, "结论"),
          h("th", null, "来源谱系"),
          h("th", null, "可信"),
        ),
      ),
      h(
        "tbody",
        null,
        rows(component.payload.entries).map((entry) =>
          h(
            "tr",
            { key: text(entry.claim_id) },
            h("td", null, label(text(entry.category))),
            h("td", null, text(entry.statement)),
            h("td", null, text(entry.sources)),
            h("td", null, h(Confidence, { value: text(entry.confidence) })),
          ),
        ),
      ),
    ),
  );
}

type ComponentProps = { component: PageIrComponent; citations: Map<string, PageIrCitation> };

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

function TrustDetails({ explanation }: { explanation: Row }) {
  return h(
    "details",
    { className: "trust-details" },
    h("summary", null, "为什么可信"),
    h(
      "dl",
      null,
      Object.entries(explanation)
        .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
        .slice(0, 8)
        .map(([key, value]) =>
          h("div", { key }, h("dt", null, label(key)), h("dd", null, text(value))),
        ),
    ),
  );
}

function Confidence({ value }: { value: string }) {
  return h("span", { className: `confidence confidence-${value}` }, label(value));
}
function metric(name: string, value: unknown) {
  return h("div", { key: name }, h("dt", null, name), h("dd", null, text(value ?? 0)));
}
function chain(name: string, value: unknown) {
  return h(
    "div",
    { key: name },
    h("dt", null, name),
    h("dd", null, h("code", null, short(text(value)))),
  );
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
}
