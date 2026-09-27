import assert from "node:assert/strict";
import { appendFile, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HOST, PORT, startDashboardServer } from "./dashboard-server.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
let baseUrl = "";

function originOf(dashboard) {
  const address = dashboard.server.address();
  if (address === null || typeof address === "string") throw new Error("server is not bound to a TCP port");
  return `http://${HOST}:${address.port}`;
}

function request(path, headers = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest(`${baseUrl}${path}`, { headers }, (response) => {
      response.resume();
      resolveRequest(response);
    });
    req.on("error", rejectRequest);
    req.end();
  });
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  const policy = response.headers.get("content-security-policy");
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
}

test("dashboard server validates hosts, secures local routes, and broadcasts task changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-dashboard-"));
  await copyFile(join(projectRoot, "task-dashboard.html"), join(root, "task-dashboard.html"));
  await writeFile(join(root, "TASKS.md"), "# TASKS\n\n## Fase 0 — Test\n- [ ] **0.1 (S)** Test\n");
  let dashboard;
  try {
    dashboard = await startDashboardServer({ root, port: 0, onError: () => {} });
    baseUrl = originOf(dashboard);
    const port = new URL(dashboard.url).port;
    assert.equal(dashboard.server.address().address, HOST);
    for (const host of [`${HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      assert.equal((await request("/task-dashboard.html", { host })).statusCode, 200, host);
    }
    for (const host of ["attacker.invalid", `attacker.invalid:${port}`, `localhost:${Number(port) + 1}`]) {
      assert.equal((await request("/task-dashboard.html", { host })).statusCode, 421, host);
    }

    const html = await fetch(`${baseUrl}/task-dashboard.html`);
    assert.equal(html.status, 200);
    assertSecurityHeaders(html);
    const htmlText = await html.text();
    assert.match(htmlText, /EventSource/);
    assert.doesNotMatch(htmlText, /innerHTML/);
    assert.doesNotMatch(htmlText, /split\(['"] ['"], 1\)/);
    assert.equal((await fetch(`${baseUrl}/task-dashboard.html/`)).status, 404);
    const tasks = await fetch(`${baseUrl}/TASKS.md`);
    assert.equal(tasks.status, 200);
    assert.match(await tasks.text(), /# TASKS/);
    const api = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(api.status, 200);
    assert.equal((await api.json()).source, "TASKS.md");
    assert.equal((await fetch(`${baseUrl}/api/tasks/`)).status, 404);

    const events = await fetch(`${baseUrl}/events`);
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type"), /^text\/event-stream/);
    assertSecurityHeaders(events);
    assert.equal((await fetch(`${baseUrl}/events/`)).status, 404);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let stream = "";
    const readTasksEvents = async (count) => {
      while ((stream.match(/event: tasks/g) ?? []).length < count) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stream += decoder.decode(chunk.value, { stream: true });
      }
    };
    await readTasksEvents(1);
    await appendFile(join(root, "TASKS.md"), "\n");
    await readTasksEvents(2);
    await reader.cancel();
    assert.match(stream, /event: ready/);
    assert.ok((stream.match(/event: tasks/g) ?? []).length >= 2);
  } finally {
    if (dashboard) {
      await dashboard.close();
      await dashboard.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard server isolates an ephemeral port from a live server on the default port", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-dashboard-"));
  await copyFile(join(projectRoot, "task-dashboard.html"), join(root, "task-dashboard.html"));
  await writeFile(join(root, "TASKS.md"), "# TASKS\n");
  const live = createServer();
  let ownsDefaultPort = true;
  try {
    await new Promise((resolveListen, rejectListen) => {
      live.once("error", rejectListen);
      live.listen(PORT, HOST, resolveListen);
    }).catch((error) => {
      if (error.code !== "EADDRINUSE") throw error;
      ownsDefaultPort = false;
    });
    await assert.rejects(startDashboardServer({ root, onError: () => {} }), { code: "EADDRINUSE" });
    const dashboard = await startDashboardServer({ root, port: 0, onError: () => {} });
    try {
      baseUrl = originOf(dashboard);
      assert.notEqual(dashboard.server.address().port, PORT);
      assert.equal((await request("/api/tasks", { host: `${HOST}:${PORT}` })).statusCode, 421);
      assert.equal((await request("/api/tasks")).statusCode, 200);
    } finally {
      await dashboard.close();
    }
  } finally {
    if (ownsDefaultPort) await new Promise((resolveClose) => live.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});
