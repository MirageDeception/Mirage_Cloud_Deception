"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import { Loader } from "@/components/Loader";
import { shortCaller } from "@/lib/mesh-paths";
import type { DetectionRecord, DetectionStatus } from "@/lib/detections";

// The status list is duplicated here rather than imported from lib/detections so
// the AWS SDK never lands in the client bundle (types are erased; values are not).
const STATUSES: DetectionStatus[] = ["active", "in_progress", "resolved"];
const STATUS_META: Record<DetectionStatus, { label: string; bg: string; color: string }> = {
  active: { label: "Active", bg: "rgba(239, 68, 68, 0.1)", color: "var(--accent-red)" },
  in_progress: { label: "In Progress", bg: "rgba(234, 179, 8, 0.12)", color: "#eab308" },
  resolved: { label: "Resolved", bg: "rgba(16, 185, 129, 0.1)", color: "#10b981" },
};

const POLL_MS = 10000;

// Every decoy touch is an incident; one that worked is worse than one AWS refused.
const failed = (d: DetectionRecord) =>
  d.actionStatus === "FAILED" || (!!d.errorCode && d.errorCode !== "None");
const severity = (d: DetectionRecord) =>
  failed(d)
    ? { label: "High", bg: "rgba(249, 115, 22, 0.15)", color: "#f97316" }
    : { label: "Critical", bg: "var(--accent-red)", color: "#fff" };

/** "17h 30m", "1w 3h", "2d 5h": time since the alert, two largest units. */
function age(ts: string, now: number): string {
  let s = Math.max(0, Math.floor((now - Date.parse(ts)) / 1000));
  const parts: string[] = [];
  for (const [unit, size] of [["w", 604800], ["d", 86400], ["h", 3600], ["m", 60]] as const) {
    if (s >= size) { parts.push(`${Math.floor(s / size)}${unit}`); s %= size; }
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "just now";
}

const when = (ts?: string) => (ts ? new Date(ts).toLocaleString() : "—");
const title = (d: DetectionRecord) => `${d.eventName} on ${d.resourceName}`;

const th: React.CSSProperties = {
  textAlign: "left", padding: "0.6rem 0.75rem", fontWeight: 600, fontSize: "0.75rem",
  color: "var(--text-muted)", borderBottom: "1px solid var(--border-color)", whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "0.75rem", fontSize: "0.85rem", borderBottom: "1px solid var(--border-color)",
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "260px",
};
const pill = (bg: string, color: string): React.CSSProperties => ({
  padding: "0.2rem 0.65rem", borderRadius: "6px", background: bg, color,
  fontSize: "0.75rem", fontWeight: 600, whiteSpace: "nowrap",
});

export default function AlertsPage() {
  const [detections, setDetections] = useState<DetectionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState("all");
  const [open, setOpen] = useState<Record<DetectionStatus, boolean>>({ active: true, in_progress: false, resolved: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "timeline" | "raw">("overview");
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());

  // Every setState here happens after an await, never synchronously. `loading`
  // starts true so the first fetch is covered without setting it here, which
  // also keeps the overlay off manual refreshes and 10s polls.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/detections");
      const data = await res.json();
      setDetections(data.detections || []);
      setNow(Date.now());
      setError(null);
    } catch {
      setError("Failed to load alerts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Both the first fetch and the poll run from timer callbacks rather than the
    // effect body, so no setState is ever called synchronously during the effect.
    const first = setTimeout(load, 0);
    const timer = setInterval(() => {
      // A hidden tab has nobody to read the feed; skip the DynamoDB read.
      if (document.visibilityState !== "hidden") load();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  async function setStatus(targets: DetectionRecord[], status: DetectionStatus) {
    const keys = new Set(targets.map((t) => t.sk));
    const snapshot = detections;
    const at = new Date().toISOString();
    setUpdating((u) => ({ ...u, ...Object.fromEntries([...keys].map((k) => [k, true])) }));
    setDetections((list) => list.map((d) => (keys.has(d.sk)
      ? { ...d, status, updatedAt: at, statusHistory: [...(d.statusHistory ?? []), { status, at }] }
      : d)));

    try {
      await Promise.all(targets.map(async (t) => {
        const res = await fetch("/api/detections", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pk: t.pk, sk: t.sk, status }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Update failed (${res.status})`);
        }
      }));
      setError(null);
    } catch (err) {
      setDetections(snapshot); // roll back the optimistic change
      setError(err instanceof Error ? err.message : "Failed to update alert status.");
      load(); // resync with the server: some of a bulk change may have landed
    } finally {
      setUpdating((u) => Object.fromEntries(Object.entries(u).filter(([k]) => !keys.has(k))));
    }
  }

  const accounts = [...new Set(detections.map((d) => d.accountId).filter(Boolean))].sort();
  const q = query.trim().toLowerCase();
  const visible = detections.filter((d) =>
    (account === "all" || d.accountId === account) &&
    (!q || [d.eventName, d.resourceName, d.callerArn, d.sourceIp, d.id, d.awsRegion]
      .some((v) => v?.toLowerCase().includes(q))));
  const byStatus = (s: DetectionStatus) => visible.filter((d) => d.status === s);
  const picked = detections.filter((d) => selected.has(d.sk));
  const cur = detections.find((d) => d.sk === current) ?? null;

  const toggle = (keys: string[], on: boolean) =>
    setSelected((sel) => {
      const next = new Set(sel);
      for (const k of keys) { if (on) next.add(k); else next.delete(k); }
      return next;
    });

  return (
    <div>
      <Loader active={loading} text="Loading alerts..." />

      <header className="page-header">
        <h1>Alerts</h1>
        <p className="text-muted">
          Every alert is a confirmed decoy interaction. There are no legitimate uses for these
          resources, so each one is a real signal rather than something to triage away.
        </p>
      </header>

      {error && (
        <div className="glass-panel" style={{ padding: "1rem", marginBottom: "1rem", borderColor: "var(--accent-red)", color: "var(--accent-red)", fontSize: "0.875rem" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", marginBottom: "1rem" }}>
        <div style={{ position: "relative", flex: "1 1 260px", maxWidth: "420px" }}>
          <Search size={14} className="text-muted" style={{ position: "absolute", left: "0.75rem", top: "50%", transform: "translateY(-50%)" }} />
          <input
            className="input-field"
            placeholder="Search event, decoy, caller, IP, alert ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ paddingLeft: "2.1rem", width: "100%" }}
            aria-label="Search alerts"
          />
        </div>
        <select className="input-field" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account" style={{ width: "auto" }}>
          <option value="all">All accounts</option>
          {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <button className="btn btn-secondary" onClick={() => load()} style={{ padding: "0.5rem 0.9rem", fontSize: "0.8rem" }}>
          <RefreshCw size={14} /> Refresh
        </button>
        {picked.length > 0 && (
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginLeft: "auto", flexWrap: "wrap" }}>
            <span className="text-muted" style={{ fontSize: "0.8rem" }}>{picked.length} selected</span>
            {STATUSES.map((s) => (
              <button key={s} className="btn btn-secondary" style={{ padding: "0.4rem 0.8rem", fontSize: "0.78rem" }}
                onClick={() => { setStatus(picked, s); setSelected(new Set()); }}>
                {s === "resolved" ? "Resolve" : `Mark ${STATUS_META[s].label.toLowerCase()}`}
              </button>
            ))}
            <button className="btn btn-secondary" style={{ padding: "0.4rem 0.8rem", fontSize: "0.78rem" }} onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {detections.length === 0 && !loading ? (
            <div className="glass-panel empty-state">
              <p className="text-muted">No alerts yet — any decoy access will appear here within seconds.</p>
              <p className="text-muted" style={{ fontSize: "0.8rem" }}>
                Alerts are written to DynamoDB by the hub brain Lambda, so this feed is empty on a
                dev portal running STORAGE_BACKEND=local.
              </p>
            </div>
          ) : STATUSES.map((s) => {
            const rows = byStatus(s);
            const keys = rows.map((d) => d.sk);
            const allOn = keys.length > 0 && keys.every((k) => selected.has(k));
            return (
              <section key={s} className="glass-panel" style={{ padding: 0, overflow: "hidden" }}>
                <button
                  onClick={() => setOpen((o) => ({ ...o, [s]: !o[s] }))}
                  aria-expanded={open[s]}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.9rem 1rem", background: "none", border: "none", color: "var(--text-main)", cursor: "pointer", fontSize: "1rem", fontWeight: 600 }}
                >
                  {open[s] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  {STATUS_META[s].label}
                  <span style={pill("rgba(148, 163, 184, 0.15)", "var(--text-muted)")}>{rows.length}</span>
                </button>
                {open[s] && (rows.length === 0 ? (
                  <p className="text-muted" style={{ padding: "0 1rem 1rem 2.6rem", fontSize: "0.85rem" }}>
                    No {STATUS_META[s].label.toLowerCase()} alerts{q || account !== "all" ? " match the filters" : ""}.
                  </p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "auto" }}>
                      <thead>
                        <tr>
                          <th style={{ ...th, width: "2.5rem" }}>
                            <input type="checkbox" checked={allOn} onChange={() => toggle(keys, !allOn)} aria-label={`Select all ${STATUS_META[s].label} alerts`} />
                          </th>
                          <th style={th}>Severity</th>
                          <th style={th}>State</th>
                          <th style={th}>Age</th>
                          <th style={th}>Alert ID</th>
                          <th style={th}>Title</th>
                          <th style={th}>Who</th>
                          <th style={th}>Source IP</th>
                          <th style={th}>Account / Region</th>
                          <th style={th}>Created</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((d) => {
                          const sev = severity(d);
                          const isCur = d.sk === current;
                          return (
                            <tr
                              key={d.sk}
                              tabIndex={0}
                              onClick={() => { setCurrent(isCur ? null : d.sk); setTab("overview"); }}
                              onKeyDown={(e) => { if (e.key === "Enter") { setCurrent(isCur ? null : d.sk); setTab("overview"); } }}
                              style={{ cursor: "pointer", background: isCur ? "rgba(239, 68, 68, 0.08)" : undefined, opacity: updating[d.sk] ? 0.6 : 1 }}
                            >
                              <td style={td} onClick={(e) => e.stopPropagation()}>
                                <input type="checkbox" checked={selected.has(d.sk)} onChange={(e) => toggle([d.sk], e.target.checked)} aria-label={`Select ${title(d)}`} />
                              </td>
                              <td style={td}><span style={pill(sev.bg, sev.color)}>{sev.label}</span></td>
                              <td style={td}>{STATUS_META[d.status].label}</td>
                              <td style={{ ...td, color: d.status === "resolved" ? "var(--text-muted)" : "var(--accent-red)" }}>{age(d.timestamp, now)}</td>
                              <td style={{ ...td, fontFamily: "monospace", textDecoration: "underline", textUnderlineOffset: "3px" }} title={d.id}>#{d.id.slice(0, 8)}</td>
                              <td style={{ ...td, color: "var(--text-main)", fontWeight: 500 }} title={title(d)}>{title(d)}</td>
                              <td style={td} title={d.callerArn}>{d.callerArn ? shortCaller(d.callerArn) : "—"}</td>
                              <td style={{ ...td, fontFamily: "monospace" }}>{d.sourceIp || "—"}</td>
                              <td style={td}>{d.accountId} / {d.awsRegion || "—"}</td>
                              <td style={td} title={d.timestamp}>{when(d.timestamp)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </section>
            );
          })}
        </div>

        {cur && (
          <aside
            className="glass-panel alert-panel"
            aria-label="Alert details"
            style={{ width: "480px", flexShrink: 0, padding: "1.25rem", position: "sticky", top: "1rem", maxHeight: "calc(100vh - 2rem)", overflowY: "auto" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
              <span className="text-muted" style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>#{cur.id.slice(0, 8)}</span>
              <button onClick={() => setCurrent(null)} aria-label="Close" style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer" }}>
                <X size={18} />
              </button>
            </div>
            <h2 style={{ fontSize: "1.25rem", margin: "0 0 0.35rem", wordBreak: "break-word" }}>{title(cur)}</h2>
            <p className="text-muted" style={{ fontSize: "0.8rem", margin: "0 0 1rem" }}>
              Opened {when(cur.timestamp)}{cur.updatedAt ? ` · Updated ${when(cur.updatedAt)}` : ""}
            </p>

            <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap", marginBottom: "1.25rem" }}>
              <span style={pill(severity(cur).bg, severity(cur).color)}>{severity(cur).label}</span>
              <span style={{ ...pill("transparent", "var(--accent-red)"), padding: 0 }}>{age(cur.timestamp, now)}</span>
              <select
                className="input-field"
                value={cur.status}
                disabled={!!updating[cur.sk]}
                onChange={(e) => setStatus([cur], e.target.value as DetectionStatus)}
                aria-label="State"
                style={{ width: "auto", padding: "0.35rem 0.6rem" }}
              >
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
              </select>
              <button
                className="btn btn-secondary"
                disabled={!!updating[cur.sk]}
                onClick={() => setStatus([cur], cur.status === "resolved" ? "active" : "resolved")}
                style={{ padding: "0.4rem 0.8rem", fontSize: "0.8rem" }}
              >
                {cur.status === "resolved" ? "Reopen" : "Resolve"}
              </button>
            </div>

            <div role="tablist" style={{ display: "flex", gap: "1.25rem", borderBottom: "1px solid var(--border-color)", marginBottom: "1rem" }}>
              {(["overview", "timeline", "raw"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: "0.5rem 0", fontSize: "0.9rem", fontWeight: tab === t ? 600 : 400, color: tab === t ? "var(--text-main)" : "var(--text-muted)", borderBottom: tab === t ? "2px solid var(--accent-red)" : "2px solid transparent" }}
                >
                  {t === "overview" ? "Overview" : t === "timeline" ? "Timeline" : "Raw event"}
                </button>
              ))}
            </div>

            {tab === "overview" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.9rem" }}>
                <Field label="Who" value={cur.callerArn} wide />
                <Field label="Source IP" value={cur.sourceIp} />
                <Field label="Region" value={cur.awsRegion} />
                <Field label="Account" value={cur.accountId} />
                <Field label="Event" value={cur.eventName} />
                <Field label="Decoy" value={cur.resourceName} />
                <Field label="Type" value={cur.resourceType || cur.source} />
                <Field label="Result" value={failed(cur) ? `Denied${cur.errorCode && cur.errorCode !== "None" ? ` (${cur.errorCode})` : ""}` : "Succeeded"} />
                <Field label="Alert ID" value={cur.id} />
                {cur.errorMessage && cur.errorMessage !== "None" && <Field label="Error" value={cur.errorMessage} wide />}
              </div>
            )}

            {tab === "timeline" && (
              <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.9rem" }}>
                <TimelineItem at={cur.timestamp} text={`Detected: ${cur.eventName} by ${cur.callerArn ? shortCaller(cur.callerArn) : "unknown"}${cur.sourceIp ? ` from ${cur.sourceIp}` : ""}`} />
                {(cur.statusHistory ?? []).map((c, i) => (
                  <TimelineItem key={i} at={c.at} text={`Marked ${STATUS_META[c.status].label}`} />
                ))}
                {!cur.statusHistory?.length && cur.updatedAt && (
                  // Status changed before the timeline was recorded: only the last change is known.
                  <TimelineItem at={cur.updatedAt} text={`Marked ${STATUS_META[cur.status].label}`} />
                )}
              </ol>
            )}

            {tab === "raw" && (
              <pre style={{ background: "rgba(0,0,0,0.35)", border: "1px solid var(--border-color)", borderRadius: "8px", padding: "1rem", overflowX: "auto", fontSize: "0.75rem", color: "var(--text-muted)", margin: 0 }}>
                {cur.rawDetail ? prettyJson(cur.rawDetail) : "No raw event stored for this alert."}
              </pre>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, wide }: { label: string; value?: string; wide?: boolean }) {
  return (
    <div style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <div className="text-muted" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ color: "var(--text-main)", wordBreak: "break-all", fontSize: "0.85rem" }}>{value || "—"}</div>
    </div>
  );
}

function TimelineItem({ at, text }: { at: string; text: string }) {
  return (
    <li style={{ display: "flex", gap: "0.75rem" }}>
      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent-red)", marginTop: "0.4rem", flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: "0.85rem", color: "var(--text-main)" }}>{text}</div>
        <div className="text-muted" style={{ fontSize: "0.75rem" }}>{new Date(at).toLocaleString()}</div>
      </div>
    </li>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
