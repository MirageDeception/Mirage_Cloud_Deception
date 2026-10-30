"use client";

import { useState, useEffect, useRef } from "react";
import { ShieldAlert, Network, AlertCircle, Bell, CheckCircle2, XCircle, Info } from "lucide-react";
import type { RuleRecord } from "@/lib/db";
import type { BrainRecord } from "@/lib/brains";
import { type Scenario, type Notification, type ActiveScenario, type Tab, type InventoryItem, ACCOUNT_ID_RE, PREFIX } from "./shared";
import { CatalogTab } from "./CatalogTab";
import { ActiveTab } from "./ActiveTab";
import { RulesTab } from "./RulesTab";
import { HistoryTab } from "./HistoryTab";

export default function Catalog() {
  const [activeTab, setActiveTab] = useState<Tab>("catalog");

  // Notification State
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const unreadCount = notifications.filter(n => !n.read).length;
  const notificationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const addNotification = (type: Notification['type'], status: Notification['status'], message: string, details?: string) => {
    const newNotif: Notification = {
      id: Math.random().toString(36).substring(2, 9),
      type,
      status,
      message,
      details,
      timestamp: new Date().toISOString(),
      read: false
    };
    setNotifications(prev => {
      const updated = [newNotif, ...prev];
      localStorage.setItem('mirage_notifications', JSON.stringify(updated.slice(0, 50))); // Keep last 50
      return updated;
    });
  };

  useEffect(() => {
    // From a timer, not the effect body, so no setState runs synchronously in the effect.
    const first = setTimeout(() => {
      const saved = localStorage.getItem('mirage_notifications');
      if (saved) {
        try { setNotifications(JSON.parse(saved)); } catch { /* corrupt or old: start empty */ }
      }
    }, 0);
    return () => clearTimeout(first);
  }, []);

  // Global Spoke Auth State
  const [globalAccountId, setGlobalAccountId] = useState("");
  const [globalRoleArn, setGlobalRoleArn] = useState("");
  const [hubBusArn, setHubBusArn] = useState("");
  const [forwardingRoleArn, setForwardingRoleArn] = useState("");
  // Deploy region (multi-region: decoys can go to different regions per deploy).
  const [deployRegion, setDeployRegion] = useState("us-west-2");
  // Derived ARNs are hidden by default: showing them made the panel four rows tall.
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [activeBrain, setActiveBrain] = useState<BrainRecord | null>(null);

  // Non-empty but not a valid account id: the only state that should warn.
  const accountIdInvalid =
    globalAccountId.length > 0 && !ACCOUNT_ID_RE.test(globalAccountId);

  const handleAccountIdChange = (val: string) => {
    const trimmed = val.trim();
    setGlobalAccountId(trimmed);
    if (ACCOUNT_ID_RE.test(trimmed)) {
      // Spoke-side roles are derived from the entered spoke account id (scales to
      // any new spoke). The hub bus, however, lives in the HUB account and is the
      // source of truth from the registered brain - never fabricated from the
      // spoke id. If no brain is registered, leave the bus ARN empty so the
      // deploy is blocked with a clear "deploy a brain first" error rather than
      // silently targeting a nonexistent bus.
      setGlobalRoleArn(`arn:aws:iam::${trimmed}:role/${PREFIX}-spoke-deployment-role`);
      setForwardingRoleArn(`arn:aws:iam::${trimmed}:role/${PREFIX}-forwarding-role`);
      setHubBusArn(activeBrain?.globalBusArn || '');
    } else {
      setGlobalRoleArn('');
      setForwardingRoleArn('');
      setHubBusArn('');
    }
  };

  // Every spoke has the same role names, so a deployed rule takes its roles from its
  // own account; the top box (and its Advanced edits) applies only to that account.
  const forwardingRoleFor = (accountId: string) =>
    (accountId === globalAccountId && forwardingRoleArn) || `arn:aws:iam::${accountId}:role/${PREFIX}-forwarding-role`;
  const busArn = hubBusArn || activeBrain?.globalBusArn || '';

  // Catalog State
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [isLoadingScenarios, setIsLoadingScenarios] = useState(true);
  const [scenariosVersion, setScenariosVersion] = useState(0);
  

  // Active Scenarios State (LocalStorage)
  const [activeScenarios, setActiveScenarios] = useState<ActiveScenario[]>([]);
  const [selectedActiveAccount, setSelectedActiveAccount] = useState<string>("all");


  // Active Rules State
  const [rules, setRules] = useState<RuleRecord[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [selectedRule, setSelectedRule] = useState<RuleRecord | null>(null);


  const fetchRules = async () => {
    try {
      const res = await fetch(`/api/rules${globalAccountId ? `?accountId=${globalAccountId}` : ''}`);
      const data = await res.json();
      if (data.rules) {
        setRules(data.rules);
      }
      if (data.inventory) {
        setInventory(data.inventory);
      }
    } catch (err) {
      console.error("Failed to fetch rules", err);
    }
  };


  useEffect(() => {
    // Rules load on every tab so the Active Rules badge can count what waits for review.
    const first = setTimeout(fetchRules, 0);
    return () => clearTimeout(first);
    // Tab changes only: fetchRules also reads the account box, and refetching on every
    // keystroke there would flash an empty list for each partial account id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    // Fetch active brain for central bus ARN auto-fill
    fetch("/api/brains")
      .then(res => res.json())
      .then(data => {
        if (data.activeBrain) {
          setActiveBrain(data.activeBrain);
        }
      })
      .catch(() => {});

    // Load active scenarios from backend database to ensure accuracy
    const fetchActiveScenarios = async () => {
      try {
        const res = await fetch("/api/inventory-scenarios");
        if (res.ok) {
          setActiveScenarios(await res.json());
        }
      } catch (err) {
        console.error("Failed to load active scenarios from backend", err);
      }
    };
    fetchActiveScenarios();
  }, []);

  // Separate from the effect above so a finished sync can reload the catalog
  // (scenariosVersion) without re-running the brain/bus auto-fill.
  useEffect(() => {
    // Fetch dynamic scenarios from backend API
    const fetchScenarios = async () => {
      try {
        const res = await fetch("/api/scenarios");
        if (res.ok) {
          const data = await res.json();
          setScenarios(data);

          // Notification Logic for Syncs
          const lastKnown = localStorage.getItem('mirage_last_known_scenarios');
          const currentIds = data.map((s: Scenario) => s.id);
          
          if (lastKnown) {
            try {
              const previousIds = JSON.parse(lastKnown);
              
              // Check for additions
              currentIds.forEach((id: string) => {
                if (!previousIds.includes(id)) {
                  addNotification('sync', 'info', `Scenario ${id} was added from the upstream catalog.`);
                }
              });
              
              // Check for removals
              previousIds.forEach((id: string) => {
                if (!currentIds.includes(id)) {
                  addNotification('sync', 'info', `Scenario ${id} was removed from the upstream catalog.`);
                }
              });
            } catch { /* corrupt or old list: skip the diff this once */ }
          }
          localStorage.setItem('mirage_last_known_scenarios', JSON.stringify(currentIds));
        }
      } catch (err) {
        console.error("Failed to load scenarios", err);
      } finally {
        setIsLoadingScenarios(false);
      }
    };
    fetchScenarios();
  }, [scenariosVersion]);

  const saveActiveScenarios = (newScenarios: ActiveScenario[]) => {
    const uniqueMap = new Map<string, ActiveScenario>();
    for (const s of newScenarios) {
      const key = `${s.accountId}#${s.scenarioId}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, s);
      }
    }
    const deduped = Array.from(uniqueMap.values());
    setActiveScenarios(deduped);
  };

  return (
    <div className="catalog-page" onClick={() => { if (selectedRule) setSelectedRule(null); }}>
      <header className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "2rem" }}>
        <div>
          <h1>Deception Catalog</h1>
          <p className="text-muted">Deploy complete Honey Attack Paths to your Spoke accounts.</p>
        </div>

        {/* Global Spoke Auth (Top Right).

            Fixed height by design: the three derived ARNs used to appear inline at
            320px each, which flex-wrap could only stack one-per-row inside the
            panel's 572px content box. Typing an id therefore grew the panel from
            one row to four and pushed the entire page down. They now live behind a
            disclosure, since they are derived rather than entered. */}
        <div
          className="glass-panel"
          style={{
            padding: "1rem 1.5rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            width: "100%",
            maxWidth: "620px",
          }}
        >
            <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label className="text-muted" style={{ fontSize: "0.75rem", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1px" }}>Spoke Account ID</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="e.g. 123456789012"
                  className="input-field mono"
                  style={{
                    padding: "0.5rem 0.75rem",
                    width: "190px",
                    borderColor: accountIdInvalid ? "var(--accent-red)" : undefined,
                  }}
                  value={globalAccountId}
                  onChange={e => handleAccountIdChange(e.target.value)}
                  aria-invalid={accountIdInvalid}
                />
              </div>
              {/* Only new deploys need a region; deployed scenarios and rules carry their own. */}
              {activeTab === "catalog" && <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label className="text-muted" style={{ fontSize: "0.75rem", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1px" }}>Deploy Region</label>
                <select
                  className="input-field mono"
                  style={{ padding: "0.5rem 0.75rem", width: "160px" }}
                  value={deployRegion}
                  onChange={e => setDeployRegion(e.target.value)}
                  title="Region the decoys deploy into (tfstate is keyed per region)"
                >
                  {["us-west-2","us-east-1","us-east-2","us-west-1","eu-west-1","eu-west-2","eu-central-1","ap-south-1","ap-southeast-1","ap-southeast-2","ap-northeast-1","ca-central-1","sa-east-1"].map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>}
            </div>

            {/* One line, whatever the state - so the panel never changes height. */}
            {globalAccountId.length === 0 ? (
              <span className="text-muted text-xs">⚡ Enter Spoke Account ID to auto-configure roles &amp; central bus</span>
            ) : accountIdInvalid ? (
              <span className="text-xs" style={{ color: "var(--accent-red)" }}>
                An AWS account ID is 12 digits — this one has {globalAccountId.length}. Roles are not
                configured until it is valid.
              </span>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <span className="text-xs" style={{ color: "#10b981" }}>
                  ✓ Spoke roles auto-configured
                </span>
                {!hubBusArn && (
                  <span className="text-xs" style={{ color: "var(--accent-red)" }}>
                    · no hub bus — deploy a brain first
                  </span>
                )}
                <button
                  type="button"
                  className="text-xs text-muted"
                  onClick={() => setShowAdvancedConfig(v => !v)}
                  style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
                  aria-expanded={showAdvancedConfig}
                >
                  {showAdvancedConfig ? "Hide advanced" : "Show advanced"}
                </button>
              </div>
            )}

            {/* Full width here, unlike the old 320px, so an ARN is readable end to end. */}
            {showAdvancedConfig && !accountIdInvalid && globalAccountId.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label className="text-muted" style={{ fontSize: "0.75rem", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1px" }}>Spoke Deployment Role</label>
                  <input
                    type="text"
                    placeholder="arn:aws:iam::...:role/SpokeDeployRole"
                    className="input-field mono"
                    style={{ padding: "0.5rem 0.75rem", width: "100%", fontSize: "0.8rem" }}
                    value={globalRoleArn}
                    onChange={e => setGlobalRoleArn(e.target.value)}
                  />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label className="text-muted" style={{ fontSize: "0.75rem", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1px" }}>Hub EventBus Target</label>
                  <input
                    type="text"
                    placeholder="arn:aws:events:...:event-bus/HubBus"
                    className="input-field mono"
                    style={{ padding: "0.5rem 0.75rem", width: "100%", fontSize: "0.8rem" }}
                    value={hubBusArn}
                    onChange={e => setHubBusArn(e.target.value)}
                  />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <label className="text-muted" style={{ fontSize: "0.75rem", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1px" }}>EventBridge Forwarding Role</label>
                  <input
                    type="text"
                    placeholder="arn:aws:iam::...:role/ForwardingRole"
                    className="input-field mono"
                    style={{ padding: "0.5rem 0.75rem", width: "100%", fontSize: "0.8rem" }}
                    value={forwardingRoleArn}
                    onChange={e => setForwardingRoleArn(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
      </header>

      {/* Tabs and Notifications */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem", borderBottom: "1px solid var(--border-color)", paddingBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "1rem" }}>
        <button 
          className={`btn ${activeTab === "catalog" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("catalog")}
        >
          <Network size={18} /> Attack Path Catalog
        </button>
        <button 
          className={`btn ${activeTab === "rules" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("rules")}
        >
          <Network size={18} /> Active Rules
          {(() => {
            const waiting = rules.filter(r => ['pending', 'update_available', 'failed'].includes(r.status)).length;
            return waiting > 0 ? (
              <span title={`${waiting} rule change${waiting === 1 ? '' : 's'} waiting for review`} style={{ marginLeft: 4, minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, background: "#eab308", color: "#111", fontSize: 11, fontWeight: 700, display: "inline-grid", placeItems: "center" }}>{waiting}</span>
            ) : null;
          })()}
        </button>
        <button 
          className={`btn ${activeTab === "active" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("active")}
        >
          <ShieldAlert size={18} /> Active Scenarios
        </button>
        <button 
          className={`btn ${activeTab === "history" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("history")}
        >
          <AlertCircle size={18} /> History
        </button>
        </div>

        {/* Notification Bell */}
        <div ref={notificationRef} style={{ position: "relative" }}>
          <button 
            className="btn btn-secondary" 
            onClick={() => setShowNotifications(!showNotifications)}
            style={{ position: "relative", padding: "1rem", borderRadius: "12px" }}
          >
            <Bell size={20} />
            {unreadCount > 0 && (
              <span style={{ position: "absolute", top: "-5px", right: "-5px", background: "var(--accent-red)", color: "white", borderRadius: "50%", padding: "2px 6px", fontSize: "0.75rem", fontWeight: "bold" }}>
                {unreadCount}
              </span>
            )}
          </button>
          
          {showNotifications && (
            <div className="glass-panel" style={{ position: "absolute", top: "100%", right: "0", marginTop: "1rem", width: "350px", maxHeight: "400px", overflowY: "auto", zIndex: 100, padding: "0", boxShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>
              <div style={{ padding: "1rem", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: "rgba(10, 10, 10, 0.9)", backdropFilter: "blur(10px)", zIndex: 101 }}>
                <h3 style={{ margin: 0, fontSize: "1rem" }}>Activity Feed</h3>
                {unreadCount > 0 && (
                  <button 
                    className="btn btn-secondary" 
                    style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
                    onClick={() => {
                      const readAll = notifications.map(n => ({ ...n, read: true }));
                      setNotifications(readAll);
                      localStorage.setItem('mirage_notifications', JSON.stringify(readAll));
                    }}
                  >
                    Mark all read
                  </button>
                )}
              </div>
              
              <div style={{ padding: "0.5rem" }}>
                {notifications.length === 0 ? (
                  <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>No recent activity</div>
                ) : (
                  notifications.map(notif => (
                    <div key={notif.id} style={{ padding: "1rem", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: "1rem", opacity: notif.read ? 0.6 : 1 }}>
                      <div style={{ flexShrink: 0, marginTop: "2px" }}>
                        {notif.status === 'success' && <CheckCircle2 size={16} style={{ color: "#10b981" }} />}
                        {notif.status === 'failure' && <XCircle size={16} style={{ color: "var(--accent-red)" }} />}
                        {notif.status === 'info' && <Info size={16} style={{ color: "#3b82f6" }} />}
                      </div>
                      <div>
                        <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text-main)" }}>{notif.message}</p>
                        {notif.details && (
                          <p className="mono" style={{ margin: "4px 0 0 0", fontSize: "0.75rem", color: "var(--accent-red)", background: "rgba(239, 68, 68, 0.1)", padding: "4px 8px", borderRadius: "4px", wordBreak: "break-all" }}>
                            {notif.details}
                          </p>
                        )}
                        <p style={{ margin: "4px 0 0 0", fontSize: "0.7rem", color: "var(--text-muted)" }}>
                          {new Date(notif.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Every tab stays mounted (hidden when not shown) so selections and progress survive a tab switch. */}
      <div hidden={activeTab !== "catalog"}><CatalogTab {...{ activeScenarios, addNotification, deployRegion, forwardingRoleArn, globalAccountId, globalRoleArn, hubBusArn, isLoadingScenarios, saveActiveScenarios, scenarios, setActiveScenarios, setActiveTab, setScenariosVersion, setSelectedActiveAccount }} /></div>
      <div hidden={activeTab !== "active"}><ActiveTab {...{ activeScenarios, addNotification, saveActiveScenarios, scenarios, selectedActiveAccount, setActiveScenarios, setSelectedActiveAccount }} /></div>
      <div hidden={activeTab !== "rules"}><RulesTab {...{ addNotification, busArn, fetchRules, forwardingRoleFor, inventory, rules, selectedRule, setSelectedRule }} /></div>
      <div hidden={activeTab !== "history"}><HistoryTab active={activeTab === "history"} /></div>

    </div>
  );
}
