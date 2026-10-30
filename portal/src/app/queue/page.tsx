"use client";

import { useCallback, useEffect, useState } from "react";
import { ListChecks, RefreshCw, ChevronDown, ChevronRight, PlayCircle } from "lucide-react";
import { JobProgress, JobStatusPill, jobDuration } from "@/components/JobProgress";
import type { JobRecord, JobCheckpoint } from "@/lib/jobs";

const POLL_MS = 3000;

const TYPE_LABELS: Record<string, string> = {
  "noop": "Self-test",
  "deploy-brain": "Deploy monitoring brain",
  "remove-brain": "Remove monitoring brain",
  "deploy-spoke": "Deploy scenario",
  "remove-spoke": "Tear down scenario",
  "sync-scenarios": "Sync scenarios from GitHub",
  "restore-custom": "Restore custom scenarios",
};

const CHECK_MARK: Record<JobCheckpoint["status"], { glyph: string; color: string; note?: string }> = {
  done: { glyph: "\u2713", color: "#10b981" },
  failed: { glyph: "\u2717", color: "var(--accent-red)" },
  manual: { glyph: "\u25CB", color: "#eab308", note: "manual step" },
  skipped: { glyph: "\u2013", color: "var(--text-muted)", note: "not applicable" },
  pending: { glyph: "\u22EF", color: "var(--text-muted)" },
};

function Checklist({ checkpoints }: { checkpoints: JobCheckpoint[] }) {
  if (!checkpoints || checkpoints.length === 0) return null;
  return (
    <div style={{ marginTop: "0.9rem" }}>
      {checkpoints.map(c => {
        const m = CHECK_MARK[c.status] ?? CHECK_MARK.pending;
        return (
          <div
            key={c.key}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "0.55rem",
              fontSize: "0.8rem",
              padding: "0.15rem 0",
            }}
          >
            <span style={{ color: m.color, fontWeight: 700, width: "1rem", flexShrink: 0 }}>
              {m.glyph}
            </span>
            <span style={{ color: c.status === "pending" ? "var(--text-muted)" : "var(--text-main)" }}>
              {c.label}
            </span>
            {m.note && (
              <span className="text-muted" style={{ fontSize: "0.7rem", opacity: 0.8 }}>
                ({m.note})
              </span>
            )}
            {c.detail && (
              <span className="text-muted" style={{ fontSize: "0.72rem" }}>
                — {c.detail}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function QueuePage() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // All setState happens after an await, so nothing fires synchronously in the effect.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      const data = await res.json();
      setJobs(data.jobs || []);
      setError(null);
    } catch {
      setError("Failed to load the process queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  async function startSelfTest() {
    setStarting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "noop" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start");
      setError(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start self-test.");
    } finally {
      setStarting(false);
    }
  }

  const active = jobs.filter(j => j.status === "running" || j.status === "queued");
  const recent = jobs.filter(j => j.status !== "running" && j.status !== "queued");

  return (
    <div>
      <header className="page-header">
        <h1>Process Queue</h1>
        <p className="text-muted">
          Long-running operations run on the server, so they keep going if you navigate away or close
          the tab. Start a deployment, leave this page, and come back to it here.
        </p>
      </header>

      {error && (
        <div
          className="glass-panel"
          style={{
            padding: "1rem",
            marginBottom: "1rem",
            borderColor: "var(--accent-red)",
            color: "var(--accent-red)",
            fontSize: "0.875rem",
          }}
        >
          {error}
        </div>
      )}

      <div className="glass-panel main-panel">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "1rem",
            marginBottom: "1.5rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <ListChecks size={20} className="accent-red" />
            <strong>{active.length}</strong>
            <span className="text-muted" style={{ fontSize: "0.875rem" }}>
              active · {recent.length} recent
            </span>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              className="btn btn-secondary"
              onClick={startSelfTest}
              disabled={starting}
              style={{ padding: "0.4rem 0.9rem", fontSize: "0.8rem" }}
              title="Runs a harmless 8-second job to verify the queue, progress bar and notifications"
            >
              <PlayCircle size={14} /> {starting ? "Starting..." : "Run self-test"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => load()}
              style={{ padding: "0.4rem 0.9rem", fontSize: "0.8rem" }}
            >
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </div>

        {loading && jobs.length === 0 ? (
          <div className="empty-state">
            <p className="text-muted">Loading...</p>
          </div>
        ) : jobs.length === 0 ? (
          <div className="empty-state">
            <p className="text-muted">Nothing queued or running.</p>
            <p className="text-muted" style={{ fontSize: "0.8rem" }}>
              Deployments and teardowns will appear here as they run. Use Run self-test to confirm the
              queue is working.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {[...active, ...recent].map(job => {
              const isOpen = expanded === job.id;
              return (
                <div
                  key={job.id}
                  style={{
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    padding: "0.9rem 1rem",
                    background: "rgba(255,255,255,0.02)",
                  }}
                >
                  <div
                    onClick={() => setExpanded(isOpen ? null : job.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      cursor: "pointer",
                      flexWrap: "wrap",
                    }}
                  >
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span style={{ color: "var(--text-main)", fontWeight: 600 }}>
                      {TYPE_LABELS[job.type] || job.type}
                    </span>
                    {job.accountId && (
                      <span className="text-muted mono" style={{ fontSize: "0.8rem" }}>
                        {job.accountId}
                      </span>
                    )}
                    {job.scenarioId && (
                      <span className="text-muted" style={{ fontSize: "0.8rem" }}>
                        {job.scenarioId}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", display: "flex", gap: "0.75rem", alignItems: "center" }}>
                      <span className="text-muted" style={{ fontSize: "0.75rem" }}>
                        {jobDuration(job)}
                      </span>
                      <JobStatusPill status={job.status} />
                    </span>
                  </div>

                  <div style={{ marginTop: "0.75rem" }}>
                    <JobProgress job={job} />
                  </div>

                  <Checklist checkpoints={job.checkpoints} />

                  {job.error && (
                    <p
                      className="accent-red"
                      style={{ fontSize: "0.8rem", marginTop: "0.6rem", marginBottom: 0 }}
                    >
                      {job.error}
                    </p>
                  )}

                  {isOpen && (
                    <div style={{ marginTop: "0.9rem", fontSize: "0.78rem" }}>
                      <div className="text-muted" style={{ marginBottom: "0.4rem" }}>
                        Step log
                      </div>
                      <div
                        style={{
                          background: "rgba(0,0,0,0.3)",
                          border: "1px solid var(--border-color)",
                          borderRadius: "6px",
                          padding: "0.6rem 0.8rem",
                          maxHeight: "220px",
                          overflowY: "auto",
                          fontFamily: "monospace",
                        }}
                      >
                        {job.steps.map((s, i) => (
                          <div key={i} className="text-muted">
                            <span style={{ opacity: 0.6 }}>
                              {s.at.slice(11, 19)}
                            </span>{" "}
                            {s.message}
                          </div>
                        ))}
                      </div>
                      <div className="text-muted mono" style={{ marginTop: "0.5rem", fontSize: "0.72rem" }}>
                        job {job.id}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
