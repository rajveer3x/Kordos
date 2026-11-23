import { randomUUID } from "node:crypto";
import type { MeetingExtractedItem, MeetingSegment } from "@kordos/contracts";
import { sourceDate } from "./source-dates.js";

const timing =
  /\b((?:next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|today|tomorrow|\d{4}-\d{2}-\d{2})\s*[.!?]?$/i;

export function splitMeetingText(text: string): MeetingSegment[] {
  const segments: MeetingSegment[] = [];
  for (const line of text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const tagged = /^([^:\n]{1,100}):\s+(.+)$/u.exec(line);
    const speaker =
      tagged &&
      !/^(action(?: item)?|decision|question|todo|follow.up)$/i.test(tagged[1]!)
        ? tagged[1]!.trim()
        : null;
    const content = speaker ? tagged![2]! : line;
    for (const chunk of content.match(/.{1,1000}/gu) ?? []) {
      if (chunk.trim())
        segments.push({
          id: randomUUID(),
          text: chunk.trim(),
          speaker,
          startMs: null,
          endMs: null,
        });
    }
  }
  return segments;
}

type Owner = { id: string; name: string };
export function extractMeetingItems(
  segments: MeetingSegment[],
  revision: number,
  startsAt: string,
  timeZone: string,
  owners: Owner[],
): MeetingExtractedItem[] {
  const result: MeetingExtractedItem[] = [];
  for (const segment of segments) {
    const clauses = segment.text.split(/(?<=[.!?])\s+(?=\S)/u);
    const ordinal = { action: 0, decision: 0, question: 0 };
    let offset = 0;
    for (const clause of clauses) {
      const at = segment.text.indexOf(clause, offset);
      offset = at + clause.length;
      const decision =
        /^(?:decision\s*:|(?:we\s+)?(?:agreed|decided|approved)\s+(?:to\s+|that\s+)?)/i.exec(
          clause,
        );
      const action =
        /^(?:action(?: item)?\s*:|to-?do\s*:|follow.up\s*:|(?:we should\s+)?ask\s+|i['’]ll\s+|i will\s+)/i.exec(
          clause,
        );
      const question = /^question\s*:/i.exec(clause);
      const named = /^(.{1,100}?)\s+will\s+(.+)$/iu.exec(clause);
      const explicitOwner =
        /\bowner\s*:\s*([^.;]+?)(?:\s+due\s+|$|[.;])/iu.exec(clause);
      let kind: MeetingExtractedItem["kind"];
      if (decision) kind = "decision";
      else if (question || (!action && clause.endsWith("?"))) kind = "question";
      else if (action || named) kind = "action";
      else continue;

      const content = clause
        .replace(
          /^(?:action(?: item)?|decision|question|to-?do|follow.up)\s*:\s*/i,
          "",
        )
        .trim();
      if (!content) continue;
      const commitment = /^i(?:['’]ll| will)\s/i.test(content);
      const ownerName =
        explicitOwner?.[1]?.trim() ??
        (kind === "action"
          ? commitment
            ? segment.speaker
            : named?.[1]?.trim()
          : null);
      const matches = ownerName
        ? owners.filter(
            ({ name }) => name.toLowerCase() === ownerName.toLowerCase(),
          )
        : [];
      const ownerId = matches.length === 1 ? matches[0]!.id : null;
      const dayPhrase =
        kind === "action" ? timing.exec(content)?.[1] : undefined;
      const date = dayPhrase ? sourceDate(dayPhrase, timeZone, startsAt) : null;
      result.push({
        key: `${segment.id}:${kind}:${ordinal[kind]++}`,
        kind,
        title: Array.from(content).slice(0, 155).join("").trim(),
        detail: kind === "decision" ? content : null,
        ownerId,
        date,
        ownerExplicit: !!ownerId,
        dateExplicit: !!date,
        anchor: {
          revision,
          segmentId: segment.id,
          start: Array.from(segment.text.slice(0, at)).length,
          end: Array.from(segment.text.slice(0, offset)).length,
        },
      });
      if (result.length === 160) return result;
    }
  }
  return result;
}
