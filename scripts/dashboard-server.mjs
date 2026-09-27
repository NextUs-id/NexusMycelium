import { watch } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST = "127.0.0.1";
export const PORT = 18765;
const TASKS_FILE = "TASKS.md";
const DASHBOARD_FILE = "task-dashboard.html";
const CHANGE_DELAY_MS = 50;
const allowedHosts = (port) => new Set([`${HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`]);
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function inside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function contentType(path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function isAllowedHost(value, hosts) {
  return typeof value === "string" && hosts.has(value.toLowerCase());
}

function send(response, status, type, body, headOnly = false, headers = {}) {
  response.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
    ...SECURITY_HEADERS,
  });
  response.end(headOnly ? undefined : body);
}

function writeEvent(response, event, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function parseArgs(argv) {
  let root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--root requires a value");
      root = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--root=")) {
      root = argument.slice("--root=".length);
      if (!root) throw new Error("--root requires a value");
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return { root: resolve(root), help };
}

const helpText = `NexusMycelium dashboard server

Usage:
  node scripts/dashboard-server.mjs [--root PATH]

Serves http://127.0.0.1:18765/task-dashboard.html.
`;

export async function startDashboardServer(options = {}) {
  if (typeof options?.root !== "string" || options.root.length === 0) {
    throw new Error("startDashboardServer requires a root path");
  }
  const root = await realpath(resolve(options.root));
  const requestedPort = options.port ?? PORT;
  const tasksPath = resolve(root, TASKS_FILE);
  const dashboardPath = resolve(root, DASHBOARD_FILE);
  const [realTasksPath, realDashboardPath] = await Promise.all([
    realpath(tasksPath),
    realpath(dashboardPath),
  ]);
  if (!inside(root, realTasksPath) || !inside(root, realDashboardPath)) {
    throw new Error("dashboard files must stay inside the project root");
  }

  const clients = new Set();
  const onError = options.onError ?? ((error) => console.error("dashboard error:", error));
  let changeTimer;
  let watcherClosed = false;
  let closed = false;
  let boundPort = requestedPort;
  let allowed = allowedHosts(boundPort);

  const readTasks = async () => {
    const [markdown, metadata] = await Promise.all([readFile(tasksPath, "utf8"), stat(tasksPath)]);
    return { source: TASKS_FILE, updatedAt: metadata.mtimeMs, markdown };
  };

  const broadcast = async () => {
    if (closed || clients.size === 0) return;
    try {
      const payload = await readTasks();
      for (const client of clients) writeEvent(client, "tasks", payload);
    } catch (error) {
      onError(error);
    }
  };

  const scheduleBroadcast = () => {
    if (closed) return;
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = undefined;
      void broadcast();
    }, CHANGE_DELAY_MS);
  };

  let watcher;
  const closeWatcher = () => {
    if (watcherClosed) return;
    watcherClosed = true;
    watcher.close();
  };
  watcher = watch(dirname(tasksPath), { persistent: false }, (_event, filename) => {
    if (!filename || String(filename) === basename(tasksPath)) scheduleBroadcast();
  });
  watcher.on("error", (error) => {
    if (!closed) onError(error);
  });

  const handleRequest = async (request, response) => {
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
      const markdown = await readTasks().then((payload) => payload.markdown);
      send(response, 200, contentType(TASKS_FILE), markdown, request.method === "HEAD");
      return;
    }
    if (requestUrl.pathname === "/api/tasks") {
      const payload = await readTasks();
      send(response, 200, contentType("tasks.json"), JSON.stringify(payload), request.method === "HEAD");
      return;
    }
    if (requestUrl.pathname === "/events") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        send(response, 405, "text/plain; charset=utf-8", "Method Not Allowed");
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
      const payload = await readTasks();
      writeEvent(response, "ready", { source: TASKS_FILE });
      writeEvent(response, "tasks", payload);
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not Found", request.method === "HEAD");
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      onError(error);
      if (!response.headersSent) send(response, 500, "text/plain; charset=utf-8", "Internal Server Error");
      else response.destroy();
    });
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      const onListenError = (error) => {
        server.off("listening", onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off("error", onListenError);
        resolveListen();
      };
      server.once("error", onListenError);
      server.once("listening", onListening);
      server.listen(requestedPort, HOST);
    });
    const address = server.address();
    boundPort = address === null || typeof address === "string" ? requestedPort : address.port;
    allowed = allowedHosts(boundPort);
  } catch (error) {
    closeWatcher();
    throw error;
  }

  const cleanup = () => {
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
  server.once("close", cleanup);

  const close = async () => {
    if (closed) return;
    closed = true;
    cleanup();
    if (!server.listening) return;
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
        else resolveClose();
      });
    });
  };

  return { server, url: `http://${HOST}:${boundPort}/task-dashboard.html`, close };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText);
    return 0;
  }
  const dashboard = await startDashboardServer({ root: options.root });
  process.stdout.write(`Dashboard ready: ${dashboard.url}\n`);
  return new Promise((resolveExit) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      void dashboard.close().then(
        () => resolveExit(0),
        (error) => {
          console.error(error instanceof Error ? error.message : String(error));
          resolveExit(1);
        },
      );
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
