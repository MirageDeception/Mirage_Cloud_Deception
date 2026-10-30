"use client";

import { useState } from "react";
import { X, Network, Trash2, FileText, CheckSquare } from "lucide-react";

import { readOperationResponse, type Scenario, type ActiveScenario, type Notify } from "./shared";

export interface ActiveTabProps {
  activeScenarios: ActiveScenario[];
  addNotification: Notify;
  saveActiveScenarios: (s: ActiveScenario[]) => void;
  scenarios: Scenario[];
  selectedActiveAccount: string;
  setActiveScenarios: React.Dispatch<React.SetStateAction<ActiveScenario[]>>;
  setSelectedActiveAccount: React.Dispatch<React.SetStateAction<string>>;
}

export function ActiveTab({ activeScenarios, addNotification, saveActiveScenarios, scenarios, selectedActiveAccount, setActiveScenarios, setSelectedActiveAccount }: ActiveTabProps) {

  // Teardown State
  const [selectedTeardownIds, setSelectedTeardownIds] = useState<string[]>([]);
  const [teardownStatuses, setTeardownStatuses] = useState<Record<string, 'queued' | 'destroying' | 'success' | 'error'>>({});

  // Populate State
  const [populateStatuses, setPopulateStatuses] = useState<Record<string, 'populating' | 'success' | 'error'>>({});

  // Teardown Functions
  const handleSelectTeardown = (id: string) => {
    if (selectedTeardownIds.includes(id)) {
      setSelectedTeardownIds(selectedTeardownIds.filter(x => x !== id));
    } else {
      setSelectedTeardownIds([...selectedTeardownIds, id]);
    }
  };

  /**
   * Teardown candidates: respects the account filter the operator is looking at,
   * and skips anything already mid-teardown (those rows show a status dot instead
   * of a checkbox, so selecting them would be a no-op the UI cannot represent).
   */
  const teardownableIds = activeScenarios
    .filter(s => selectedActiveAccount === "all" || s.accountId === selectedActiveAccount)
    .filter(s => !teardownStatuses[s.id])
    .map(s => s.id);
  const allTeardownableSelected =
    teardownableIds.length > 0 && teardownableIds.every(id => selectedTeardownIds.includes(id));

  const handleSelectAllTeardown = () => {
    setSelectedTeardownIds(allTeardownableSelected ? [] : teardownableIds);
  };

  const handleMasterTeardown = async () => {
    if (selectedTeardownIds.length === 0) return;

    // Resolve every selected id up front. activeScenarios is localStorage-backed, so a
    // stale list used to make ids silently vanish from the batch; name them instead.
    const resolved: ActiveScenario[] = [];
    const unresolved: string[] = [];
    for (const id of selectedTeardownIds) {
      const found = activeScenarios.find(s => s.id === id);
      if (found) resolved.push(found);
      else unresolved.push(id);
    }

    if (unresolved.length > 0) {
      addNotification(
        'teardown',
        'failure',
        `${unresolved.length} selected scenario(s) could not be found`,
        `${unresolved.join(', ')} are selected but missing from the active list - reload the page and try again.`,
      );
    }
    if (resolved.length === 0) return;

    // One request per account: the job is tagged with a single accountId and the
    // conflict guard is keyed on it, so a batch must not span accounts.
    const groupedByAccount = resolved.reduce<Record<string, ActiveScenario[]>>((acc, sc) => {
      (acc[sc.accountId] ||= []).push(sc);
      return acc;
    }, {});
    const accounts = Object.keys(groupedByAccount);

    const summary = accounts
      .map(a => `${groupedByAccount[a].length} in ${a}`)
      .join(' and ');
    if (!confirm(`Tear down ${resolved.length} scenario(s) (${summary})? This destroys the decoys in AWS.`)) return;

    const initialStatuses: Record<string, 'queued' | 'destroying' | 'success' | 'error'> = {};
    for (const sc of resolved) initialStatuses[sc.id] = 'destroying';
    setTeardownStatuses(initialStatuses);

    // Fire every account's batch before awaiting any of them, so separate spokes run in
    // parallel. The work is server-side from here: leaving this page no longer loses it.
    const submissions = accounts.map(async accountIdForGroup => {
      const group = groupedByAccount[accountIdForGroup];
      const ids = group.map(sc => sc.id);
      try {
        const res = await fetch('/api/remove-spoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scenarios: group.map(sc => ({
              scenarioId: sc.scenarioId,
              accountId: sc.accountId,
              // region + tfstateKey let remove-spoke target the correct remote state;
              // the server derives the spoke role from accountId.
              region: sc.region,
              tfstateKey: sc.tfstateKey,
            })),
          }),
        });

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData.error || 'Teardown failed');
        }

        // Waiting only keeps this page in step; the batch completes regardless.
        const result = await readOperationResponse(res);

        // The job reports per scenario, so mark only the ones that actually failed.
        const failed: Array<{ id: string; error: string }> = Array.isArray(result?.failed)
          ? result.failed
          : [];
        const failedIds = new Set(failed.map(f => f.id));

        setTeardownStatuses(prev => {
          const next = { ...prev };
          for (const sc of group) next[sc.id] = failedIds.has(sc.scenarioId) ? 'error' : 'success';
          return next;
        });

        const goneIds = new Set(group.filter(sc => !failedIds.has(sc.scenarioId)).map(sc => sc.id));
        if (goneIds.size > 0) {
          setActiveScenarios(prev => {
            const remaining = prev.filter(sc => !goneIds.has(sc.id));
            saveActiveScenarios(remaining);
            return remaining;
          });
        }

        if (failed.length > 0) {
          addNotification(
            'teardown',
            'failure',
            `${failed.length} of ${group.length} failed in ${accountIdForGroup}`,
            failed.map(f => `${f.id}: ${f.error}`).join('; '),
          );
        } else {
          addNotification('teardown', 'success', `Tore down ${group.length} scenario(s) in ${accountIdForGroup}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Teardown batch failed for ${accountIdForGroup}:`, err);
        setTeardownStatuses(prev => {
          const next = { ...prev };
          for (const id of ids) next[id] = 'error';
          return next;
        });
        addNotification('teardown', 'failure', `Teardown failed for ${accountIdForGroup}`, message);
      }
    });

    await Promise.allSettled(submissions);

    setTimeout(() => {
      setSelectedTeardownIds([]);
      setTeardownStatuses({});
    }, 2000);
  };

  // Populate Functions
  const handlePopulate = async (scenario: ActiveScenario) => {
    setPopulateStatuses(prev => ({ ...prev, [scenario.id]: 'populating' }));

    try {
      const res = await fetch('/api/populate-spoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: scenario.accountId,
          scenarioId: scenario.scenarioId,
          region: scenario.region
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Populate failed');
      }

      const anyFailed = (data.results || []).some((r: { label: string; status: string; error?: string }) => r.status === 'failed');
      if (anyFailed) {
        setPopulateStatuses(prev => ({ ...prev, [scenario.id]: 'error' }));
        addNotification('populate', 'failure', `Populate had failures for ${scenario.scenarioName}`, data.results.filter((r: { label: string; status: string; error?: string }) => r.status === 'failed').map((r: { label: string; status: string; error?: string }) => `${r.label}: ${r.error}`).join('; '));
      } else {
        setPopulateStatuses(prev => ({ ...prev, [scenario.id]: 'success' }));
        addNotification('populate', 'success', `Populated ${scenario.scenarioName} with seed content`);
      }
    } catch (err) {
      console.error(`Failed to populate ${scenario.scenarioId}:`, err);
      setPopulateStatuses(prev => ({ ...prev, [scenario.id]: 'error' }));
      addNotification('populate', 'failure', `Failed to populate ${scenario.scenarioName}`, (err as Error).message);
    }

    setTimeout(() => {
      setPopulateStatuses(prev => {
        const next = { ...prev };
        delete next[scenario.id];
        return next;
      });
    }, 3000);
  };


  const uniqueAccounts = Array.from(new Set(activeScenarios.map(s => s.accountId)));

  return (
        <div className="active-scenarios-view">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
            <h3 style={{ margin: 0 }}>Deployed Attack Paths</h3>
        
            <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
              <select 
                className="input-field" 
                style={{ width: "200px" }}
                value={selectedActiveAccount}
                onChange={(e) => setSelectedActiveAccount(e.target.value)}
              >
                <option value="all">All Accounts</option>
                {uniqueAccounts.map(acc => (
                  <option key={acc} value={acc}>Account: {acc}</option>
                ))}
              </select>

              {selectedTeardownIds.length > 0 && (
                <>
                  <button
                    className="btn btn-secondary"
                    onClick={handleSelectAllTeardown}
                    title={allTeardownableSelected ? "Clear the selection" : `Select all ${teardownableIds.length} scenarios shown`}
                    style={{ padding: "0.5rem 1.25rem", whiteSpace: "nowrap" }}
                  >
                    {allTeardownableSelected
                      ? <><X size={16} /> Deselect All</>
                      : <><CheckSquare size={16} /> Select All ({teardownableIds.length})</>}
                  </button>
                  <button className="btn btn-primary" onClick={handleMasterTeardown} style={{ padding: "0.5rem 1.5rem", background: "var(--accent-red)", borderColor: "var(--accent-red)" }}>
                    <Trash2 size={16} /> Teardown Selected ({selectedTeardownIds.length})
                  </button>
                </>
              )}
            </div>
          </div>

          {activeScenarios.length === 0 ? (
            <div className="empty-state glass-panel">
              <Network size={48} className="text-muted" />
              <h3>No Active Scenarios</h3>
              <p className="text-muted">You have not deployed any attack paths yet.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {activeScenarios
                .filter(s => selectedActiveAccount === "all" || s.accountId === selectedActiveAccount)
                .map(scenario => {
                  const isSelectedForTeardown = selectedTeardownIds.includes(scenario.id);
                  return (
                    <div key={scenario.id} className="glass-panel" style={{ padding: "1.5rem", display: "flex", justifyContent: "space-between", alignItems: "center", border: isSelectedForTeardown ? "1px solid var(--accent-red)" : "" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "1.5rem" }}>
                        {!teardownStatuses[scenario.id] ? (
                          <input 
                            type="checkbox" 
                            checked={isSelectedForTeardown}
                            onChange={() => handleSelectTeardown(scenario.id)}
                            style={{ width: "20px", height: "20px", accentColor: "var(--accent-red)", cursor: "pointer" }}
                          />
                        ) : (
                          <div style={{ width: "20px", display: "flex", justifyContent: "center" }}>
                            {teardownStatuses[scenario.id] === 'queued' && (
                              <span style={{ height: "8px", width: "8px", borderRadius: "50%", background: "var(--text-muted)" }}></span>
                            )}
                            {teardownStatuses[scenario.id] === 'destroying' && (
                              <span className="spinner-text" style={{ fontSize: "1.2rem", color: "var(--accent-red)" }}>⚠️</span>
                            )}
                            {teardownStatuses[scenario.id] === 'success' && (
                              <span style={{ color: "#10b981" }}>✓</span>
                            )}
                            {teardownStatuses[scenario.id] === 'error' && (
                              <span style={{ color: "var(--accent-red)" }}>✕</span>
                            )}
                          </div>
                        )}
                        <div>
                          <h4 style={{ margin: 0, marginBottom: "4px", fontSize: "1.1rem" }}>{scenario.scenarioName}</h4>
                          <p className="text-muted mono" style={{ margin: 0, fontSize: "0.875rem" }}>
                            Spoke Account: <span style={{ color: "var(--text-main)" }}>{scenario.accountId}</span> | Region: <span style={{ color: "var(--text-main)" }}>{scenario.region || 'us-west-2'}</span> | Deployed: {new Date(scenario.deployedAt).toLocaleDateString()}
                          </p>
                        </div>
                      {/* Populate Button */}
                      {scenarios.find(s => s.id === scenario.scenarioId)?.populateSupported && (
                        <button
                          className="btn btn-secondary"
                          title="Seed real content into this scenario's decoy resources"
                          disabled={populateStatuses[scenario.id] === 'populating'}
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePopulate(scenario);
                          }}
                          style={{
                            padding: "0.5rem 1rem",
                            marginRight: "0.5rem",
                            fontSize: "0.85rem",
                            color: populateStatuses[scenario.id] === 'success' ? "#10b981" : populateStatuses[scenario.id] === 'error' ? "var(--accent-red)" : "var(--text-main)"
                          }}
                        >
                          <FileText size={16} />
                          {populateStatuses[scenario.id] === 'populating' ? 'Populating...' : populateStatuses[scenario.id] === 'success' ? 'Populated ✓' : populateStatuses[scenario.id] === 'error' ? 'Failed ✕' : 'Populate'}
                        </button>
                      )}
                      {/* Force Remove Button */}
                      <button
                        className="btn btn-secondary"
                        title="Force remove from UI (ignores AWS/Terraform errors)"
                        onClick={(e) => {
                          e.stopPropagation();
                          if(confirm("Force remove this scenario from the UI? This will not destroy AWS resources.")) {
                            const newActive = activeScenarios.filter(s => s.id !== scenario.id);
                            setActiveScenarios(newActive);
                            saveActiveScenarios(newActive);
                            addNotification('force_remove', 'info', `Scenario ${scenario.scenarioName} was forcefully removed from the UI.`);
                          }
                        }}
                        style={{ padding: "0.5rem", borderRadius: "50%", color: "var(--text-muted)", background: "transparent", border: "none" }}
                      >
                        <X size={18} />
                      </button>
                    </div>
                  
                      {/* Teardown Status Progress Bar (Right Side) */}
                      {teardownStatuses[scenario.id] && (
                        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: "1rem" }}>
                          {teardownStatuses[scenario.id] === 'queued' && (
                            <span style={{ padding: "0.25rem 0.75rem", borderRadius: "12px", background: "rgba(255,255,255,0.1)", fontSize: "0.875rem", color: "var(--text-muted)" }}>Queued for Teardown</span>
                          )}
                          {teardownStatuses[scenario.id] === 'destroying' && (
                            <div style={{ display: "flex", alignItems: "center", gap: "1rem", width: "100%", maxWidth: "300px", justifyContent: "flex-end" }}>
                              <span className="spinner-text" style={{ fontSize: "0.875rem", color: "var(--accent-red)", whiteSpace: "nowrap" }}>Destroying...</span>
                              <div style={{ height: "6px", width: "150px", background: "rgba(255,255,255,0.1)", borderRadius: "4px", overflow: "hidden" }}>
                                <div className="progress-bar-fill"></div>
                              </div>
                            </div>
                          )}
                          {teardownStatuses[scenario.id] === 'success' && (
                            <span style={{ padding: "0.25rem 0.75rem", borderRadius: "12px", background: "rgba(16, 185, 129, 0.1)", color: "#10b981", fontSize: "0.875rem" }}>Destroyed ✓</span>
                          )}
                          {teardownStatuses[scenario.id] === 'error' && (
                            <span style={{ padding: "0.25rem 0.75rem", borderRadius: "12px", background: "rgba(239, 68, 68, 0.1)", color: "var(--accent-red)", fontSize: "0.875rem" }}>Failed ✕</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
              })}
            </div>
          )}
        </div>
  );
}
