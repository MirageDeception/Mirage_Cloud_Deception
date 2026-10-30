"use client";

import { useState, useEffect } from "react";
import { AlertCircle } from "lucide-react";
import type { HistoryEvent } from "@/lib/history";

export interface HistoryTabProps {
  active: boolean;
}

export function HistoryTab({ active }: HistoryTabProps) {

  // History State
  const [historyEvents, setHistoryEvents] = useState<HistoryEvent[]>([]);
  const [historyFilter, setHistoryFilter] = useState<'both' | 'scenarios' | 'rules' | 'trust_policy'>('both');
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const fetchHistory = async () => {
    setIsLoadingHistory(true);
    try {
      const res = await fetch("/api/history");
      if (res.ok) {
        const data = await res.json();
        setHistoryEvents(data.events || []);
      }
    } catch (err) {
      console.error("Failed to fetch history", err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  // Loads each time the tab is shown, as the page's tab effect did.
  useEffect(() => {
    if (!active) return;
    // From a timer, not the effect body, so no setState runs synchronously in the effect.
    const first = setTimeout(fetchHistory, 0);
    return () => clearTimeout(first);
  }, [active]);

  return (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* Filter Pills */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span className="text-muted" style={{ fontSize: "0.875rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>Show:</span>
            {([['both', 'All Events'], ['scenarios', 'Scenario Events'], ['rules', 'Rule Events'], ['trust_policy', 'Trust Policy Events']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setHistoryFilter(key)}
                style={{
                  padding: "0.4rem 1rem",
                  borderRadius: "20px",
                  border: `1px solid ${historyFilter === key ? "var(--accent-red)" : "var(--border-color)"}`,
                  background: historyFilter === key ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.04)",
                  color: historyFilter === key ? "var(--accent-red)" : "var(--text-muted)",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                  fontWeight: historyFilter === key ? 600 : 400,
                  transition: "all 0.2s"
                }}
              >
                {label}
              </button>
            ))}
            <button onClick={fetchHistory} style={{ marginLeft: "auto", padding: "0.4rem 1rem", borderRadius: "8px", border: "1px solid var(--border-color)", background: "transparent", color: "var(--text-muted)", fontSize: "0.8rem", cursor: "pointer" }}>↻ Refresh</button>
          </div>

          {isLoadingHistory ? (
            <div className="glass-panel" style={{ padding: "3rem", textAlign: "center" }}>
              <p className="spinner-text text-muted">Loading history...</p>
            </div>
          ) : (() => {
            const filteredEvents = historyEvents.filter(e => {
              if (historyFilter === 'scenarios') return e.type === 'scenario_deploy' || e.type === 'scenario_teardown';
              if (historyFilter === 'rules') return e.type === 'rule_generate' || e.type === 'rule_push' || e.type === 'rule_teardown';
              if (historyFilter === 'trust_policy') return e.type === 'trust_policy_update' || e.type === 'trust_policy_teardown';
              return true;
            });

            if (filteredEvents.length === 0) {
              return (
                <div className="empty-state glass-panel">
                  <AlertCircle size={48} className="text-muted" />
                  <h3>No History Yet</h3>
                  <p className="text-muted">Deploy scenarios to start tracking events.</p>
                </div>
              );
            }

            // Group by sessionId
            const sessions: Record<string, HistoryEvent[]> = {};
            for (const e of filteredEvents) {
              if (!sessions[e.sessionId]) sessions[e.sessionId] = [];
              sessions[e.sessionId].push(e);
            }

            const eventTypeConfig: Record<string, { label: string; icon: string; color: string }> = {
              scenario_deploy: { label: "Scenario Deploy", icon: "🛡️", color: "#6366f1" },
              rule_generate:   { label: "Rule Generated",  icon: "⚙️", color: "#f59e0b" },
              rule_push:       { label: "Rule Pushed to AWS", icon: "🚀", color: "#10b981" },
              trust_policy_update: { label: "Trust Policy Updated", icon: "🔐", color: "#8b5cf6" },
              scenario_teardown: { label: "Scenario Teardown", icon: "🗑️", color: "#ef4444" },
              rule_teardown:   { label: "Rule Deleted", icon: "✂️", color: "#f97316" },
              trust_policy_teardown: { label: "Trust Policy Cleaned", icon: "🧹", color: "#d946ef" }
            };

            return Object.entries(sessions).map(([sid, events]) => {
              const sessionStart = events[events.length - 1]?.timestamp;
              const successCount = events.filter(e => e.status === 'success').length;
              const failedCount = events.filter(e => e.status === 'failed').length;

              return (
                <div key={sid} className="glass-panel" style={{ padding: "1.5rem" }}>
                  {/* Session Header */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem", paddingBottom: "0.75rem", borderBottom: "1px solid var(--border-color)" }}>
                    <div>
                      <h4 style={{ margin: 0, marginBottom: "4px" }}>Deploy Session</h4>
                      <p className="text-muted mono" style={{ margin: 0, fontSize: "0.8rem" }}>
                        {new Date(sessionStart).toLocaleString()}
                      </p>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      {successCount > 0 && <span style={{ padding: "0.2rem 0.6rem", borderRadius: "12px", background: "rgba(16,185,129,0.12)", color: "#10b981", fontSize: "0.8rem" }}>{successCount} ✓</span>}
                      {failedCount > 0 && <span style={{ padding: "0.2rem 0.6rem", borderRadius: "12px", background: "rgba(239,68,68,0.12)", color: "var(--accent-red)", fontSize: "0.8rem" }}>{failedCount} ✗</span>}
                    </div>
                  </div>

                  {/* Timeline */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    {events.map((event, idx) => {
                      const cfg = eventTypeConfig[event.type] || { label: event.type, icon: "•", color: "#888" };
                      const isLast = idx === events.length - 1;
                      return (
                        <div key={event.id} style={{ display: "flex", gap: "1rem" }}>
                          {/* Left: dot + vertical line */}
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "20px", flexShrink: 0 }}>
                            <div style={{
                              width: "12px", height: "12px", borderRadius: "50%", flexShrink: 0, marginTop: "4px",
                              background: event.status === 'success' ? cfg.color : "var(--accent-red)",
                              boxShadow: `0 0 6px ${event.status === 'success' ? cfg.color : "var(--accent-red)"}55`
                            }} />
                            {!isLast && <div style={{ width: "2px", flex: 1, minHeight: "24px", background: "var(--border-color)", marginTop: "2px" }} />}
                          </div>

                          {/* Right: content */}
                          <div style={{ paddingBottom: isLast ? 0 : "1.25rem", flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "2px" }}>
                              <span style={{ fontSize: "1rem" }}>{cfg.icon}</span>
                              <span style={{ fontWeight: 600, fontSize: "0.9rem", color: event.status === 'success' ? cfg.color : "var(--accent-red)" }}>{cfg.label}</span>
                              <span style={{ padding: "0.1rem 0.5rem", borderRadius: "8px", fontSize: "0.75rem", background: event.status === 'success' ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)", color: event.status === 'success' ? "#10b981" : "var(--accent-red)" }}>
                                {event.status === 'success' ? '✓ Success' : '✗ Failed'}
                              </span>
                            </div>
                            <p className="text-muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                              <span style={{ color: "var(--text-main)" }}>{event.scenarioName}</span>
                              {event.ruleName && <> → <span className="mono" style={{ color: "var(--text-muted)" }}>{event.ruleName}</span></>}
                              <span style={{ marginLeft: "0.75rem", opacity: 0.6 }}>{new Date(event.timestamp).toLocaleTimeString()}</span>
                            </p>
                            {event.error && (
                              <div style={{ marginTop: "0.4rem", padding: "0.4rem 0.75rem", borderRadius: "6px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", fontSize: "0.8rem", color: "var(--accent-red)", fontFamily: "monospace" }}>
                                {event.error}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            });
          })()}
        </div>
  );
}
