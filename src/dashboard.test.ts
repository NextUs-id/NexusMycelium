import { appendFile, copyFile, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DashboardHandle, HOST, PORT, startDashboardServer } from "./dashboard.js";

let baseUrl = "";

function originOf(handle: DashboardHandle): string {
  const address = handle.server.address();
  if (address === null || typeof address === "string") throw new Error("server is not bound to a TCP port");
  return `http://${HOST}:${address.port}`;
}
const tasks = `# Fase 0 — Fondasi
- [x] **0.1 (S)** Example
`;

function request(path: string, headers: Record<string, string> = {}): Promise<IncomingMessage> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(`${baseUrl}${path}`, { headers }, (response) => {
      response.on("error", rejectRequest);
      response.resume();
      resolveRequest(response);
    });
    request.on("error", rejectRequest);
    request.end();
  });
}

function expectSecurityHeaders(response: IncomingMessage): void {
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["x-frame-options"]).toBe("DENY");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
  expect(response.headers["content-security-policy"]).toMatch(/connect-src 'self'/);
  expect(response.headers["content-security-policy"]).toMatch(/object-src 'none'/);
  expect(response.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
}

async function readTasksEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stream: { value: string },
  count: number,
): Promise<void> {
  const decoder = new TextDecoder();
  while ((stream.value.match(/event: tasks/g) ?? []).length < count) {
    const chunk = await reader.read();
    if (chunk.done) return;
    stream.value += decoder.decode(chunk.value, { stream: true });
  }
}

describe("dashboard server", () => {
  it("secures local routes and keeps the task API and SSE contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-dashboard-"));
    await writeFile(join(root, "TASKS.md"), tasks, "utf8");
    await copyFile(new URL("../task-dashboard.html", import.meta.url), join(root, "task-dashboard.html"));
    const handle = await startDashboardServer({ root, port: 0, onError: () => {} });
    try {
      baseUrl = originOf(handle);
      const port = new URL(handle.url).port;
      expect((handle.server.address() as { address: string }).address).toBe(HOST);
      for (const host of [`${HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
        const response = await request("/task-dashboard.html", { host });
        expect(response.statusCode, host).toBe(200);
        expectSecurityHeaders(response);
      }
      for (const host of ["attacker.invalid", `attacker.invalid:${port}`, `localhost:${Number(port) + 1}`]) {
        expect((await request("/task-dashboard.html", { host })).statusCode, host).toBe(421);
      }

      const dashboard = await fetch(`${baseUrl}/task-dashboard.html`);
      expect(dashboard.status).toBe(200);
      expectSecurityHeaders({
        headers: Object.fromEntries(dashboard.headers),
      } as IncomingMessage);
      const html = await dashboard.text();
      expect(html).toContain("EventSource");
      expect(html).not.toContain("innerHTML");
      expect(html).not.toContain("split(' ', 1)");

      const tasksResponse = await fetch(`${baseUrl}/TASKS.md`);
      expect(tasksResponse.status).toBe(200);
      expect(tasksResponse.headers.get("content-type")).toContain("text/markdown");
      expect(await tasksResponse.text()).toContain("# Fase 0");
      const api = await fetch(`${baseUrl}/api/tasks`);
      expect(api.status).toBe(200);
      expect((await api.json()).source).toBe("TASKS.md");
      expect((await fetch(`${baseUrl}/api/tasks/`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/task-dashboard.html/`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/events/`)).status).toBe(404);

      const events = await fetch(`${baseUrl}/events`);
      expect(events.status).toBe(200);
      expect(events.headers.get("content-type")).toMatch(/^text\/event-stream/);
      expect(events.headers.get("x-content-type-options")).toBe("nosniff");
      expect(events.body).not.toBeNull();
      const reader = events.body?.getReader();
      if (!reader) throw new Error("SSE body is missing");
      const stream = { value: "" };
      await readTasksEvents(reader, stream, 1);
      await appendFile(join(root, "TASKS.md"), "\n", "utf8");
      await readTasksEvents(reader, stream, 2);
      await reader.cancel();
      expect(stream.value).toContain("event: ready");
      expect(stream.value).toContain("0.1");
    } finally {
      await handle.close();
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects path traversal and symlink escapes for both dashboard files", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-dashboard-"));
    const outside = await mkdtemp(join(tmpdir(), "nexus-dashboard-outside-"));
    await writeFile(join(outside, "TASKS.md"), tasks, "utf8");
    await writeFile(join(outside, "task-dashboard.html"), "<!doctype html><title>outside</title>", "utf8");
    await writeFile(join(root, "TASKS.md"), tasks, "utf8");
    await writeFile(join(root, "task-dashboard.html"), "<!doctype html><title>inside</title>", "utf8");
    try {
      await expect(startDashboardServer({ root, tasksFile: "../outside.md" })).rejects.toThrow(
        "inside the project root",
      );
      await unlink(join(root, "TASKS.md"));
      await symlink(join(outside, "TASKS.md"), join(root, "TASKS.md"));
      await expect(startDashboardServer({ root })).rejects.toThrow("inside the project root");
      await unlink(join(root, "task-dashboard.html"));
      await symlink(join(outside, "task-dashboard.html"), join(root, "task-dashboard.html"));
      await expect(startDashboardServer({ root })).rejects.toThrow("inside the project root");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("isolates an ephemeral dashboard while the default port serves traffic", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-dashboard-"));
    await writeFile(join(root, "TASKS.md"), tasks, "utf8");
    await copyFile(new URL("../task-dashboard.html", import.meta.url), join(root, "task-dashboard.html"));
    const live = createServer();
    let ownsDefaultPort = true;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        live.once("error", rejectListen);
        live.listen(PORT, HOST, resolveListen);
      }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        ownsDefaultPort = false;
      });
      await expect(startDashboardServer({ root, onError: () => {} })).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      const handle = await startDashboardServer({ root, port: 0, onError: () => {} });
      try {
        baseUrl = originOf(handle);
        expect((handle.server.address() as { port: number }).port).not.toBe(PORT);
        expect((await request("/api/tasks", { host: `${HOST}:${PORT}` })).statusCode).toBe(421);
        expect((await request("/api/tasks")).statusCode).toBe(200);
      } finally {
        await handle.close();
      }
    } finally {
      if (ownsDefaultPort) await new Promise<void>((resolveClose) => live.close(() => resolveClose()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
