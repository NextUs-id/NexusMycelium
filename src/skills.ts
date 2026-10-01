import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ModelMessage, ModelProvider } from "../kernel/src/model.js";

/**
 * Skills loader, Task 5.2.
 *
 * A skill is a directory with one `SKILL.md`: frontmatter (`name` + `description`) plus a body that
 * is read as plain text. Discovery finds them in two scopes — official `skills/` and user
 * `user/skills/` — and refuses rather than repairs anything it cannot trust. An official skill always
 * wins a name fight: a user file with the same name is counted as refused, never loaded in its place.
 *
 * Nothing here executes code, interpolates the body, or touches the network. The body is text for a
 * model to read with the `read_text` tool; the only thing the runtime injects anywhere is the short
 * index (`skillIndexText`), and only when the service is registered.
 */

/** Above this, a skill is a document that needs its own task, not a side lookup. */
export const MAX_SKILL_BYTES = 64_000;
const SKILL_FILE = "SKILL.md";
const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const frontmatterSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(500),
  })
  .strict();

export interface SkillEntry {
  name: string;
  description: string;
  /** Root-relative, forward slashes, so `read_text` can open it unchanged. */
  path: string;
  body: string;
}

export interface RefusedSkill {
  path: string;
  reason: string;
}

export interface SkillDiscovery {
  skills: SkillEntry[];
  refused: RefusedSkill[];
  skipped: { path: string; reason: string }[];
}

function cleanText(value: string): boolean {
  if (value.trim() !== value) return false;
  return ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code < 32 || code === 127;
  });
}

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

/**
 * YAML when the block parses as YAML; a two-line `key: value` fallback when it does not. The
 * fallback exists because a description is prose, and prose has colons: requiring quotes would make
 * every honest author fight the parser. Both paths land in the same strict schema, so the fallback
 * cannot smuggle in a key the strict parse would refuse — any line that is not exactly
 * `name:` or `description:` keeps the whole file refused.
 */
function splitFrontmatter(content: string): { front: unknown; body: string } | undefined {
  if (!content.startsWith("---\n")) return undefined;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const rest = content.slice(end + 4);
  if (rest.length > 0 && !rest.startsWith("\n")) return undefined;
  const block = content.slice(4, end);
  let front: unknown;
  try {
    front = parseYaml(block);
  } catch {
    front = tolerantFrontmatter(block);
  }
  if (front === undefined) return undefined;
  return { front, body: rest.startsWith("\n") ? rest.slice(1) : rest };
}

function tolerantFrontmatter(block: string): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (const line of block.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^(name|description): (.*)$/);
    if (!match || values[match[1] ?? ""] !== undefined) return undefined;
    values[match[1] as string] = match[2] ?? "";
  }
  return values;
}

async function loadEntry(
  root: string,
  relativePath: string,
): Promise<{ entry: SkillEntry } | { refused: RefusedSkill }> {
  const candidate = resolve(root, relativePath);
  if (!inside(root, candidate)) {
    return { refused: { path: relativePath, reason: "path escapes the repo root" } };
  }
  const link = await lstat(candidate).catch(() => undefined);
  if (link === undefined) {
    return { refused: { path: relativePath, reason: "file is missing" } };
  }
  if (link.isSymbolicLink()) {
    return { refused: { path: relativePath, reason: "refuses to read through a symlink" } };
  }
  if (link.size > MAX_SKILL_BYTES) {
    return {
      refused: { path: relativePath, reason: `file exceeds the ${MAX_SKILL_BYTES}-byte limit` },
    };
  }
  const content = await readFile(candidate, "utf8");
  const split = splitFrontmatter(content);
  if (split === undefined) {
    return { refused: { path: relativePath, reason: "missing or malformed frontmatter fences" } };
  }
  const parsed = frontmatterSchema.safeParse(split.front);
  if (!parsed.success) {
    return { refused: { path: relativePath, reason: "frontmatter must carry only name and description" } };
  }
  const directory = relativePath.split("/").at(-2) ?? "";
  if (parsed.data.name !== directory) {
    return {
      refused: {
        path: relativePath,
        reason: `frontmatter name ${JSON.stringify(parsed.data.name)} does not match directory ${JSON.stringify(directory)}`,
      },
    };
  }
  if (!cleanText(parsed.data.name) || !kebab.test(parsed.data.name) || !cleanText(parsed.data.description)) {
    return { refused: { path: relativePath, reason: "name or description is not clean kebab-case text" } };
  }
  return {
    entry: {
      name: parsed.data.name,
      description: parsed.data.description,
      path: relativePath.split(sep).join("/"),
      body: split.body,
    },
  };
}

async function scanScope(
  root: string,
  scope: "skills" | "user/skills",
  result: SkillDiscovery,
  taken: Set<string>,
): Promise<void> {
  const scopeRoot = resolve(root, scope);
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readdir(scopeRoot, { withFileTypes: true });
  } catch {
    // A missing scope is an empty scope, not an error: a fresh checkout has neither.
    return;
  }
  for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const relativePath = `${scope}/${entry.name}/${SKILL_FILE}`;
    if (!entry.isDirectory()) {
      result.skipped.push({ path: relativePath, reason: "not a directory" });
      continue;
    }
    if (!kebab.test(entry.name)) {
      result.skipped.push({ path: relativePath, reason: "directory name is not kebab-case" });
      continue;
    }
    if (taken.has(entry.name)) {
      result.refused.push({ path: relativePath, reason: "shadows an official skill" });
      continue;
    }
    const outcome = await loadEntry(root, relativePath);
    if ("refused" in outcome) {
      result.refused.push(outcome.refused);
      continue;
    }
    taken.add(entry.name);
    result.skills.push(outcome.entry);
  }
}

/** Official first, then user; alphabetical within a scope. A missing scope reads as empty. */
export async function discoverSkills(root: string): Promise<SkillDiscovery> {
  const result: SkillDiscovery = { skills: [], refused: [], skipped: [] };
  const taken = new Set<string>();
  await scanScope(root, "skills", result, taken);
  await scanScope(root, "user/skills", result, taken);
  return result;
}

/** Stable text for a system prompt. Empty when there is nothing to list, so no caller special-cases. */
export function skillIndexText(skills: readonly Pick<SkillEntry, "name" | "description" | "path">[]): string {
  if (skills.length === 0) return "";
  const lines = [...skills]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((skill) => `- ${skill.name} — ${skill.description} (${skill.path})`);
  return `Available skills (read the SKILL.md file with read_text to use one):\n${lines.join("\n")}`;
}

/**
 * The host tells the model what this repo knows.
 *
 * Plugins cannot see a service the host owns — the kernel only exposes a service to the plugin that
 * registered it and to the plugins that require it — so widening that rule to make `skills:index`
 * visible would be a kernel change for a nice-to-have. Instead the host wraps the provider, which is
 * the seam it already uses for tracing: the loop is untouched, and the index is a fact about this
 * checkout that the host already computed.
 *
 * The injection is idempotent and additive. A transcript with no system message is left alone rather
 * than gaining one: a resume must replay what was stored, and the loop's own system prompt is the
 * only place this text belongs.
 */
export function withSystemSkills(model: ModelProvider, index: string): ModelProvider {
  if (index === "") return model;
  return {
    async complete(messages, tools, signal) {
      const first = messages[0];
      if (first?.role !== "system" || first.content.includes("Available skills")) {
        return model.complete(messages, tools, signal);
      }
      const system: ModelMessage = {
        role: "system",
        content: `${first.content}\n\n${index}`,
      };
      return model.complete([system, ...messages.slice(1)], tools, signal);
    },
  };
}
