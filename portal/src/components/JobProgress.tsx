"use client";

import type { JobRecord, JobStatus } from "@/lib/jobs";

export const JOB_STATUS_META: Record<JobStatus, { label: string; bg: string; color: string }> = {
  queued: { label: "Queued", bg: "rgba(255,255,255,0.08)", color: "var(--text-muted)" },
  running: { label: "Running", bg: "rgba(234,179,8,0.12)", color: "#eab308" },
  succeeded: { label: "Succeeded", bg: "rgba(16,185,129,0.1)", color: "#10b981" },
  failed: { label: "Failed", bg: "rgba(239,68,68,0.1)", color: "var(--accent-red)" },
  interrupted: { label: "Interrupted", bg: "rgba(239,68,68,0.1)", color: "var(--accent-red)" },
};

export function JobStatusPill({ status }: { status: JobStatus }) {
  const m = JOB_STATUS_META[status];
  return (
    <span
      style={{
        padding: "0.25rem 0.75rem",
        borderRadius: "12px",
        background: m.bg,
        color: m.color,
        fontSize: "0.8rem",
        whiteSpace: "nowrap",
      }}
    >
      {m.label}
    </span>
  );
}

/**
 * Determinate bar when the job reports a total, indeterminate otherwise.
 * Terraform cannot give a reliable completion ratio, so those jobs deliberately
 * report total=0 rather than showing a percentage that would be made up.
 */
export function JobProgress({ job, showPhase = true }: { job: JobRecord; showPhase?: boolean }) {
  const { current, total } = job.progress;
  const done = job.status === "succeeded";
  const bad = job.status === "failed" || job.status === "interrupted";
  const active = job.status === "running" || job.status === "queued";

  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null;
  const fill = bad ? "var(--accent-red)" : done ? "#10b981" : "#eab308";

  return (
    <div>
      <div
        style={{
          height: "6px",
          borderRadius: "3px",
          background: "rgba(255,255,255,0.08)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {pct === null && active ? (
          <div
            className="job-bar-indeterminate"
            style={{ position: "absolute", inset: 0, background: fill, opacity: 0.6 }}
          />
        ) : (
          <div
            style={{
              width: `${done || bad ? 100 : (pct ?? 0)}%`,
              height: "100%",
              background: fill,
              transition: "width 0.4s ease",
            }}
          />
        )}
      </div>
      {showPhase && (
        <div
          className="text-muted"
          style={{ fontSize: "0.75rem", marginTop: "0.35rem", display: "flex", gap: "0.5rem" }}
        >
          <span>{job.phase}</span>
          {pct !== null && <span>· {pct}%</span>}
          {total > 0 && (
            <span>
              · {current}/{total}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function jobDuration(job: JobRecord): string {
  const start = job.startedAt || job.createdAt;
  const end = job.finishedAt || new Date().toISOString();
  const secs = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
