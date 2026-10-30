"use client";

import { useState } from "react";
import { Play, Network, Trash2 } from "lucide-react";
import { RuleEditorPanel } from "@/components/RuleEditorPanel";

import type { RuleRecord } from "@/lib/db";
import type { Notify, InventoryItem } from "./shared";

export interface RulesTabProps {
  addNotification: Notify;
  busArn: string;
  fetchRules: () => Promise<void>;
  forwardingRoleFor: (accountId: string) => string;
  inventory: InventoryItem[];
  rules: RuleRecord[];
  selectedRule: RuleRecord | null;
  setSelectedRule: React.Dispatch<React.SetStateAction<RuleRecord | null>>;
}

export function RulesTab({ addNotification, busArn, fetchRules, forwardingRoleFor, inventory, rules, selectedRule, setSelectedRule }: RulesTabProps) {

  const [editingPattern, setEditingPattern] = useState("");
  const [ruleSearchQuery, setRuleSearchQuery] = useState("");
  const [ruleRegionFilter, setRuleRegionFilter] = useState("all");
  const [isDeployingRule, setIsDeployingRule] = useState(false);

  // Bulk Rules State
  const [selectedRuleNames, setSelectedRuleNames] = useState<string[]>([]);
  const [ruleActionStatuses, setRuleActionStatuses] = useState<Record<string, 'queued' | 'deploying' | 'deleting' | 'success' | 'error'>>({});
  const [isBulkProcessingRules, setIsBulkProcessingRules] = useState(false);

  // Bulk Rule Functions
  const handleSelectRule = (ruleName: string) => {
    if (selectedRuleNames.includes(ruleName)) {
      setSelectedRuleNames(selectedRuleNames.filter(n => n !== ruleName));
    } else {
      setSelectedRuleNames([...selectedRuleNames, ruleName]);
    }
  };

  const handleBulkDeployRules = async () => {
    if (!busArn) {
      alert("No hub bus found. Deploy a brain first.");
      return;
    }
    
    const initialStatuses: Record<string, 'queued' | 'deploying' | 'success' | 'error'> = {};
    for (const ruleName of selectedRuleNames) {
      initialStatuses[ruleName] = 'deploying';
    }
    setRuleActionStatuses(initialStatuses);
    setIsBulkProcessingRules(true);

    // Identity rules first: a regional update that moves roles out is refused until the
    // identity rule is deployed everywhere (so roles are never left unwatched).
    const ordered = [...selectedRuleNames].sort((a, b) =>
      Number(rules.find(r => r.ruleName === b)?.kind === 'identity') - Number(rules.find(r => r.ruleName === a)?.kind === 'identity'));
    for (const ruleName of ordered) {
      const rule = rules.find(r => r.ruleName === ruleName);
      if (!rule) continue;

      try {
        const res = await fetch("/api/deploy-rule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: rule.accountId,
            hubBusArn: busArn,
            forwardingRoleArn: forwardingRoleFor(rule.accountId),
            ruleName: rule.ruleName,
            eventPattern: rule.eventPattern
          })
        });
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.error || "Deploy failed");
        }
        setRuleActionStatuses(prev => ({ ...prev, [ruleName]: 'success' }));
        addNotification('rule', 'success', `Successfully deployed rule ${ruleName}`);
      } catch (err) {
        console.error(`Failed to deploy rule ${ruleName}:`, err);
        setRuleActionStatuses(prev => ({ ...prev, [ruleName]: 'error' }));
        addNotification('rule', 'failure', `Failed to deploy rule ${ruleName}`, (err as Error).message);
      }
    }

    setTimeout(() => {
      setSelectedRuleNames([]);
      setRuleActionStatuses({});
      setIsBulkProcessingRules(false);
      fetchRules();
    }, 2000);
  };

  const handleBulkDeleteRules = async () => {
    if (!confirm(`Are you sure you want to delete ${selectedRuleNames.length} rules? This removes them from AWS and the database.`)) {
      return;
    }

    const initialStatuses: Record<string, 'queued' | 'deleting' | 'success' | 'error'> = {};
    for (const ruleName of selectedRuleNames) {
      initialStatuses[ruleName] = 'deleting';
    }
    setRuleActionStatuses(initialStatuses);
    setIsBulkProcessingRules(true);

    for (const ruleName of selectedRuleNames) {
      const rule = rules.find(r => r.ruleName === ruleName);
      if (!rule) continue;
      try {
        const res = await fetch("/api/delete-rule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: rule.accountId, ruleName })
        });
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.error || "Delete failed");
        }
        setRuleActionStatuses(prev => ({ ...prev, [ruleName]: 'success' }));
        addNotification('rule', 'success', `Successfully deleted rule ${ruleName}`);
      } catch (err) {
        console.error(`Failed to delete rule ${ruleName}:`, err);
        setRuleActionStatuses(prev => ({ ...prev, [ruleName]: 'error' }));
        addNotification('rule', 'failure', `Failed to delete rule ${ruleName}`, (err as Error).message);
      }
    }

    setTimeout(() => {
      setSelectedRuleNames([]);
      setRuleActionStatuses({});
      setIsBulkProcessingRules(false);
      fetchRules();
    }, 2000);
  };

  return (
        <div className="active-rules-view" style={{ display: "flex", gap: "2rem" }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <h3 style={{ margin: 0 }}>EventBridge Rules</h3>
              <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
              <select className="input-dark" value={ruleRegionFilter} onChange={e => setRuleRegionFilter(e.target.value)}
                title="Identity rules cover every region, so they show under each one"
                style={{ borderRadius: "9999px", padding: "0.5rem 1rem", fontSize: "0.875rem" }}>
                <option value="all">All regions</option>
                {[...new Set(rules.flatMap(r => r.kind === 'identity' ? Object.keys(r.regionStatus ?? {}) : [r.region ?? 'us-west-2']))].sort().map(r => (
                  <option key={r as string} value={r as string}>{r as string}</option>
                ))}
              </select>
              <input 
                type="text" 
                className="input-dark" 
                placeholder="Search rules by scenario name..." 
                value={ruleSearchQuery}
                onChange={(e) => setRuleSearchQuery(e.target.value)}
                style={{ width: "320px", borderRadius: "9999px", padding: "0.5rem 1.25rem", fontSize: "0.875rem" }}
              />
              </div>
            </div>
        
            {selectedRuleNames.length > 0 && (
              <div className="glass-panel" style={{ padding: "1.5rem", marginBottom: "2rem", border: "1px solid var(--accent-red)", background: "rgba(239, 68, 68, 0.05)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: 0 }}>{selectedRuleNames.length} Rule{selectedRuleNames.length > 1 ? 's' : ''} Selected</h3>
                  <p className="text-muted" style={{ margin: 0, fontSize: "0.875rem" }}>Ready to deploy or delete</p>
                </div>
                <div style={{ display: "flex", gap: "1rem" }}>
                  <button className="btn btn-secondary" onClick={handleBulkDeleteRules} disabled={isBulkProcessingRules} style={{ padding: "0.75rem 2rem", fontSize: "1rem", color: "var(--accent-red)", borderColor: "var(--accent-red)" }}>
                    <Trash2 size={18} /> Delete Selected
                  </button>
                  <button className="btn btn-primary" onClick={handleBulkDeployRules} disabled={isBulkProcessingRules} style={{ padding: "0.75rem 2rem", fontSize: "1rem" }}>
                    <Play size={18} /> Deploy Selected
                  </button>
                </div>
              </div>
            )}
        

        
            {rules.length === 0 ? (
              <div className="empty-state glass-panel">
                <Network size={48} className="text-muted" />
                <h3>No Generated Rules</h3>
                <p className="text-muted">Deploy scenarios to generate EventBridge rules.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                {rules.filter(rule => {
                  if (ruleRegionFilter !== "all" && rule.kind !== 'identity' && (rule.region ?? 'us-west-2') !== ruleRegionFilter) return false;
                  if (!ruleSearchQuery) return true;
                  const ruleInventory = inventory.filter(i => i.ruleName === rule.ruleName);
                  return ruleInventory.some(i => i.scenarioId.toLowerCase().includes(ruleSearchQuery.toLowerCase()));
                }).map((rule) => {
                  const isSelected = selectedRuleNames.includes(rule.ruleName);
                  return (
                  <div
                    key={rule.ruleName}
                    className="glass-panel"
                    style={{ padding: "1.5rem", cursor: "pointer", border: isSelected ? "1px solid var(--accent-red)" : rule.status === 'update_available' ? "1px solid rgba(234,179,8,0.4)" : "" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedRule(rule);
                      setEditingPattern(rule.eventPattern);
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                        {!ruleActionStatuses[rule.ruleName] ? (
                          <input 
                            type="checkbox" 
                            checked={isSelected}
                            onChange={(e) => {
                              e.stopPropagation();
                              handleSelectRule(rule.ruleName);
                            }}
                            style={{ width: "20px", height: "20px", accentColor: "var(--accent-red)", cursor: "pointer" }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <div style={{ width: "20px", display: "flex", justifyContent: "center" }}>
                            {ruleActionStatuses[rule.ruleName] === 'queued' && (
                              <span style={{ height: "8px", width: "8px", borderRadius: "50%", background: "var(--text-muted)" }}></span>
                            )}
                            {(ruleActionStatuses[rule.ruleName] === 'deploying' || ruleActionStatuses[rule.ruleName] === 'deleting') && (
                              <span className="spinner-text" style={{ fontSize: "1.2rem", color: "var(--accent-red)" }}>⚠️</span>
                            )}
                            {ruleActionStatuses[rule.ruleName] === 'success' && (
                              <span style={{ color: "#10b981" }}>✓</span>
                            )}
                            {ruleActionStatuses[rule.ruleName] === 'error' && (
                              <span style={{ color: "var(--accent-red)" }}>✕</span>
                            )}
                          </div>
                        )}
                        <div>
                          <h4 style={{ margin: 0, marginBottom: "4px" }}>{rule.ruleName}</h4>
                          <p className="text-muted mono" style={{ margin: 0, fontSize: "0.875rem" }}>
                            Account: <span style={{ color: "var(--text-main)" }}>{rule.accountId}</span>
                            <span style={{ marginLeft: "0.75rem", padding: "0.1rem 0.5rem", borderRadius: 6, fontSize: "0.75rem",
                              background: rule.kind === 'identity' ? "rgba(139,92,246,0.15)" : "rgba(255,255,255,0.08)",
                              color: rule.kind === 'identity' ? "#a78bfa" : "var(--text-main)" }}>
                              {rule.kind === 'identity'
                                ? `Identity · ${Object.keys(rule.regionStatus ?? {}).length || 'all'} regions`
                                : `Regional · ${rule.region ?? 'us-west-2'}`}
                            </span>
                          </p>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                        {/* Action Status Indicator */}
                        {ruleActionStatuses[rule.ruleName] && (
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            {(ruleActionStatuses[rule.ruleName] === 'deploying' || ruleActionStatuses[rule.ruleName] === 'deleting') && (
                              <span className="spinner-text" style={{ fontSize: "0.875rem", color: "var(--accent-red)", whiteSpace: "nowrap" }}>
                                {ruleActionStatuses[rule.ruleName] === 'deploying' ? 'Deploying...' : 'Deleting...'}
                              </span>
                            )}
                          </div>
                        )}
                        <button className="btn btn-secondary" onClick={(e) => { e.stopPropagation(); setSelectedRule(rule); setEditingPattern(rule.eventPattern); }} style={{ padding: "0.5rem 1rem", fontSize: "0.85rem" }}>
                          View / Edit
                        </button>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        {rule.status === 'update_available' ? (
                          <div
                            onClick={(e) => { e.stopPropagation(); setSelectedRule(rule); setEditingPattern(rule.eventPattern); }}
                            title="Update available — click to review"
                            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", borderRadius: "50%", background: "rgba(234,179,8,0.12)", border: "1px solid rgba(234,179,8,0.4)", cursor: "pointer", color: "#eab308", fontSize: "0.9rem", fontWeight: 900, flexShrink: 0 }}
                          >
                            !
                          </div>
                        ) : (
                          <span style={{
                            padding: "0.25rem 0.75rem",
                            borderRadius: "12px",
                            background: rule.status === 'deployed' ? "rgba(16, 185, 129, 0.1)" : rule.status === 'pending' ? "rgba(255, 255, 255, 0.1)" : "rgba(239, 68, 68, 0.1)",
                            color: rule.status === 'deployed' ? "#10b981" : rule.status === 'pending' ? "var(--text-main)" : "var(--accent-red)",
                            fontSize: "0.875rem"
                          }}>
                            {rule.status === 'deployed' ? 'Deployed ✓' : rule.status === 'pending' ? 'Pending'
                              : rule.kind === 'identity' && rule.regionStatus
                                ? `Failed in ${Object.values(rule.regionStatus as Record<string, { status: string }>).filter(r => r.status === 'failed').length} regions ✕`
                                : 'Failed ✕'}
                          </span>
                        )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
                })}
              </div>
            )}
          </div>

          {selectedRule && (
            <RuleEditorPanel
              ruleName={selectedRule.ruleName}
              pattern={editingPattern}
              deployedPattern={selectedRule.deployedPattern}
              ruleStatus={selectedRule.status}
              onPatternChange={setEditingPattern}
              onClose={() => setSelectedRule(null)}
              isDeploying={isDeployingRule}
              deployedScenarios={inventory.filter(i => i.ruleName === selectedRule.ruleName).map(i => i.scenarioId).filter((v, idx, arr) => arr.indexOf(v) === idx)}
              kind={selectedRule.kind ?? 'regional'}
              region={selectedRule.region}
              regionStatus={selectedRule.regionStatus}
              onRetry={async () => {
                if (!busArn) {
                  alert("No hub bus found. Deploy a brain first.");
                  return;
                }
                setIsDeployingRule(true);
                try {
                  const res = await fetch("/api/deploy-rule", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ accountId: selectedRule.accountId, hubBusArn: busArn, forwardingRoleArn: forwardingRoleFor(selectedRule.accountId), ruleName: selectedRule.ruleName, retryFailed: true }),
                  });
                  const data = await res.json();
                  if (!res.ok) throw new Error(data.error || "Retry failed");
                  setSelectedRule(null);
                  fetchRules();
                } catch (err) {
                  alert(`Error: ${err instanceof Error ? err.message : String(err)}`);
                  fetchRules();
                } finally {
                  setIsDeployingRule(false);
                }
              }}
              onReject={async () => {
                try {
                  const res = await fetch("/api/reject-rule-update", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ accountId: selectedRule.accountId, ruleName: selectedRule.ruleName })
                  });
                  if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || "Failed to reject update");
                  }
                  fetchRules();
                  setSelectedRule(null);
                } catch (err) {
                  alert((err as Error).message);
                }
              }}
              onDelete={async () => {
                setIsDeployingRule(true);
                try {
                  const res = await fetch("/api/delete-rule", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ accountId: selectedRule.accountId, ruleName: selectedRule.ruleName })
                  });
                  if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || "Failed to delete rule");
                  }
                  setSelectedRule(null);
                  fetchRules();
                } catch (err) {
                  alert(`Error: ${(err as Error).message}`);
                } finally {
                  setIsDeployingRule(false);
                }
              }}
              onDeploy={async () => {
                if (!busArn) {
                  alert("No hub bus found. Deploy a brain first.");
                  return;
                }
                setIsDeployingRule(true);
                try {
                  const res = await fetch("/api/deploy-rule", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    // No region: the server takes it from the rule record.
                    body: JSON.stringify({
                      accountId: selectedRule.accountId,
                      hubBusArn: busArn,
                      forwardingRoleArn: forwardingRoleFor(selectedRule.accountId),
                      ruleName: selectedRule.ruleName,
                      eventPattern: editingPattern
                    })
                  });
                  if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || "Failed to deploy rule");
                  }
                  setSelectedRule(null);
                  fetchRules();
                } catch (err) {
                  alert(`Error: ${(err as Error).message}`);
                } finally {
                  setIsDeployingRule(false);
                }
              }}
            />
          )}
        </div>
  );
}
