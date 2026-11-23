import { setTimeout as delay } from "node:timers/promises";
import { connectInboxWorker, type InboxEmailJob } from "@kordos/db";
import type { InboxReason } from "@kordos/contracts";

const subjects: Record<InboxReason, string> = {
  assignment: "Work was assigned to you",
  mention: "You were mentioned",
  review: "A proposal is awaiting review",
  risk: "A project has a schedule risk",
  due: "Work is due soon",
  overdue: "Work is overdue",
  escalation: "Overdue work needs your attention",
};

type Mail = { endpoint: string; key: string; from: string; origin: string };

async function sendEmail(mail: Mail, job: InboxEmailJob) {
  const path = `/w/${job.workspaceId}/inbox${job.digest ? "?digest=" + job.digest : "/" + job.id}`;
  const link = new URL(path, mail.origin).href;
  const subject = job.digest
    ? "Your daily Kordos digest"
    : subjects[job.reason];
  try {
    const response = await fetch(mail.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mail.key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": job.key,
      },
      body: JSON.stringify({
        from: mail.from,
        to: [job.email],
        subject,
        text: `${subject}. Open your Kordos inbox to view the details.\n\n${link}`,
      }),
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    const status = response.status;
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return "sent";
    return status >= 500 || [408, 409, 429].includes(status)
      ? "retry"
      : "failed";
  } catch {
    return "retry";
  }
}

export function startInbox(
  databaseUrl: string,
  signal: AbortSignal,
  mail?: Mail,
) {
  const db = connectInboxWorker(databaseUrl);
  return (async () => {
    let nextSchedule = 0;
    let reported = false;
    try {
      while (!signal.aborted) {
        try {
          if (Date.now() >= nextSchedule) {
            await db.schedule();
            nextSchedule = Date.now() + 5000;
          }
          await db.advance();
          if (mail) {
            for (let count = 0; count < 20 && !signal.aborted; count++) {
              if (!(await db.email((job) => sendEmail(mail, job)))) break;
            }
          }
          reported = false;
        } catch (error) {
          if (!reported && !signal.aborted) {
            console.error(
              "[worker] Could not process inbox delivery. Will retry.",
              error instanceof Error && "code" in error
                ? error.code
                : undefined,
            );
            reported = true;
          }
        }
        await delay(1000, undefined, { signal }).catch((error: unknown) => {
          if (!signal.aborted) throw error;
        });
      }
    } finally {
      await db.close();
    }
  })();
}
