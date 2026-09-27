import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceInput, TraceStats, TraceWriter, TraceWriterOptions } from "./trace.js";

const defaultConfig = "model:\n  provider: mock\n  model: mock\n";

/** Temp runtime root: `config/default.yaml` official defaults plus a `user/` overlay. */
export async function createRuntimeRoot(userConfig: string, defaults = defaultConfig): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nexus-runtime-"));
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "user"), { recursive: true });
  await writeFile(join(root, "config", "default.yaml"), defaults, "utf8");
  await writeFile(join(root, "user", "config.yaml"), userConfig, "utf8");
  return root;
}

/** Dummy key under the only approved secret scope; never a real credential. */
export async function writeDummyApiKey(root: string, value = "dummy-runtime-key"): Promise<string> {
  const file = join(root, "user", "secrets", "provider.key");
  await mkdir(join(root, "user", "secrets"), { recursive: true });
  await writeFile(file, `${value}\n`, "utf8");
  await chmod(file, 0o600);
  return file;
}

export interface OpenAIFetchProbe {
  body(): unknown;
  authorization(): string | null;
  restore(): void;
}

/** Token counts a gateway reports as-is, so a run can be traced as metered. */
export interface ReportedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** In-process fetch stub: no socket, no real key, records what the provider sent. */
export function stubOpenAIFetch(content = "ok", usage?: ReportedUsage): OpenAIFetchProbe {
  const previous = globalThis.fetch;
  let body: unknown;
  let authorization: string | null = null;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as unknown;
    authorization = new Headers(init?.headers).get("authorization");
    const choices = [{ message: { content: content } }];
    return new Response(JSON.stringify({ choices, ...(usage === undefined ? {} : { usage }) }), {
      status: 200,
    });
  };
  return {
    body: () => body,
    authorization: () => authorization,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

export interface TraceFixture {
  /** The factory shape `createRuntime` accepts, so a test wires exactly what production wires. */
  host: (options?: TraceWriterOptions) => TraceWriter;
  /** Every record the runtime handed over, oldest first. */
  records(): TraceInput[];
  /** Writers asked for: one per runtime, so a second run must not ask again. */
  writers(): number;
  /** Every later append is refused and counted, the way an unwritable path would be. */
  refuse(): void;
  stats(): TraceStats;
}

/**
 * In-memory trace writer: no file, so a test reads exactly what the runtime produced and nothing
 * the real log would have added on the way. Refusal mirrors the real writer — a counted failure
 * and `false`, never a throw — because that is the failure a run actually has to survive.
 */
export function stubTraceHost(): TraceFixture {
  const records: TraceInput[] = [];
  const counters = { enabled: true, written: 0, failures: 0, rotations: 0 };
  let writers = 0;
  let refusing = false;
  return {
    host: (options) => {
      writers += 1;
      return {
        enabled: options?.enabled === true,
        root: "/stub-trace-root",
        async append(record) {
          if (refusing) {
            counters.failures += 1;
            return false;
          }
          records.push(record);
          counters.written += 1;
          return true;
        },
        stats: () => ({ ...counters }),
      };
    },
    records: () => [...records],
    writers: () => writers,
    refuse: () => {
      refusing = true;
    },
    stats: () => ({ ...counters }),
  };
}
