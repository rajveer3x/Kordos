import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  auditPageSchema,
  decisionSchema,
  meetingDetailSchema,
  proposalDetailSchema,
  retentionPolicySchema,
  searchResponseSchema,
  weeklyReportsSchema,
  workHistorySchema,
  workFieldsSchema,
} from "@kordos/contracts";
import { expect, test, type APIResponse } from "@playwright/test";
import postgres from "postgres";
import {
  createTestWorkspace,
  signIn,
  startOidcFixture,
} from "./oidc-fixture.js";

async function checked(response: Promise<APIResponse>, status = 200) {
  const result = await response;
  const data = result.status() === 204 ? null : await result.json();
  expect(result.status(), JSON.stringify(data)).toBe(status);
  return data;
}

test("workspace expiration revokes open evidence and resumes deletion while preserving approved records and audit facts", async ({
  browser,
  baseURL,
}, info) => {
  test.setTimeout(120_000);
  if (
    !baseURL ||
    !process.env.MIGRATION_DATABASE_URL ||
    !process.env.DATABASE_URL
  )
    throw new Error(
      "Set the local browser, runtime and migration database URLs.",
    );
  const admin = {
    name: "Lina",
    email: `${randomUUID()}@example.test`,
    email_verified: true,
  };
  const member = {
    name: "Maya",
    email: `${randomUUID()}@example.test`,
    email_verified: true,
  };
  const stopOidc = await startOidcFixture({ admin, member }, baseURL);
  const transcript = "Ask Maya about the wattlefinch launch.";
  const decisionText = "Keep the approved rollout plan.";
  const provider = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        segments: [
          { start: 0, end: 2, text: transcript, speaker: "Lina" },
          {
            start: 2,
            end: 4,
            text: `Decision: ${decisionText}`,
            speaker: "Lina",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(
      Number(process.env.TEST_BRIEF_MODEL_PORT ?? 4429),
      "127.0.0.1",
      resolve,
    );
  });
  const owner = postgres(process.env.MIGRATION_DATABASE_URL);
  const runtime = postgres(process.env.DATABASE_URL);
  const adminContext = await browser.newContext({ baseURL });
  const memberContext = await browser.newContext({ baseURL });
  const [page, peer, searchView, weekly, meetingView] = await Promise.all([
    adminContext.newPage(),
    memberContext.newPage(),
    memberContext.newPage(),
    memberContext.newPage(),
    memberContext.newPage(),
  ]);
  const headers = { Origin: baseURL };
  const post = (path: string, data: object, from = page) =>
    from.request.post(path, {
      headers,
      data: { mutationId: randomUUID(), ...data },
    });
  try {
    await Promise.all([
      signIn(page, admin, "/workspace"),
      signIn(peer, member, "/workspace"),
    ]);
    const workspace = await createTestWorkspace(page, "Retention Studio");
    const {
      identity: { id: actor },
    } = await checked(page.request.get("/api/session"));
    const ui = `/w/${workspace}`;
    const api = `/api/workspaces/${workspace}`;
    const { token } = await checked(
      post(api + "/invitations", { email: member.email, role: "contributor" }),
      201,
    );
    await checked(post("/api/invitations/accept", { token }, peer));
    const { id: project } = await checked(
      post(api + "/projects", {
        name: "Release plans",
        visibility: "workspace",
        timeZone: "UTC",
        description: null,
        workdays: [1, 2, 3, 4, 5],
        nonworkingDates: [],
      }),
      201,
    );
    const projectApi = `${api}/projects/${project}`;
    const projectUi = `${ui}/projects/${project}`;
    const { id: meetingId } = await checked(
      post(projectApi + "/meetings", {
        title: "Release planning",
        agenda: null,
        startsAt: new Date().toISOString(),
        retentionDays: 7,
      }),
      201,
    );
    const meeting = `${projectApi}/meetings/${meetingId}`;
    const wave = Buffer.alloc(44 + 8000);
    wave.write("RIFF");
    wave.write("WAVE", 8);
    await checked(
      page.request.post(
        `${meeting}/audio?extension=wav&expectedVersion=1&mutationId=${randomUUID()}&authorized=true`,
        {
          headers: { ...headers, "Content-Type": "application/octet-stream" },
          data: wave,
        },
      ),
      202,
    );
    const readMeeting = async () =>
      meetingDetailSchema.parse(await checked(peer.request.get(meeting)));
    await expect.poll(async () => (await readMeeting()).status).toBe("ready");
    const original = await readMeeting();
    const recording = original.transcript?.recordingId;
    if (!recording) throw new Error("Expected playable recording evidence.");
    const audioPath = `${meeting}/audio/${recording}`;
    const range = { headers: { Range: "bytes=0-11" } };
    const playable = await peer.request.get(audioPath, range);
    expect(playable.status()).toBe(206);
    expect(playable.headers()["cache-control"]).toBe("private, no-store");
    expect((await playable.body()).toString("ascii", 0, 4)).toBe("RIFF");

    async function submit(kind: "action" | "decision") {
      const item = original.items.find(({ values }) => values.kind === kind)!;
      const { proposalId } = await checked(
        post(`${meeting}/items/${item.id}`, {
          action: "submit",
          expectedVersion: item.version,
          values: {
            ...item.values,
            ownerId: actor,
            detail: kind === "decision" ? decisionText : null,
          },
        }),
        201,
      );
      return proposalDetailSchema.parse(
        await checked(page.request.get(api + "/proposals/" + proposalId)),
      );
    }
    const pending = await submit("action");
    const approval = await submit("decision");
    const reviewPath = `${api}/proposals/${approval.id}`;
    await checked(
      post(reviewPath + "/approve", {
        expectedVersion: approval.version,
        revision: approval.revision,
      }),
      202,
    );
    async function approvedDecision() {
      const detail = proposalDetailSchema.parse(
        await checked(page.request.get(reviewPath)),
      );
      return detail.kind === "meeting" ? detail.meetingDecisionId : null;
    }
    await expect.poll(approvedDecision).toBeTruthy();
    const decisionId = await approvedDecision();

    const report = `${projectApi}/weekly-health`;
    async function requests() {
      return weeklyReportsSchema
        .parse(await checked(peer.request.get(report)))
        .report?.decisions.map(({ id }) => id);
    }
    await expect.poll(requests).toBeDefined();
    await owner`UPDATE public.project_weeklies SET generated_at=now()-interval '2 minutes'
      WHERE workspace_id=${workspace} AND project_id=${project}`;
    await expect.poll(requests).toContain(pending.id);

    const archiveLabel = "Obsolete audit detail";
    const { id: work } = await checked(
      post(
        projectApi + "/work",
        workFieldsSchema.parse({
          title: "Keep the work item",
          description: archiveLabel,
          kind: "task",
          status: "ready",
          ownerId: null,
          estimateDays: null,
          deadline: null,
          commitment: null,
          blockerReason: null,
          blockerOwnerId: null,
          blockerResolution: null,
        }),
      ),
      201,
    );
    const [event] =
      await owner`UPDATE public.audit_events SET created_at=now()-interval '2 days'
      WHERE workspace_id=${workspace} AND target_id=${work} AND action='work.created' RETURNING id,created_at`;

    const installation = randomUUID(),
      mapping = randomUUID(),
      mirror = randomUUID();
    await owner.begin(async (sql) => {
      await sql`INSERT INTO public.connector_installations (id,workspace_id,owner_id,label,provider,state,google_subject)
        VALUES (${installation},${workspace},${actor},'Fixture Gmail','gmail','paused','fixture-subject')`;
      await sql`INSERT INTO public.connector_mappings
        (id,workspace_id,installation_id,scope,project_id,audience,provider_audience,verified_until)
        VALUES (${mapping},${workspace},${installation},'fixture-label',${project},'private','private',now()+interval '5 minutes')`;
      await sql`INSERT INTO public.source_objects (id,workspace_id,installation_id,mapping_id,project_id,external_id,revision)
        VALUES (${mirror},${workspace},${installation},${mapping},${project},'fixture-message',1)`;
      await sql`INSERT INTO public.source_revisions
        (workspace_id,project_id,source_id,revision,revision_key,observed_at,title,body)
        VALUES (${workspace},${project},${mirror},1,'fixture-revision',now()-interval '2 days',
          'Original private subject','Keep independently approved text. Revoke the ashthrush excerpt. Private mirror body.')`;
    });
    const sources = projectApi + "/connector-sources";
    const { id: shared } = await checked(
      post(`${sources}/${mirror}/shares`, {
        revision: 1,
        excerpt: "Keep independently approved text.",
      }),
      201,
    );
    const { id: revoked } = await checked(
      post(`${sources}/${mirror}/shares`, {
        revision: 1,
        excerpt: "Revoke the ashthrush excerpt.",
      }),
      201,
    );
    await checked(page.request.get(`${sources}/${mirror}`));
    await checked(peer.request.get(`${sources}/${revoked}`));
    const search = async (q: string) =>
      searchResponseSchema.parse(
        await checked(peer.request.get(`${api}/search?q=${q}`)),
      ).items;
    await expect
      .poll(async () => (await search("ashthrush")).map(({ id }) => id))
      .toContain(revoked);
    await checked(post(`${sources}/${revoked}/revoke`, {}));
    await checked(peer.request.get(`${sources}/${revoked}`), 404);
    expect(await search("ashthrush")).toHaveLength(0);

    await Promise.all([
      searchView.goto(ui + "/search?q=wattlefinch"),
      weekly.goto(projectUi + "/weekly-health"),
      meetingView.goto(projectUi + "/meetings/" + meetingId),
    ]);
    await expect(searchView.getByText(/wattlefinch launch/)).toBeVisible();
    await expect(
      weekly.getByRole("link", { name: pending.title }),
    ).toBeVisible();
    await expect(
      meetingView.getByRole("paragraph").filter({ hasText: transcript }),
    ).toBeVisible();

    const policyPath = api + "/retention";
    const defaultPolicy = retentionPolicySchema.parse(
      await checked(page.request.get(policyPath)),
    );
    await checked(peer.request.get(policyPath), 404);
    await checked(
      peer.request.patch(policyPath, {
        headers,
        data: {
          audioDays: 1,
          transcriptDays: 1,
          importedDays: 1,
          logDays: 1,
          expectedVersion: 1,
          mutationId: randomUUID(),
        },
      }),
      404,
    );
    await expect(
      runtime`SELECT * FROM public.workspace_retention`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime`SELECT kordos_retention.purge()`,
    ).rejects.toMatchObject({ code: "42501" });

    await owner`UPDATE public.meeting_transcripts SET created_at=now()-interval '2 days'
      WHERE workspace_id=${workspace} AND meeting_id=${meetingId}`;
    await page.goto(ui + "/settings");
    const settings = page.getByRole("region", {
      name: "Retention and deletion",
    });
    await expect(settings.getByRole("spinbutton").first()).toBeVisible();
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 860 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(width);
      if (width === 1440 || width === 320) {
        const size = width === 1440 ? "desktop" : "mobile";
        await settings.screenshot({
          path: info.outputPath(`retention-settings-${size}.png`),
        });
      }
    }
    for (const label of [
      "Audio retention",
      "Transcript retention",
      "Imported source retention",
      "Audit detail retention",
    ])
      await page.getByRole("spinbutton", { name: label + " (days)" }).fill("1");
    await page.getByRole("button", { name: "Save retention policy" }).click();

    await owner.begin(async (sql) => {
      await sql`UPDATE public.meeting_media SET created_at=now()-interval '2 days' WHERE id=${recording}`;
      await page
        .getByRole("button", { name: "Confirm retention change" })
        .click();
      await expect(page.getByText("Retention policy saved.")).toBeVisible();
      const claims = await sql`SELECT id FROM kordos_meetings.cleanup()`;
      expect(claims.map(({ id }) => id)).toContain(recording);
      const [interrupted] =
        await sql`SELECT removed_at,deleted_at FROM public.meeting_media WHERE id=${recording}`;
      expect(interrupted).toMatchObject({
        removed_at: expect.any(Date),
        deleted_at: null,
      });
      // Publish the durable removal marker without acknowledging object deletion.
    });
    await checked(
      page.request.patch(policyPath, {
        headers,
        data: {
          audioDays: 2,
          transcriptDays: 2,
          importedDays: 2,
          logDays: 2,
          expectedVersion: defaultPolicy.version,
          mutationId: randomUUID(),
        },
      }),
      409,
    );
    await checked(page.request.get(`${sources}/${mirror}`), 404);
    expect((await peer.request.get(audioPath, range)).status()).toBe(404);
    await checked(peer.request.get(meeting + "?revision=1"), 404);
    expect(await search("wattlefinch")).toHaveLength(0);
    expect(await requests()).not.toContain(pending.id);
    await expect(searchView.getByText(/wattlefinch launch/)).toHaveCount(0);
    await expect(weekly.getByRole("link", { name: pending.title })).toHaveCount(
      0,
    );
    await expect(
      meetingView.getByText(transcript, { exact: true }),
    ).toHaveCount(0);

    await expect
      .poll(
        async () =>
          retentionPolicySchema.parse(
            await checked(page.request.get(policyPath)),
          ).removed,
      )
      .toEqual({ audio: 1, transcripts: 1, imports: 1, shares: 1, logs: 1 });
    await expect
      .poll(async () => {
        const [result] = await owner`SELECT
        EXISTS (SELECT FROM public.search_chunks WHERE workspace_id=${workspace} AND (
          (source_id=${meetingId} AND citation IS NOT NULL) OR source_id=${revoked})) AS indexed,
        EXISTS (SELECT FROM public.meeting_transcripts WHERE meeting_id=${meetingId} AND segments<>'[]') AS transcript,
        EXISTS (SELECT FROM public.source_revisions WHERE source_id=${mirror} AND (body IS NOT NULL OR title IS NOT NULL)) AS mirror,
        EXISTS (SELECT FROM public.connector_shares WHERE id=${revoked} AND (excerpt<>'' OR title<>'')) AS share`;
        return result;
      })
      .toEqual({
        indexed: false,
        transcript: false,
        mirror: false,
        share: false,
      });

    expect(
      (await readMeeting()).items.map(({ decisionId }) => decisionId),
    ).toEqual([decisionId]);
    expect(
      decisionSchema.parse(
        await checked(
          peer.request.get(`${projectApi}/decisions/${decisionId}`),
        ),
      ).conclusion,
    ).toBe(decisionText);
    expect(
      await checked(peer.request.get(`${sources}/${shared}`)),
    ).toMatchObject({ body: "Keep independently approved text." });
    const audit = auditPageSchema.parse(
      await checked(page.request.get(`${api}/audit?eventId=${event!.id}`)),
    ).items[0]!;
    expect(audit).toMatchObject({
      id: event!.id,
      actor: { id: actor },
      action: "work.created",
    });
    expect(Date.parse(audit.occurredAt)).toBe(event!.created_at.getTime());
    expect(JSON.stringify(audit)).not.toContain(archiveLabel);
    expect(
      workHistorySchema.parse(
        await checked(page.request.get(`${projectApi}/work/${work}/history`)),
      ).items[0]?.after.version,
    ).toBe(1);
    expect(
      await checked(page.request.get(`${projectApi}/work/${work}`)),
    ).toMatchObject({ description: archiveLabel });

    const cleared = await readMeeting();
    await checked(
      page.request.patch(meeting, {
        headers,
        data: {
          action: "paste",
          mutationId: randomUUID(),
          expectedVersion: cleared.version,
          content:
            "New transcript captured under the current retention policy.",
        },
      }),
      202,
    );
    await expect
      .poll(async () => (await readMeeting()).transcript?.revision)
      .toBe(2);
    await checked(peer.request.get(meeting + "?revision=1"), 404);
  } finally {
    await Promise.all([
      adminContext.close(),
      memberContext.close(),
      owner.end(),
      runtime.end(),
      stopOidc(),
      new Promise<void>((resolve) => provider.close(() => resolve())),
    ]);
  }
});
