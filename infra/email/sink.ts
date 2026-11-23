import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

type Message = { from: string; to: string[]; subject: string; text: string };
export function emailSink({
  status = () => 200,
}: { status?: (message: Message) => number } = {}) {
  const messages = new Map<string, Message & { id: string; body: string }>();
  const attempts: (Message & { key: string })[] = [];
  const server = createServer(async (request, response) => {
    const json = (code: number, value: unknown) =>
      response
        .writeHead(code, { "Content-Type": "application/json" })
        .end(JSON.stringify(value));

    if (request.method === "GET" && request.url === "/messages") {
      return json(200, [...messages.values()]);
    }
    if (request.method !== "POST" || request.url !== "/emails")
      return json(404, {});
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return json(400, {});
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 64 * 1024) return json(413, {});
      }
      const payload = JSON.parse(body) as Message;
      if (!Array.isArray(payload?.to) || typeof payload?.text !== "string")
        return json(400, {});
      attempts.push({ key, ...payload });
      const previous = messages.get(key);
      if (previous)
        return json(previous.body === body ? 200 : 409, { id: previous.id });
      const code = status(payload);
      if (code !== 200) return json(code, {});
      const id = randomUUID();
      messages.set(key, {
        id,
        body,
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
      });
      return json(200, { id });
    } catch {
      return json(400, {});
    }
  });
  return { server, messages, attempts };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.INBOX_SINK_PORT ?? 4491);
  emailSink().server.listen(port, "127.0.0.1", () => {
    console.log(
      `Kordos email sink listening at http://127.0.0.1:${port}/messages`,
    );
  });
}
