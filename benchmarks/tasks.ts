export interface BenchmarkTask {
  id: string;
  prompt: string;
  expected: Record<string, string>;
}

function makeTask(
  id: string,
  path: string,
  content: string,
  quote: '"' | "'" = content.includes('"') ? "'" : '"',
): BenchmarkTask {
  if ((quote === '"' && content.includes('"')) || (quote === "'" && content.includes("'"))) {
    throw new Error(`unsupported task content quoting: ${id}`);
  }
  return {
    id,
    prompt: `Write ${path} with content ${quote}${content}${quote}`,
    expected: { [path]: content },
  };
}

export const benchmarkTasks: readonly BenchmarkTask[] = [
  makeTask("ts-constant", "src/constants.ts", "export const retryLimit = 3;"),
  makeTask("py-add", "src/math/add.py", "def add(left, right): return left + right"),
  makeTask("json-record", "fixtures/record.json", '{"name":"sample","count":2}'),
  makeTask("yaml-settings", "fixtures/settings.yaml", "mode: benchmark"),
  makeTask("css-grid", "styles/layout.css", ".grid { display: grid; gap: 8px; }"),
  makeTask("html-main", "pages/index.html", "<main><h1>Benchmark</h1></main>"),
  makeTask("sql-filter", "queries/active.sql", "select id from items where active = 1;"),
  makeTask("slug-regex", "lib/slug.ts", "export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;"),
  makeTask(
    "weekday-check",
    "lib/dates.ts",
    'export function isWeekday(day: string): boolean { return day !== "Saturday" && day !== "Sunday"; }',
  ),
  makeTask("markdown-note", "notes/overview.md", "# Benchmark Overview"),
  makeTask("state-initial", "src/state.ts", "export const initialState = { count: 0 };"),
  makeTask("csv-header", "fixtures/normalize.csv", "name,count"),
  makeTask("env-mode", "settings.env.example", "MODE=local"),
  makeTask("xml-record", "schemas/record.xml", "<record><status>ready</status></record>"),
  makeTask("ignore-list", "templates/ignore.txt", "cache"),
  makeTask(
    "average",
    "src/stats.ts",
    "export const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;",
  ),
  makeTask("badge-component", "ui/Badge.tsx", "export const Badge = () => <span>ready</span>;"),
  makeTask("health-handler", "services/health.go", 'package health; func Status() string { return "ok" }'),
  makeTask("rust-answer", "src/answer.rs", "pub fn answer() -> u32 { 42 }"),
  makeTask("jsonl-event", "fixtures/events.jsonl", '{"event":"ready"}'),
];
