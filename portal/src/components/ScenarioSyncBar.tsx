"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";

/**
 * Catalog header line for the GitHub scenario sync: where the official scenarios
 * came from, when, and whether the last sync worked -- plus "Sync now".
 *
 * Deliberately does NOT sync on page load: a sync only happens from this button
 * or the server's 24h schedule. While a sync runs (from either), it follows the
 * job and reloads the catalog when it finishes.
 */
interface SyncStatus {
  repoUrl: string;
  ref: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  result: "ok" | "partial" | "failed" | null;
  commit: string | null;
  added: string[];
  changed: string[];
  removed: string[];
  rejected: { id: string; errors: string[]; keptPrevious: boolean }[];
  error: string | null;
  runningJobId: string | null;
  autoSync: boolean;
  stale: boolean;
}

const POLL_MS = 3000;

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export function ScenarioSyncBar({ onSynced }: { onSynced: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/scenarios/sync", { cache: "no-store" });
      const s: SyncStatus = await res.json();
      setStatus(s);
      if (s.runningJobId) setJobId(s.runningJobId);
    } catch {
      setRequestError("Could not read the sync status.");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    return () => clearTimeout(first);
  }, [load]);

  // Follow a running sync until it ends, then refresh status + catalog.
  useEffect(() => {
    if (!jobId) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        const { job } = await res.json();
        if (job && !["queued", "running"].includes(job.status)) {
          setJobId(null);
          await load();
          onSynced();
        }
      } catch { /* keep polling; a transient error is not a result */ }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [jobId, load, onSynced]);

  const syncNow = async () => {
    setRequestError(null);
    try {
      const res = await fetch("/api/scenarios/sync", { method: "POST" });
      const body = await res.json();
      if (body.jobId) setJobId(body.jobId);
      else setRequestError(body.error || "Could not start the sync.");
    } catch {
      setRequestError("Could not start the sync.");
    }
  };

  if (!status) return null;
  const running = !!jobId;
  const failed = status.result === "failed";
  const neverSynced = !status.lastSuccessAt;

  let tone = "#10b981", Icon = CheckCircle2, text: string;
  if (running) {
    tone = "#60a5fa"; Icon = RefreshCw; text = "Syncing official scenarios from GitHub…";
  } else if (failed) {
    tone = "var(--accent-red)"; Icon = XCircle;
    text = `Last sync failed ${ago(status.lastAttemptAt)}: ${status.error}. ` +
      (neverSynced ? "Showing the scenarios bundled with this install." : `Showing the version synced ${ago(status.lastSuccessAt)}.`);
  } else if (neverSynced) {
    tone = "#94a3b8"; Icon = Info;
    text = "Official scenarios: the set bundled with this install — not synced from GitHub yet.";
  } else {
    if (status.stale) { tone = "var(--accent-red)"; Icon = AlertTriangle; }
    else if (status.result === "partial") { tone = "#f59e0b"; Icon = AlertTriangle; }
    const counts = [
      status.added.length && `${status.added.length} added`,
      status.changed.length && `${status.changed.length} updated`,
      status.removed.length && `${status.removed.length} removed`,
      status.rejected.length && `${status.rejected.length} rejected`,
    ].filter(Boolean).join(", ");
    text = `Official scenarios synced from GitHub ${ago(status.lastSuccessAt)}` +
      (status.commit ? ` · ${status.commit.slice(0, 7)}` : "") +
      (counts ? ` · ${counts}` : "") +
      (status.stale ? " · no successful sync for over 48 h" : "");
  }

  return (
    <div className="glass-panel" style={{ padding: "0.75rem 1rem", marginBottom: "1rem", borderLeft: `3px solid ${tone}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <Icon size={18} style={{ color: tone, flexShrink: 0 }} className={running ? "spinner" : undefined} />
        <span style={{ flex: 1, minWidth: "200px", fontSize: "0.875rem" }}>{text}</span>
        {status.rejected.length > 0 && !running && (
          <button className="btn btn-secondary" style={{ fontSize: "0.8rem" }} onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? "Hide details" : "Details"}
          </button>
        )}
        <button className="btn btn-secondary" style={{ fontSize: "0.8rem" }} onClick={syncNow} disabled={running}>
          <RefreshCw size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          {running ? "Syncing…" : "Sync now"}
        </button>
      </div>
      {requestError && <p style={{ margin: "0.5rem 0 0", color: "var(--accent-red)", fontSize: "0.8rem" }}>{requestError}</p>}
      {showDetails && (
        <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem", fontSize: "0.8rem" }} className="text-muted">
          {status.rejected.map((r) => (
            <li key={r.id}>
              <strong>{r.id}</strong> — {r.errors.join("; ")}
              {r.keptPrevious ? " (previous version kept)" : " (not added)"}
            </li>
          ))}
        </ul>
      )}
      {!running && (
        <p className="text-muted" style={{ margin: "0.35rem 0 0", fontSize: "0.75rem" }}>
          Source: {status.repoUrl} ({status.ref}) · {status.autoSync ? "syncs automatically every 24 h" : "automatic sync is off"}
        </p>
      )}
    </div>
  );
}
