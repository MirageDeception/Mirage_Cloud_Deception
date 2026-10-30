"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import type { JobRecord, JobStatus } from "@/lib/jobs";

const POLL_MS = 5000;
/** Terminal jobs already acknowledged, so a reload does not re-announce them. */
const SEEN_KEY = "mirage_seen_job_ids";

const TYPE_LABELS: Record<string, string> = {
  "noop": "Self-test",
  "deploy-brain": "Monitoring brain deployment",
  "remove-brain": "Monitoring brain removal",
  "deploy-spoke": "Scenario deployment",
  "remove-spoke": "Scenario teardown",
  "sync-scenarios": "Scenario sync from GitHub",
  "restore-custom": "Custom scenario restore",
};

interface Note {
  id: string;
  status: JobStatus;
  title: string;
  detail?: string;
  at: string;
}

function iconFor(status: JobStatus) {
  if (status === "succeeded") return <CheckCircle2 size={15} style={{ color: "#10b981" }} />;
  if (status === "interrupted") return <AlertTriangle size={15} style={{ color: "#eab308" }} />;
  return <XCircle size={15} style={{ color: "var(--accent-red)" }} />;
}

/**
 * Derives notifications from server-side job records rather than local state, so
 * they are the same truth the Process Queue shows, survive a page reload, and are
 * visible to whoever is looking at this portal -- not just the browser that
 * happened to start the operation.
 */
export function NotificationBell() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const seenRef = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    // Initialise the seen-set on first run. Everything already terminal at that
    // point is treated as seen, so opening the portal does not dump a backlog.
    let firstRun = false;
    if (seenRef.current === null) {
      firstRun = true;
      try {
        seenRef.current = new Set<string>(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"));
      } catch {
        seenRef.current = new Set<string>();
      }
    }
    const seen = seenRef.current;

    try {
      const res = await fetch("/api/jobs");
      const data = await res.json();
      const jobs: JobRecord[] = data.jobs || [];
      const terminal = jobs.filter(j =>
        j.status === "succeeded" || j.status === "failed" || j.status === "interrupted",
      );

      const fresh = terminal.filter(j => !seen.has(j.id));
      if (fresh.length > 0) {
        for (const j of fresh) seen.add(j.id);
        try {
          localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
        } catch {
          // storage full or blocked: notifications still work for this session
        }
      }

      setNotes(
        terminal.slice(0, 30).map(j => ({
          id: j.id,
          status: j.status,
          title: `${TYPE_LABELS[j.type] || j.type} ${j.status}`,
          detail: j.error || (j.accountId ? `Account ${j.accountId}` : undefined),
          at: j.finishedAt || j.createdAt,
        })),
      );

      if (!firstRun && fresh.length > 0) setUnread(u => u + fresh.length);
    } catch {
      // A failed poll is not worth surfacing in the bell.
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

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div ref={panelRef} style={{ position: "relative" }}>
      <button
        aria-label="Notifications"
        onClick={() => {
          setOpen(o => !o);
          setUnread(0);
        }}
        style={{
          position: "relative",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          padding: "0.25rem",
          display: "flex",
          alignItems: "center",
        }}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span
            style={{
              position: "absolute",
              top: "-2px",
              right: "-2px",
              minWidth: "16px",
              height: "16px",
              borderRadius: "8px",
              background: "var(--accent-red)",
              color: "#fff",
              fontSize: "0.62rem",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 4px",
            }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="glass-panel"
          style={{
            position: "absolute",
            top: "calc(100% + 0.6rem)",
            left: 0,
            width: "320px",
            maxHeight: "380px",
            overflowY: "auto",
            zIndex: 50,
            padding: "0.5rem",
          }}
        >
          {notes.length === 0 ? (
            <p className="text-muted" style={{ fontSize: "0.8rem", padding: "0.75rem", margin: 0 }}>
              No completed operations yet.
            </p>
          ) : (
            notes.map(n => (
              <div
                key={n.id}
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  padding: "0.6rem 0.5rem",
                  borderBottom: "1px solid var(--border-color)",
                  fontSize: "0.8rem",
                }}
              >
                <span style={{ marginTop: "2px", flexShrink: 0 }}>{iconFor(n.status)}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--text-main)" }}>{n.title}</div>
                  {n.detail && (
                    <div className="text-muted" style={{ fontSize: "0.72rem", wordBreak: "break-word" }}>
                      {n.detail}
                    </div>
                  )}
                  <div className="text-muted" style={{ fontSize: "0.68rem", opacity: 0.7 }}>
                    {n.at.replace("T", " ").slice(0, 19)}
                  </div>
                </div>
              </div>
            ))
          )}
          <a
            href="/queue"
            className="text-muted"
            style={{ display: "block", padding: "0.6rem 0.5rem", fontSize: "0.78rem" }}
          >
            View the full process queue →
          </a>
        </div>
      )}
    </div>
  );
}
