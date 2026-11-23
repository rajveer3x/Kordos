import {
  commentChangeSchema,
  commentFeedSchema,
  presenceSchema,
  type CollaborationScope,
  type Comment,
  type CommentChange,
} from "@kordos/contracts";
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { denied, read } from "../identity/api";

export function useDiscussionLive(
  { workspaceId, projectId, subject: { kind, id } }: CollaborationScope,
  path: string,
  initialCursor: string,
  actorId: string,
  refresh: (accessChanged?: boolean) => void,
) {
  const after = useRef(initialCursor);
  const [presence, setPresence] = useState<Comment["author"][]>([]);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "reconnecting" | "revoked"
  >("connecting");
  const [received, setReceived] = useState(0);

  useEffect(() => {
    const socket = io({
      path: "/realtime",
      transports: ["websocket"],
      autoConnect: false,
      forceNew: true,
      auth: (callback) =>
        callback({
          workspaceId,
          projectId,
          subject: { kind, id },
          cursor: after.current,
        }),
    });
    // Live deliveries can arrive before the HTTP replay finishes. A replay
    // cursor only moves after the server has supplied the ordered batch.
    const liveSeen = new Map<string, string>();
    let buffered = new Map<string, CommentChange>();
    let replay: AbortController | undefined;
    let retryAt = 0;
    let alive = true;
    let caughtUp = false;
    function position(cursor: string) {
      return BigInt(atob(cursor));
    }
    function apply(events: Iterable<CommentChange>, replayed: boolean) {
      let changed = false;
      let newComments = 0;
      for (const event of events) {
        if (
          liveSeen.has(event.id) ||
          position(event.cursor) <= position(after.current)
        )
          continue;
        if (!replayed) liveSeen.set(event.id, event.cursor);
        changed = true;
        if (event.kind === "comment.posted" && event.actorId !== actorId)
          newComments++;
      }
      if (changed) refresh();
      if (newComments) setReceived((count) => count + newComments);
    }
    function revoke() {
      setConnection("revoked");
      setPresence([]);
      refresh(true);
      socket.disconnect();
      alive = false;
    }
    async function catchUp() {
      if (replay || !socket.connected || !alive) return;
      const attempt = new AbortController();
      replay = attempt;
      try {
        let more: boolean;
        do {
          const batch = await read(
            `${path}/events?after=${after.current}`,
            commentFeedSchema,
            attempt.signal,
          );
          if (attempt.signal.aborted) return;
          apply(batch.events, true);
          after.current = batch.events.at(-1)?.cursor ?? after.current;
          more = batch.more;
        } while (more);
        apply(buffered.values(), false);
        buffered = new Map();
        for (const [id, cursor] of liveSeen) {
          if (position(cursor) <= position(after.current)) liveSeen.delete(id);
        }
        caughtUp = true;
        setConnection("live");
      } catch (error) {
        if (attempt.signal.aborted) return;
        if (denied(error)) revoke();
        else setConnection("reconnecting");
      } finally {
        if (replay === attempt) replay = undefined;
      }
    }
    socket.on("connect", () => {
      caughtUp = false;
      socket.emit("discussion:heartbeat");
      void catchUp();
    });
    socket.on("discussion:change", (input: unknown) => {
      const event = commentChangeSchema.safeParse(input);
      if (!event.success) return;
      if (caughtUp) apply([event.data], false);
      else buffered.set(event.data.id, event.data);
    });
    socket.on("discussion:presence", (input: unknown) => {
      const people = presenceSchema.safeParse(input);
      if (people.success) setPresence(people.data);
    });
    socket.on("discussion:access", (change: unknown) => {
      if (change === "revoked") revoke();
      else if (change === "changed") refresh(true);
    });
    socket.on("disconnect", () => {
      replay?.abort();
      replay = undefined;
      caughtUp = false;
      setPresence([]);
      if (alive) setConnection("reconnecting");
    });
    socket.on("connect_error", () => {
      retryAt = Date.now() + 4_000;
      if (alive) {
        refresh();
        setConnection("reconnecting");
      }
    });
    socket.connect();

    const heartbeat = window.setInterval(() => {
      if (!alive) return;
      if (socket.connected) {
        socket.emit("discussion:heartbeat");
        void catchUp();
      } else if (!socket.active && Date.now() >= retryAt) socket.connect();
    }, 4_000);
    return () => {
      alive = false;
      window.clearInterval(heartbeat);
      replay?.abort();
      socket.removeAllListeners().disconnect();
    };
  }, [workspaceId, projectId, kind, id, actorId, path, refresh]);

  return { presence, connection, received };
}
