import type { SessionEvent } from "@helm/core";
import { SessionManager } from "./session-manager";

const DEFAULT_PORT = 7878;

/** Starts the Helm HTTP/SSE daemon. */
export function startServer(port = DEFAULT_PORT): Bun.Server<unknown> {
  const manager = new SessionManager();
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 255,
    async fetch(request) {
      try {
        return await route(request, manager);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
  });
}

/** Routes one daemon HTTP request. */
async function route(request: Request, manager: SessionManager): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/config") {
    return json(await manager.getConfig());
  }
  if (request.method === "GET" && url.pathname === "/sessions") {
    return json(manager.list(url.searchParams.get("archived") === "1"));
  }
  if (request.method === "POST" && url.pathname === "/sessions") {
    const body = (await request.json()) as { repo: string; agent: string; prompt?: string };
    return json(await manager.create(body), 201);
  }
  if (request.method === "GET" && url.pathname === "/sessions/events") {
    return sessionEventsStream(manager, Number(url.searchParams.get("after") ?? "0"));
  }
  if (parts[0] === "sessions" && parts[1]) {
    const id = parts[1];
    if (request.method === "GET" && parts.length === 2) {
      const session = manager.get(id);
      if (!session) {
        return json({ error: "Not found" }, 404);
      }
      return json({ session, events: manager.store.listEvents(id) });
    }
    if (request.method === "GET" && parts[2] === "events") {
      return sessionStream(manager, id, Number(url.searchParams.get("after") ?? "0"));
    }
    if (request.method === "POST" && parts[2] === "messages") {
      const body = (await request.json()) as { text: string };
      return json(await manager.send(id, body.text));
    }
    if (request.method === "POST" && parts[2] === "stop") {
      return json(await manager.stop(id));
    }
    if (request.method === "POST" && parts[2] === "archive") {
      return json(await manager.archive(id));
    }
  }

  return json({ error: "Not found" }, 404);
}

/** Creates a JSON response. */
function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: corsHeaders()
  });
}

/** Returns CORS headers for local dashboard access. */
function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*"
  };
}

/** Streams events for all sessions. */
function sessionEventsStream(manager: SessionManager, afterId: number): Response {
  return sse((send) => {
    for (const event of manager.store.listAllEvents(afterId)) {
      send("event", event);
    }
    return manager.bus.subscribe((event) => send(event.type, event.type === "event" ? event.event : event.session));
  });
}

/** Streams events for one session. */
function sessionStream(manager: SessionManager, sessionId: string, afterId: number): Response {
  return sse((send) => {
    for (const event of manager.store.listEvents(sessionId, afterId)) {
      send("event", event);
    }
    return manager.bus.subscribe((event) => {
      if (event.type === "event" && event.event.session_id === sessionId) {
        send("event", event.event);
      }
      if (event.type === "session" && event.session.id === sessionId) {
        send("session", event.session);
      }
    });
  });
}

/** Builds an SSE response with an unsubscribe hook. */
function sse(register: (send: (name: string, value: unknown) => void) => () => void): Response {
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
      ...corsHeaders(),
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream"
    }
  });
}

if (import.meta.main) {
  const port = Number(Bun.env.HELM_PORT ?? DEFAULT_PORT);
  const server = startServer(port);
  console.log(`helm daemon listening on http://${server.hostname}:${server.port}`);
}
