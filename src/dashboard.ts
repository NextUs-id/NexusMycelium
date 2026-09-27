import { type FSWatcher, watch } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const HOST = "127.0.0.1";
export const PORT = 18765;
const TASKS_FILE = "TASKS.md";
const DASHBOARD_FILE = "task-dashboard.html";
const ALLOWED_HOSTS = (port: number): Set<string> =>
  new Set([`${HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`]);
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export interface DashboardHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

function inside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function isAllowedHost(value: string | string[] | undefined, hosts: Set<string>): boolean {
  return typeof value === "string" && hosts.has(value.toLowerCase());
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string,
  headOnly = false,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
    ...SECURITY_HEADERS,
  });
  response.end(headOnly ? undefined : body);
}

function writeEvent(response: ServerResponse, event: string, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function readTasks(
  tasksPath: string,
): Promise<{ source: string; updatedAt: number; markdown: string }> {
  const [markdown, metadata] = await Promise.all([readFile(tasksPath, "utf8"), stat(tasksPath)]);
  return { source: basename(tasksPath), updatedAt: metadata.mtimeMs, markdown };
}

export async function startDashboardServer(options: {
  root: string;
  port?: number;
  tasksFile?: string;
  onError?: (error: unknown) => void;
}): Promise<DashboardHandle> {
  if (typeof options?.root !== "string" || options.root.length === 0) {
    throw new Error("startDashboardServer requires a root path");
  }
  const root = await realpath(resolve(options.root));
  const requestedPort = options.port ?? PORT;
  const requestedTasksFile = options.tasksFile ?? TASKS_FILE;
  const tasksPath = resolve(root, requestedTasksFile);
  if (!inside(root, tasksPath)) throw new Error("dashboard tasks file must stay inside the project root");
  const dashboardPath = resolve(root, DASHBOARD_FILE);
  const [realTasksPath, realDashboardPath] = await Promise.all([
    realpath(tasksPath),
    realpath(dashboardPath),
  ]);
  if (!inside(root, realTasksPath) || !inside(root, realDashboardPath)) {
    throw new Error("dashboard files must stay inside the project root");
  }

  const clients = new Set<ServerResponse>();
  const onError = options.onError ?? ((error: unknown) => console.error("dashboard error:", error));
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let watcherClosed = false;
  let closed = false;
  let boundPort = requestedPort;
  let allowed = ALLOWED_HOSTS(boundPort);
  let watcher: FSWatcher;

  const closeWatcher = (): void => {
    if (watcherClosed) return;
    watcherClosed = true;
    watcher.close();
  };

  const broadcast = async (): Promise<void> => {
    if (closed || clients.size === 0) return;
    try {
      const payload = await readTasks(tasksPath);
      for (const client of clients) writeEvent(client, "tasks", payload);
    } catch (error) {
      onError(error);
    }
  };

  const scheduleBroadcast = (): void => {
    if (closed) return;
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = undefined;
      void broadcast();
    }, 50);
  };

  watcher = watch(dirname(tasksPath), { persistent: false }, (_event, filename) => {
    if (!filename || String(filename) === basename(tasksPath)) scheduleBroadcast();
  });
  watcher.on("error", (error) => {
    if (!closed) onError(error);
  });

  const cleanup = (): void => {
    if (changeTimer) {
      clearTimeout(changeTimer);
      changeTimer = undefined;
    }
    closeWatcher();
    for (const client of clients) {
      if (!client.writableEnded) client.end();
    }
    clients.clear();
  };

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isAllowedHost(request.headers.host, allowed)) {
      send(response, 421, "text/plain; charset=utf-8", "Misdirected Request", request.method === "HEAD");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", `http://${HOST}:${boundPort}`);
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      send(response, 405, "text/plain; charset=utf-8", "Method Not Allowed", request.method === "HEAD");
      return;
    }

    if (requestUrl.pathname === `/${DASHBOARD_FILE}`) {
      const html = await readFile(dashboardPath, "utf8");
      send(response, 200, contentType(DASHBOARD_FILE), html, request.method === "HEAD");
      return;
    }
    if (requestUrl.pathname === `/${TASKS_FILE}`) {
      const markdown = (await readTasks(tasksPath)).markdown;
      send(response, 200, contentType(TASKS_FILE), markdown, request.method === "HEAD");
      return;
    }
    if (requestUrl.pathname === "/api/tasks") {
      const payload = await readTasks(tasksPath);
      send(response, 200, contentType("tasks.json"), JSON.stringify(payload), request.method === "HEAD");
      return;
    }
    if (requestUrl.pathname === "/events") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        send(response, 405, "text/plain; charset=utf-8", "Method Not Allowed", request.method === "HEAD");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...SECURITY_HEADERS,
      });
      response.flushHeaders();
      clients.add(response);
      response.on("close", () => clients.delete(response));
      const payload = await readTasks(tasksPath);
      writeEvent(response, "ready", { source: TASKS_FILE });
      writeEvent(response, "tasks", payload);
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not Found", request.method === "HEAD");
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      onError(error);
      if (!response.headersSent) send(response, 500, "text/plain; charset=utf-8", "Internal Server Error");
      else response.destroy();
    });
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onListenError = (error: Error): void => {
        server.off("listening", onListening);
        rejectListen(error);
      };
      const onListening = (): void => {
        server.off("error", onListenError);
        resolveListen();
      };
      server.once("error", onListenError);
      server.once("listening", onListening);
      server.listen(requestedPort, HOST);
    });
    const address = server.address();
    boundPort = address === null || typeof address === "string" ? requestedPort : address.port;
    allowed = ALLOWED_HOSTS(boundPort);
  } catch (error) {
    closed = true;
    closeWatcher();
    throw error;
  }

  server.once("close", cleanup);

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    cleanup();
    if (!server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
        else resolveClose();
      });
    });
  };

  return { server, url: `http://${HOST}:${boundPort}/task-dashboard.html`, close };
}
