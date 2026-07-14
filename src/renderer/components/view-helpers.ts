export type ViewRow = Record<string, unknown>;

export function row(value: unknown): ViewRow {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ViewRow) : {};
}

export function rows(value: unknown): ViewRow[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is ViewRow =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text) : [];
}

export function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

export function short(value: string) {
  return value.length > 21 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
}

export function label(value: string) {
  return LABELS[value] ?? value.replaceAll("_", " ");
}

const LABELS: Record<string, string> = {
  high: "高",
  medium: "中",
  low: "低",
  disputed: "有争议",
  unknown: "未知",
  healthy: "健康",
  degraded: "资料有限",
  needs_review: "待复核",
  insufficient: "资料不足",
  consensus: "多源共识",
  single_source: "单一来源",
  user_opinion: "用户观点",
  inference: "AI 推断",
  conflict: "冲突",
  support: "支持",
  contradict: "反证",
  context: "上下文",
  definition: "定义",
  direct: "直接",
  paraphrase: "转述",
  inferred: "推断",
};
