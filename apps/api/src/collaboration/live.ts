import {
  collaborationCursorSchema,
  collaborationScopeSchema,
  commentChangeSchema,
  presenceSchema,
  type CollaborationScope,
  type Comment,
} from "@kordos/contracts";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { Server, type Socket } from "socket.io";
import {
  decodeCursor,
  publicChange,
  type CollaborationStore,
} from "./routes.js";

const ttl = 15_000;
const handshakeSchema = collaborationScopeSchema.extend({
  cursor: collaborationCursorSchema,
});

type Subscription = {
  actor: string;
  scope: CollaborationScope;
  cursor: string;
  revision: string;
  presence: string;
  room: string;
};

function projectRoom({ workspaceId, projectId }: CollaborationScope) {
  return `project:${workspaceId}:${projectId}`;
}

export function attachCollaboration(
  app: FastifyInstance,
  redis: Redis,
  origin: string,
  store: CollaborationStore,
  actorFromCookieHeader: (header: string) => Promise<string | undefined>,
) {
  const io = new Server(app.server, {
    path: "/realtime",
    transports: ["websocket"],
    serveClient: false,
    maxHttpBufferSize: 4096,
    allowRequest: (request, done) =>
      done(null, request.headers.origin === origin),
  });

  async function sessionActor(socket: Socket) {
    return actorFromCookieHeader(socket.request.headers.cookie ?? "");
  }

  function presenceKey(room: string) {
    return `kordos:presence:${room}`;
  }

  function presenceEntry(socket: Socket, actor: string) {
    return `${actor}:${socket.id}`;
  }

  function heartbeat(socket: Socket, { room, actor }: Subscription) {
    const key = presenceKey(room);
    return redis.eval(
      "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]); return redis.call('PEXPIRE', KEYS[1], ARGV[3])",
      1,
      key,
      Date.now() + ttl,
      presenceEntry(socket, actor),
      ttl,
    );
  }

  async function present(room: string) {
    const key = presenceKey(room);
    const now = Date.now();
    await redis.zremrangebyscore(key, "-inf", now);
    const entries = await redis.zrangebyscore(key, `(${now}`, "+inf");
    return [...new Set(entries.map((entry) => entry.split(":")[0]!))];
  }

  function revoke(socket: Socket) {
    socket.emit("discussion:access", "revoked");
    socket.disconnect(true);
  }

  io.use(async (socket, next) => {
    try {
      const { cursor, ...scope } = handshakeSchema.parse(socket.handshake.auth);
      const actor = await sessionActor(socket);
      const position = decodeCursor(cursor);
      const access = actor && (await store.feed(actor, scope, position));
      if (!access || !actor) return next(new Error("unavailable"));
      const subscription: Subscription = {
        actor,
        scope,
        cursor: position,
        revision: access.revision,
        room: projectRoom(scope),
        presence: "",
      };
      socket.data.subscription = subscription;
      next();
    } catch {
      next(new Error("unavailable"));
    }
  });

  let stopping = false;
  let pumping = false;
  let requested = false;
  async function pump() {
    if (stopping) return;
    requested = true;
    if (pumping) return;
    pumping = true;
    try {
      while (requested && !stopping) {
        requested = false;
        const rooms = new Map<string, Promise<string[]>>();
        const sockets = [...io.sockets.sockets.values()];
        // Leave capacity in the database pool during reconnects and large rooms.
        for (let index = 0; index < sockets.length && !stopping; index += 8) {
          await Promise.all(
            sockets.slice(index, index + 8).map(async (socket) => {
              const subscription: Subscription = socket.data.subscription;
              const { actor, scope, room } = subscription;
              if (!socket.connected || !socket.rooms.has(room)) return;
              try {
                if ((await sessionActor(socket)) !== actor)
                  return revoke(socket);
                let active = rooms.get(room);
                if (!active) {
                  active = present(room);
                  rooms.set(room, active);
                }
                const feed = await store.feed(
                  actor,
                  scope,
                  subscription.cursor,
                  await active,
                );
                if (!socket.connected || stopping) return;
                if (!feed) return revoke(socket);
                if (feed.revision !== subscription.revision) {
                  subscription.revision = feed.revision;
                  socket.emit("discussion:access", "changed");
                }
                const people: Comment["author"][] = presenceSchema.parse(
                  feed.presence,
                );
                const signature = JSON.stringify(people);
                if (signature !== subscription.presence) {
                  subscription.presence = signature;
                  socket.emit("discussion:presence", people);
                }
                for (const event of feed.events) {
                  socket.emit(
                    "discussion:change",
                    commentChangeSchema.parse(publicChange(event)),
                  );
                  subscription.cursor = event.cursor;
                }
                requested ||= feed.more;
              } catch {
                // The next sweep reads the durable feed again after a service interruption.
              }
            }),
          );
        }
      }
    } finally {
      pumping = false;
    }
  }

  io.on("connection", (socket) => {
    const subscription: Subscription = socket.data.subscription;
    const { actor, room } = subscription;
    void socket.join(room);
    socket.on("discussion:heartbeat", () => {
      void (async () => {
        if ((await sessionActor(socket)) !== actor) return revoke(socket);
        if (!socket.connected) return;
        await heartbeat(socket, subscription);
        void pump();
      })().catch(() => undefined);
    });
    socket.on("disconnect", () => {
      void redis
        .zrem(presenceKey(room), presenceEntry(socket, actor))
        .then(() => pump())
        .catch(() => undefined);
    });
    void heartbeat(socket, subscription)
      .catch(() => undefined)
      .finally(() => pump());
  });

  const wake = () => {
    void pump();
  };
  const timer = setInterval(wake, 2_000);
  const listener = store.listen(wake).catch(() => undefined);
  app.addHook("preClose", () => {
    stopping = true;
    clearInterval(timer);
    io.disconnectSockets();
    io.engine.close();
  });
  app.addHook("onClose", async () => {
    await (await listener)?.unlisten();
  });
}
