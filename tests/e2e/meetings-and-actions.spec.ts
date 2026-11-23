import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  approvalQueue,
  decisionSchema,
  meetingDetailSchema,
  meetingQueue,
  proposalDetailSchema,
  resolvedCitationSchema,
  reviewResponseSchema,
  workFieldsSchema,
  workItemSchema,
  workPageSchema,
} from "@kordos/contracts";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import postgres from "postgres";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

function account(name: string) {
  return {
    name,
    email: `${name.toLowerCase()}-${randomUUID()}@example.test`,
    email_verified: true,
  };
}
function wave() {
  const bytes = Buffer.alloc(44 + 160000);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

const providerSegments = [
  {
    start: 0,
    end: 2,
    text: "Question: Which pilot group goes first?",
    speaker: "Speaker A",
  },
  { start: 3, end: 5, text: "Ask Maya about rollout.", speaker: "Speaker A" },
  {
    start: 5,
    end: 7,
    text: "Decision: Ship the pilot in two phases.",
    speaker: "Speaker B",
  },
  { start: 7, end: 9, text: "I’ll send the release checklist Thursday." },
];

test("meetings preserve exact recording evidence and approved follow-up across reprocessing and removal", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  if (
    !baseURL ||
    !process.env.DATABASE_URL ||
    !process.env.REDIS_URL ||
    !process.env.MIGRATION_DATABASE_URL
  ) {
    throw new Error("Set the browser, database and Redis URLs.");
  }
  const lead = account("Lina");
  const maya = account("Maya");
  const stopOidc = await startOidcFixture({ lead, maya }, baseURL);
  let transcriptionCalls = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const multipart = Buffer.concat(chunks).toString("latin1");
      if (
        request.url !== "/v1/audio/transcriptions" ||
        request.headers.authorization !== "Bearer test-brief-key" ||
        !multipart.includes("diarized_json") ||
        !multipart.includes("recording.wav") ||
        !multipart.includes("RIFF")
      ) {
        response.writeHead(400).end();
        return;
      }
      transcriptionCalls++;
      if (transcriptionCalls === 1) return;
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ segments: providerSegments }));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      Number(process.env.TEST_BRIEF_MODEL_PORT ?? 4429),
      "127.0.0.1",
      resolve,
    );
  });
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 0 });
  const approvals = new Queue(approvalQueue, { connection: redis });
  const jobs = new Queue(meetingQueue, { connection: redis });
  const runtime = postgres(process.env.DATABASE_URL, { max: 1 });
  const admin = postgres(process.env.MIGRATION_DATABASE_URL, { max: 1 });
  const leadContext = await browser.newContext({ baseURL });
  const memberContext = await browser.newContext({ baseURL });
  const [page, member] = await Promise.all([
    leadContext.newPage(),
    memberContext.newPage(),
  ]);
  const headers = { Origin: baseURL };
  async function response(request: Promise<APIResponse>, status = 200) {
    const received = await request;
    const value = await received.json();
    expect(received.status(), JSON.stringify(value)).toBe(status);
    return value;
  }
  const post = (actor: Page, path: string, data: object) =>
    actor.request.post(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  const patch = (actor: Page, path: string, data: object) =>
    actor.request.patch(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  try {
    await Promise.all([
      signIn(page, lead, "/workspace"),
      signIn(member, maya, "/workspace"),
    ]);
    const workspace = await createTestWorkspace(page, "Meeting Studio");
    const api = `/api/workspaces/${workspace}`;
    const { token } = await response(
      post(page, api + "/invitations", {
        email: maya.email,
        role: "contributor",
      }),
      201,
    );
    await response(post(member, "/api/invitations/accept", { token }));
    const { identity } = await response(member.request.get("/api/session"));
    const { id: project } = await response(
      post(page, api + "/projects", {
        name: "Pilot rollout",
        visibility: "restricted",
        timeZone: "UTC",
        description: null,
        workdays: [1, 2, 3, 4, 5],
        nonworkingDates: [],
      }),
      201,
    );
    const endpoint = `${api}/projects/${project}`;
    const base = `/w/${workspace}/projects/${project}`;
    await response(
      patch(page, `${endpoint}/members/${identity.id}`, {
        role: "contributor",
        expectedVersion: null,
      }),
    );
    await page.goto(base);
    await page.getByRole("link", { name: "Meetings", exact: true }).click();
    await page.getByRole("button", { name: "New meeting" }).click();
    await page.getByLabel("Meeting title").fill("Pilot planning");
    await page
      .getByLabel("Agenda")
      .fill("Confirm the rollout and follow-up owners.");
    await page.getByLabel("Recording retention").selectOption("7");
    await page.getByRole("button", { name: "Create meeting" }).click();
    await expect(
      page.getByRole("heading", { name: "Pilot planning" }),
    ).toBeVisible();
    const meetingId = new URL(page.url()).pathname.split("/").at(-1)!;
    const meetingUrl = `${base}/meetings/${meetingId}`;
    const meeting = `${endpoint}/meetings/${meetingId}`;
    const getMeeting = async () =>
      meetingDetailSchema.parse(await response(page.request.get(meeting)));
    const readReview = async (id: string) => {
      const proposal = proposalDetailSchema.parse(
        await response(page.request.get(`${api}/proposals/${id}`)),
      );
      if (proposal.kind !== "meeting")
        throw new Error("Expected a meeting proposal.");
      return proposal;
    };
    const approve = (id: string, version: number, revision: number) =>
      post(page, `${api}/proposals/${id}/approve`, {
        expectedVersion: version,
        revision,
      });
    const followUp = (title: RegExp) =>
      page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { name: title }) });

    await page.getByLabel("Recording", { exact: true }).setInputFiles({
      name: "pilot.wav",
      mimeType: "audio/wav",
      buffer: wave(),
    });
    await expect(
      page.getByRole("button", { name: "Upload recording" }),
    ).toBeDisabled();
    await page
      .getByLabel("I’m authorized to upload and transcribe this recording.")
      .check();
    await page.getByRole("button", { name: "Upload recording" }).click();
    await expect(
      page.getByText("Processing failed", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Transcription timed out/)).toBeVisible();
    await page.getByRole("button", { name: "Retry processing" }).click();
    await expect(
      page.getByRole("heading", { name: "Transcript · Revision 1" }),
    ).toBeVisible();
    const original = await getMeeting();
    expect(original.attempt).toBe(2);
    expect(original.items).toHaveLength(4);
    const ask = original.items.find(({ values }) =>
      values.title.includes("Ask Maya"),
    )!;
    expect(ask.values.ownerId).toBeNull();
    expect(ask.values.date).toBeNull();
    expect(
      original.items.some(({ values }) => values.kind === "question"),
    ).toBe(true);
    await expect(
      runtime`SELECT * FROM public.meeting_transcripts`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime`SELECT * FROM kordos_meetings.pending()`,
    ).rejects.toMatchObject({ code: "42501" });

    const talk = `${endpoint}/discussions/meeting/${meetingId}`;
    await response(
      post(member, talk, {
        action: "post",
        parentId: null,
        mentionIds: [],
        body: "Ready to check the pilot details.",
      }),
    );
    await expect(
      page.getByText("Ready to check the pilot details."),
    ).toBeVisible();
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 860 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
    }
    await followUp(/Ask Maya/)
      .getByRole("button", { name: "Review action" })
      .click();
    const askForm = followUp(/Ask Maya/);
    await expect(askForm.getByLabel("Owner")).toHaveValue("");
    await askForm.getByLabel("Owner").selectOption(identity.id);
    await askForm.getByRole("button", { name: "Submit for approval" }).click();
    await expect(
      page.getByRole("heading", { name: /Review action.*Ask Maya/ }),
    ).toBeVisible();
    const actionProposal = new URL(page.url()).pathname.split("/").at(-1)!;
    const action = await readReview(actionProposal);
    expect(action.meetingItem?.ownerId).toBe(identity.id);
    const first = await response(
      approve(actionProposal, action.version, action.revision),
      202,
    );
    const second = await response(
      approve(actionProposal, action.version, action.revision),
      202,
    );
    expect(second).toEqual(first);
    const receipt = reviewResponseSchema.parse(first).receiptId!;
    await expect(page.getByText("Applied", { exact: true })).toBeVisible();
    await approvals.add(
      "apply",
      { id: receipt },
      { jobId: `replay-${receipt}`, removeOnComplete: true },
    );
    await expect
      .poll(() => approvals.getJob(`replay-${receipt}`))
      .toBeUndefined();
    const actionWork = (await readReview(actionProposal)).meetingWorkId!;
    expect(actionWork).toBeTruthy();
    await page.getByRole("link", { name: "Open resulting task" }).click();
    const taskOrigin = page.getByRole("region", { name: "Source meeting" });
    await expect(
      taskOrigin.getByRole("link", { name: "Pilot planning" }),
    ).toBeVisible();
    await taskOrigin
      .getByRole("link", { name: "Open supporting segment" })
      .click();
    await expect(page.getByRole("blockquote")).toHaveText(
      "Ask Maya about rollout.",
    );
    const player = page.getByLabel("Recording from 00:03 to 00:05");
    await expect(player).toBeVisible();
    await expect
      .poll(() =>
        player.evaluate((audio) =>
          Math.floor((audio as HTMLAudioElement).currentTime),
        ),
      )
      .toBe(3);
    const evidenceUi = new URL(page.url());
    const sourceApi =
      evidenceUi.pathname.replace(
        /^\/w\/([^/]+)(\/projects\/[^/]+)\/documents\/evidence\//,
        "/api/workspaces/$1$2/evidence/",
      ) + evidenceUi.search;
    const originalEvidence = resolvedCitationSchema.parse(
      await response(page.request.get(sourceApi)),
    );
    expect(originalEvidence.clip).toMatchObject({ startMs: 3000, endMs: 5000 });
    const audioApi = `${meeting}/audio/${originalEvidence.clip!.recordingId}`;
    const audio = await page.request.get(audioApi, {
      headers: { Range: "bytes=0-43" },
    });
    expect(audio.status()).toBe(206);
    expect((await audio.body()).subarray(0, 4).toString()).toBe("RIFF");

    await page.goto(meetingUrl);
    const checklist = followUp(/send the release checklist/);
    await checklist.getByRole("button", { name: "Review action" }).click();
    await checklist
      .getByRole("button", { name: "Submit for approval" })
      .click();
    await expect(
      page.getByRole("heading", { name: /Review action.*release checklist/ }),
    ).toBeVisible();
    const oldProposal = new URL(page.url()).pathname.split("/").at(-1)!;
    const old = await readReview(oldProposal);
    await page.goto(meetingUrl);
    const segment = page
      .locator(".meeting-segments li")
      .filter({ hasText: "send the release checklist" });
    await segment.getByRole("button", { name: "Correct segment" }).click();
    await segment.getByLabel("Speaker").fill("Maya");
    await segment.getByRole("button", { name: "Save correction" }).click();
    await expect(
      page.getByRole("heading", { name: "Transcript · Revision 2" }),
    ).toBeVisible();
    await expect(
      checklist.getByText("Needs review", { exact: true }),
    ).toBeVisible();
    await response(approve(oldProposal, old.version, old.revision), 409);
    expect((await readReview(oldProposal)).status).toBe("stale");
    await page.getByRole("button", { name: "Reprocess suggestions" }).click();
    await expect(
      checklist.getByText("Suggested", { exact: true }),
    ).toBeVisible();
    expect(
      (await getMeeting()).items.find(({ id }) => id === ask.id),
    ).toMatchObject({
      status: "accepted",
      workId: actionWork,
      anchor: ask.anchor,
    });
    expect(
      (await getMeeting()).items.find(({ values }) =>
        values.title.includes("release checklist"),
      )?.values.ownerId,
    ).toBe(identity.id);
    const [generation] = await admin<
      { generation: number }[]
    >`SELECT generation FROM public.meetings WHERE id=${meetingId}`;
    await jobs.add(
      "process",
      { id: meetingId, generation: generation!.generation },
      { jobId: `replay-${meetingId}`, removeOnComplete: true },
    );
    await expect.poll(() => jobs.getJob(`replay-${meetingId}`)).toBeUndefined();
    expect(transcriptionCalls).toBe(2);

    const decision = followUp(/Ship the pilot/);
    await decision.getByRole("button", { name: "Review decision" }).click();
    await decision.getByLabel("Accountable person").selectOption(identity.id);
    await decision.getByRole("button", { name: "Submit for approval" }).click();
    await expect(
      page.getByRole("heading", { name: /Review decision.*Ship the pilot/ }),
    ).toBeVisible();
    const decisionProposal = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.getByRole("button", { name: "Approve change" }).click();
    await expect(
      page.getByRole("link", { name: "Open confirmed decision" }),
    ).toBeVisible();
    const decisionId = (await readReview(decisionProposal)).meetingDecisionId!;
    expect(decisionId).toBeTruthy();

    const task = workItemSchema.parse(
      await response(page.request.get(`${endpoint}/work/${actionWork}`)),
    );
    await response(
      patch(page, `${endpoint}/work/${actionWork}`, {
        ...workFieldsSchema.parse(task),
        action: "edit",
        status: "done",
        expectedVersion: task.version,
      }),
    );
    await page.goto(meetingUrl);
    await expect(
      followUp(/Ask Maya/).getByText("Completed", { exact: true }),
    ).toBeVisible();
    expect(
      workPageSchema.parse(await response(page.request.get(endpoint + "/work")))
        .items,
    ).toHaveLength(1);
    await response(
      patch(page, `${endpoint}/members/${identity.id}`, {
        role: null,
        expectedVersion: 1,
      }),
    );
    expect((await member.request.get(meeting)).status()).toBe(404);
    expect((await member.request.get(sourceApi)).status()).toBe(404);
    expect(
      (
        await member.request.get(`${endpoint}/decisions/${decisionId}`)
      ).status(),
    ).toBe(404);
    expect((await member.request.get(audioApi)).status()).toBe(404);
    expect(
      (
        await page.request.get(audioApi, { headers: { Range: "bytes=0-43" } })
      ).status(),
    ).toBe(206);
    await page.getByRole("button", { name: "Remove recording" }).click();
    await page.getByRole("button", { name: "Confirm removal" }).click();
    await expect(
      page.getByText(/Recording unavailable. Saved transcript/),
    ).toBeVisible();
    expect((await page.request.get(audioApi)).status()).toBe(404);
    await expect
      .poll(async () => {
        const [media] = await admin<
          { deleted: boolean }[]
        >`SELECT deleted_at IS NOT NULL AS deleted FROM public.meeting_media WHERE meeting_id=${meetingId}`;
        return media?.deleted;
      })
      .toBe(true);
    const afterRemoval = resolvedCitationSchema.parse(
      await response(page.request.get(sourceApi)),
    );
    expect(afterRemoval.excerpt).toBe(originalEvidence.excerpt);
    expect(afterRemoval.clip?.recordingId).toBeNull();
    const decisionRecord = decisionSchema.parse(
      await response(page.request.get(`${endpoint}/decisions/${decisionId}`)),
    );
    expect(decisionRecord.confirmedAt).toBeTruthy();
    expect(decisionRecord.evidence[0]?.source.kind).toBe("meeting");

    expect(
      (await page.request.get(`${endpoint}/decisions/${decisionId}`)).status(),
    ).toBe(200);

    const { id: pastedId } = await response(
      post(page, endpoint + "/meetings", {
        title: "Written debrief",
        agenda: null,
        startsAt: new Date().toISOString(),
        retentionDays: 30,
      }),
      201,
    );
    await page.goto(`${base}/meetings/${pastedId}`);
    await page
      .getByLabel("Paste transcript")
      .fill("Lina: Question: Which group goes first?");
    await page.getByRole("button", { name: "Process transcript" }).click();
    await expect(
      page.getByRole("heading", { name: "Transcript · Revision 1" }),
    ).toBeVisible();
    const pasted = meetingDetailSchema.parse(
      await response(page.request.get(`${endpoint}/meetings/${pastedId}`)),
    );
    expect(pasted.transcript?.segments[0]).toMatchObject({
      speaker: "Lina",
      startMs: null,
      endMs: null,
    });
    expect(pasted.items[0]?.values.kind).toBe("question");
    expect(transcriptionCalls).toBe(2);
    const { id: expiryId } = await response(
      post(page, endpoint + "/meetings", {
        title: "Expiring recording",
        agenda: null,
        startsAt: new Date().toISOString(),
        retentionDays: 7,
      }),
      201,
    );
    const params = new URLSearchParams({
      extension: "wav",
      authorized: "true",
      expectedVersion: "1",
      mutationId: randomUUID(),
    });
    await response(
      page.request.post(`${endpoint}/meetings/${expiryId}/audio?${params}`, {
        headers: { ...headers, "Content-Type": "application/octet-stream" },
        data: wave(),
      }),
      202,
    );
    const [expired] = await admin<{ id: string }[]>`
      UPDATE public.meeting_media SET expires_at=clock_timestamp()-interval '1 second'
      WHERE meeting_id=${expiryId} RETURNING id
    `;
    expect(
      (
        await page.request.get(
          `${endpoint}/meetings/${expiryId}/audio/${expired!.id}`,
        )
      ).status(),
    ).toBe(404);
    await expect
      .poll(async () => {
        const [media] = await admin<
          { deleted: boolean }[]
        >`SELECT deleted_at IS NOT NULL AS deleted FROM public.meeting_media WHERE id=${expired!.id}`;
        return media?.deleted;
      })
      .toBe(true);
  } finally {
    await Promise.all([
      leadContext.close(),
      memberContext.close(),
      stopOidc(),
      runtime.end(),
      admin.end(),
      approvals.close(),
      jobs.close(),
    ]);
    redis.disconnect();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
