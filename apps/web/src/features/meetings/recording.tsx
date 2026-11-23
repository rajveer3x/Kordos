import { useState } from "react";
import { usePlanning } from "../planning/planning-client";

export function recordingTime(milliseconds: number) {
  const second = Math.floor(milliseconds / 1000);
  const tail = [Math.floor(second / 60) % 60, second % 60]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return second >= 3600 ? `${Math.floor(second / 3600)}:${tail}` : tail;
}

export function RecordingClip({
  projectId,
  meetingId,
  recordingId,
  startMs,
  endMs,
}: {
  projectId: string;
  meetingId: string;
  recordingId: string | null;
  startMs: number;
  endMs: number;
}) {
  const { api } = usePlanning();
  const [failed, setFailed] = useState(false);
  const start = startMs / 1000;
  const end = endMs / 1000;
  const label = `Recording from ${recordingTime(startMs)} to ${recordingTime(endMs)}`;
  if (!recordingId || failed)
    return (
      <p className="planning-help">
        Recording unavailable · {recordingTime(startMs)}–{recordingTime(endMs)}
      </p>
    );
  return (
    <audio
      aria-label={label}
      className="meeting-recording"
      controls
      preload="metadata"
      src={`/api${api}/projects/${projectId}/meetings/${meetingId}/audio/${recordingId}#t=${start},${end}`}
      onLoadedMetadata={({ currentTarget }) => {
        currentTarget.currentTime = start;
      }}
      onPlay={({ currentTarget }) => {
        if (
          currentTarget.currentTime < start ||
          currentTarget.currentTime >= end
        )
          currentTarget.currentTime = start;
      }}
      onTimeUpdate={({ currentTarget }) => {
        if (!currentTarget.paused && currentTarget.currentTime >= end)
          currentTarget.pause();
      }}
      onError={() => setFailed(true)}
      style={{ width: "100%", maxWidth: "34rem" }}
    />
  );
}
