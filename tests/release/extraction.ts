import { createServer } from "node:http";
import { once } from "node:events";
import { extractBrief } from "../../apps/worker/src/brief-model.js";
import {
  extractMeetingItems,
  splitMeetingText,
} from "../../packages/domain/src/meetings.js";
import type { ModelBrief } from "@kordos/contracts";

const mina = "22000000-0000-4000-8100-000000000101";
const tariq = "22000000-0000-4000-8100-000000000102";
const owners = [
  { id: mina, name: "Mina Rao" },
  { id: tariq, name: "Tariq Chen" },
];
const components = [
  "checkout",
  "billing",
  "identity",
  "inventory",
  "analytics",
];
const subjects = [
  "runbook",
  "gateway",
  "replica",
  "dashboard",
  "snapshot",
  "webhook",
];
const capturedAt = "2026-11-23T11:00:00Z";
const timeZone = "Asia/Kolkata";
const friday = "2026-11-27";

type Task = { key: string; owner: string | null; date: string | null };
type Fields = {
  tasks: string[];
  owners: string[];
  dates: string[];
  dependencies: string[];
};

function fields(tasks: Task[], dependencies: string[] = []): Fields {
  return {
    tasks: tasks.map(({ key }) => key),
    owners: tasks.flatMap(({ key, owner }) =>
      owner ? [key + ":" + owner] : [],
    ),
    dates: tasks.flatMap(({ key, date }) => (date ? [key + ":" + date] : [])),
    dependencies,
  };
}

const corpus = components.flatMap((component) =>
  subjects.map((subject, variant) => {
    const id = component + "-" + subject;
    const prepare = "prepare " + component + " " + subject;
    const verify = "verify " + component + " " + subject;
    const prepareOwner = variant % 3 === 0 ? null : mina;
    const verifyOwner = variant % 2 === 0 ? tariq : null;
    const deadline = variant % 2 === 0 ? friday : null;
    const expected = [
      { key: prepare, owner: prepareOwner, date: deadline },
      { key: verify, owner: verifyOwner, date: null },
    ];
    const dependency = prepare + " -> " + verify;
    const briefLines = [
      prepareOwner
        ? "Mina Rao will " + prepare
        : "The team needs to " + prepare,
      verifyOwner ? "Tariq Chen will " + verify : "The team needs to " + verify,
    ];
    const brief =
      briefLines[0] +
      (deadline ? " by " + deadline : "") +
      ".\n" +
      briefLines[1] +
      ".\nVerification depends on preparation.\n" +
      "Mina Rao and Tariq Chen attended the planning session.";
    const firstMeetingLine =
      variant % 3 === 0
        ? "Action: " + prepare + " by Friday."
        : variant % 3 === 1
          ? "Mina Rao: I'll " + prepare + " by Friday."
          : "Mina Rao will " + prepare + " by Friday.";
    const secondMeetingLine =
      variant % 3 === 2
        ? "We need someone to " + verify + "."
        : verifyOwner
          ? "Tariq Chen will " + verify + "."
          : "Action: " + verify + ".";
    const meeting = [
      firstMeetingLine,
      secondMeetingLine,
      "Verification depends on preparation.",
      "Decision: Use the reviewed change window.",
    ].join("\n");
    return {
      id,
      prepare,
      verify,
      brief,
      meeting,
      expectedBrief: fields(expected, [dependency]),
      expectedMeeting: fields(
        [{ ...expected[0]!, date: friday }, expected[1]!],
        [dependency],
      ),
    };
  }),
);

// The loopback response checks the adapter contract against predictable provider
// output. It reads the supplied text and does not use the scoring labels.
function fixtureResponse(brief: string): ModelBrief {
  const tasks = brief.split("\n").flatMap((quote, index) => {
    const match =
      /^(?:(.+) will|The team needs to) ((?:prepare|verify) [a-z ]+?)(?: by (\d{4}-\d{2}-\d{2}))?\.$/.exec(
        quote,
      );
    if (!match) return [];
    const [, owner, title, date] = match;
    return [
      {
        id: String(index),
        title: title!,
        owner: owner ?? null,
        quote,
        description: null,
        estimateDays: null,
        estimateInferred: false,
        deadline: date ? { kind: "absolute" as const, value: date } : null,
      },
    ];
  });
  const edges =
    brief.includes("Verification depends on preparation.") && tasks.length === 2
      ? [{ predecessorId: tasks[0]!.id, successorId: tasks[1]!.id }]
      : [];
  return { tasks, edges };
}

const server = createServer(async (request, response) => {
  try {
    if (request.url !== "/v1/chat/completions")
      throw new Error("Unexpected route");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const { brief } = JSON.parse(payload.messages[1].content);
    const content = JSON.stringify(fixtureResponse(brief));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content } }],
      }),
    );
  } catch {
    response.writeHead(400).end();
  }
});

function score(items: { expected: Fields; observed: Fields }[]) {
  const totals = Object.fromEntries(
    (["tasks", "owners", "dates", "dependencies"] as const).map((field) => {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const { expected, observed } of items) {
        const matches = new Set(expected[field]);
        for (const value of observed[field]) {
          if (matches.delete(value)) tp++;
          else fp++;
        }
        fn += matches.size;
      }
      return [
        field,
        {
          tp,
          fp,
          fn,
          precision: tp + fp ? tp / (tp + fp) : null,
          recall: tp + fn ? tp / (tp + fn) : null,
        },
      ];
    }),
  );
  return {
    cases: items.length,
    inventedOrUnsupportedAssignees: totals.owners?.fp,
    unsupportedDates: totals.dates?.fp,
    fields: totals,
  };
}

const controlledKey = process.env.RELEASE_GROQ_API_KEY;
const model = controlledKey
  ? (process.env.RELEASE_GROQ_MODEL ?? "openai/gpt-oss-20b")
  : "brief-release-fixture";
const provider = controlledKey ? "groq" : "openai";
let baseUrl = "https://api.groq.com/openai/v1/";
if (!controlledKey) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing loopback port");
  baseUrl = `http://127.0.0.1:${address.port}/v1/`;
}

try {
  const briefs = [];
  const meetings = [];
  for (const fixture of corpus) {
    const result = await extractBrief(
      {
        provider,
        model,
        baseUrl,
        apiKey: controlledKey ?? "release-fixture",
        timeoutMs: 20000,
      },
      {
        title: fixture.id,
        content: fixture.brief,
        owners,
        capturedAt,
        timeZone,
        sourceRevision: 1,
      },
    );
    function taskKey(title: string) {
      const normalized = title.toLowerCase();
      return (
        [fixture.prepare, fixture.verify].find((key) =>
          normalized.includes(key),
        ) ?? normalized
      );
    }
    const tasks = "plan" in result ? result.plan.tasks : [];
    const taskIds = new Map(tasks.map(({ id, title }) => [id, taskKey(title)]));
    briefs.push({
      id: fixture.id,
      text: fixture.brief,
      expected: fixture.expectedBrief,
      observed: fields(
        tasks.map(({ id, ownerId, deadline }) => ({
          key: taskIds.get(id)!,
          owner: ownerId,
          date: deadline,
        })),
        "plan" in result
          ? result.plan.edges.map(
              ({ predecessorId, successorId }) =>
                taskIds.get(predecessorId) + " -> " + taskIds.get(successorId),
            )
          : [],
      ),
      failure: "failure" in result ? result.failure : null,
    });
    const items = extractMeetingItems(
      splitMeetingText(fixture.meeting),
      1,
      capturedAt,
      timeZone,
      owners,
    );
    meetings.push({
      id: fixture.id,
      text: fixture.meeting,
      expected: fixture.expectedMeeting,
      observed: fields(
        items
          .filter(({ kind }) => kind === "action")
          .map(({ title, ownerId, date }) => ({
            key: taskKey(title),
            owner: ownerId,
            date,
          })),
      ),
    });
  }
  console.log(
    JSON.stringify(
      {
        seed: "kordos-release-extraction-22-v1",
        briefProvider: controlledKey ? "Groq test account" : "loopback fixture",
        model,
        brief: {
          ...score(briefs),
          failures: briefs.filter(({ failure }) => failure).length,
        },
        meeting: score(meetings),
        cases: { briefs, meetings },
      },
      null,
      2,
    ),
  );
} finally {
  if (server.listening) {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}
