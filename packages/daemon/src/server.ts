import { toPublicSession, toPublicSessionEvent, type SessionEvent } from "@helm/core";
import { createDaemonToken } from "./auth";
import { ArchiveSafetyError, SessionManager } from "./session-manager";

const DEFAULT_PORT = 7878;
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

/** Starts the Helm HTTP/SSE daemon. */
export function startServer(port = DEFAULT_PORT, token = createDaemonToken(), manager = new SessionManager()): Bun.Server<unknown> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 255,
    async fetch(request) {
      try {
        return await route(request, manager, token);
      } catch (error) {
        if (error instanceof ResponseError) {
          return json(request, { error: error.message, code: error.code, details: error.details }, error.status);
        }
        if (error instanceof ArchiveSafetyError) {
          return json(request, { error: error.message, code: error.code, details: error.details }, 409);
        }
        return json(request, { error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
  });
}

/** Routes one daemon HTTP request. */
async function route(request: Request, manager: SessionManager, token: string): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  assertAllowedOrigin(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return json(request, { ok: true });
  }
  assertAuthorized(request, token);
  if (request.method === "GET" && url.pathname === "/auth/check") {
    return json(request, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/config") {
    return json(request, await manager.getPublicConfig());
  }
  if (request.method === "GET" && url.pathname === "/sessions") {
    return json(request, manager.list(url.searchParams.get("archived") === "1").map(toPublicSession));
  }
  if (request.method === "POST" && url.pathname === "/sessions") {
    const body = (await request.json()) as { repo: string; agent: string; prompt?: string };
    return json(request, toPublicSession(await manager.create(body)), 201);
  }
  if (request.method === "GET" && url.pathname === "/sessions/events") {
    return sessionEventsStream(request, manager, Number(url.searchParams.get("after") ?? "0"));
  }
  if (parts[0] === "sessions" && parts[1]) {
    const id = parts[1];
    if (request.method === "GET" && parts.length === 2) {
      const session = manager.get(id);
      if (!session) {
        return json(request, { error: "Not found" }, 404);
      }
      return json(request, { session: toPublicSession(session), events: manager.listEvents(id).map(toPublicSessionEvent) });
    }
    if (request.method === "GET" && parts[2] === "events") {
      return sessionStream(request, manager, id, Number(url.searchParams.get("after") ?? "0"));
    }
    if (request.method === "POST" && parts[2] === "messages") {
      const body = (await request.json()) as { text: string };
      return json(request, toPublicSession(await manager.send(id, body.text)));
    }
    if (request.method === "POST" && parts[2] === "stop") {
      return json(request, toPublicSession(await manager.stop(id)));
    }
    if (request.method === "POST" && parts[2] === "archive") {
      return json(request, toPublicSession(await manager.archive(id, { force: await archiveForce(request, url) })));
    }
  }

  return json(request, { error: "Not found" }, 404);
}

/** Reads the archive force flag from JSON body or legacy query string. */
async function archiveForce(request: Request, url: URL): Promise<boolean> {
  if (url.searchParams.get("force") === "1") {
    return true;
  }
  if (!request.headers.get("Content-Type")?.includes("application/json")) {
    return false;
  }
  const body = (await request.json().catch(() => ({}))) as { force?: boolean };
  return body.force === true;
}

/** Creates a JSON response. */
function json(request: Request, value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: corsHeaders(request)
  });
}

/** Returns CORS headers for local dashboard access. */
function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };
  if (origin && allowedOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** Refuses browser requests from untrusted origins. */
function assertAllowedOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins().includes(origin)) {
    throw new ResponseError(403, "Forbidden origin", "forbidden_origin");
  }
}

/** Refuses requests without the daemon token. */
function assertAuthorized(request: Request, token: string): void {
  const url = new URL(request.url);
  const header = request.headers.get("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (bearer !== token && url.searchParams.get("token") !== token) {
    throw new ResponseError(401, "Unauthorized", "unauthorized");
  }
}

/** Returns configured CORS origins. */
function allowedOrigins(): string[] {
  return (Bun.env.HELM_ALLOWED_ORIGINS?.split(",") ?? DEFAULT_ALLOWED_ORIGINS).map((origin) => origin.trim()).filter(Boolean);
}

class ResponseError extends Error {
  /** Creates a structured HTTP response error. */
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly details?: string
  ) {
    super(message);
  }
}

/** Streams events for all sessions. */
function sessionEventsStream(request: Request, manager: SessionManager, afterId: number): Response {
  return sse(request, (send) => {
    const buffer: SessionEvent[] = [];
    let replaying = true;
    const unsubscribe = manager.subscribe((event) => {
      if (event.type === "event") {
        if (replaying) {
          buffer.push(event.event);
        } else {
          send("event", toPublicSessionEvent(event.event));
        }
      }
      if (event.type === "session") {
        send("session", toPublicSession(event.session));
      }
    });
    let lastSentId = afterId;
    for (const event of manager.listAllEvents(afterId)) {
      send("event", toPublicSessionEvent(event));
      lastSentId = event.id;
    }
    replaying = false;
    for (const event of buffer) {
      if (event.id > lastSentId) {
        send("event", toPublicSessionEvent(event));
      }
    }
    return unsubscribe;
  });
}

/** Streams events for one session. */
function sessionStream(request: Request, manager: SessionManager, sessionId: string, afterId: number): Response {
  return sse(request, (send) => {
    const buffer: SessionEvent[] = [];
    let replaying = true;
    const unsubscribe = manager.subscribe((event) => {
      if (event.type === "event" && event.event.session_id === sessionId) {
        if (replaying) {
          buffer.push(event.event);
        } else {
          send("event", toPublicSessionEvent(event.event));
        }
      }
      if (event.type === "session" && event.session.id === sessionId) {
        send("session", toPublicSession(event.session));
      }
    });
    let lastSentId = afterId;
    for (const event of manager.listEvents(sessionId, afterId)) {
      send("event", toPublicSessionEvent(event));
      lastSentId = event.id;
    }
    replaying = false;
    for (const event of buffer) {
      if (event.id > lastSentId) {
        send("event", toPublicSessionEvent(event));
      }
    }
    return unsubscribe;
  });
}

/** Builds an SSE response with an unsubscribe hook. */
function sse(request: Request, register: (send: (name: string, value: unknown) => void) => () => void): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let interval: Timer | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (name: string, value: unknown) => {
        controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`));
      };
      unsubscribe = register(send);
      interval = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15_000);
    },
    cancel() {
      if (interval) {
        clearInterval(interval);
      }
      unsubscribe();
    }
  });
  return new Response(stream, {
    headers: {
      ...corsHeaders(request),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream"
    }
  });
}

if (import.meta.main) {
  const port = Number(Bun.env.HELM_PORT ?? DEFAULT_PORT);
  const token = createDaemonToken();
  const server = startServer(port, token);
  console.log(`helm daemon listening on http://${server.hostname}:${server.port}`);
  console.log(`helm dashboard URL: http://localhost:3000/?token=${token}`);
}
