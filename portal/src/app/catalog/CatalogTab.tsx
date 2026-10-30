"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Play, X, AlertCircle, Shield, CheckSquare } from "lucide-react";
import { IndividualRuleToggle } from "@/components/IndividualRuleToggle";
import { PopulateOnDeployToggle } from "@/components/PopulateOnDeployToggle";
import { ScenarioSyncBar } from "@/components/ScenarioSyncBar";
import { CustomScenarioUpload } from "@/components/CustomScenarioUpload";

import { readOperationResponse, type Scenario, type ActiveScenario, type Notify, type Tab } from "./shared";

export interface CatalogTabProps {
  activeScenarios: ActiveScenario[];
  addNotification: Notify;
  deployRegion: string;
  forwardingRoleArn: string;
  globalAccountId: string;
  globalRoleArn: string;
  hubBusArn: string;
  isLoadingScenarios: boolean;
  saveActiveScenarios: (s: ActiveScenario[]) => void;
  scenarios: Scenario[];
  setActiveScenarios: React.Dispatch<React.SetStateAction<ActiveScenario[]>>;
  setActiveTab: React.Dispatch<React.SetStateAction<Tab>>;
  setScenariosVersion: React.Dispatch<React.SetStateAction<number>>;
  setSelectedActiveAccount: React.Dispatch<React.SetStateAction<string>>;
}

export function CatalogTab({ activeScenarios, addNotification, deployRegion, forwardingRoleArn, globalAccountId, globalRoleArn, hubBusArn, isLoadingScenarios, saveActiveScenarios, scenarios, setActiveScenarios, setActiveTab, setScenariosVersion, setSelectedActiveAccount }: CatalogTabProps) {

  const [catalogSection, setCatalogSection] = useState<"official" | "custom">("official");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Animation/Deployment State
  const [deployStatuses, setDeployStatuses] = useState<Record<string, 'queued' | 'deploying' | 'success' | 'error'>>({});
  const [deployDuplicates, setDeployDuplicates] = useState<Record<string, string[]>>({});
  const [isIndividualRule, setIsIndividualRule] = useState(false);
  // Default ON: an unpopulated decoy is worse than no decoy. The monitored API
  // call (GetObject/GetSecretValue/Scan/ReceiveMessage/GetLogEvents) is what
  // fires the alert, and an attacker who finds an empty bucket or a
  // {"placeholder": ...} secret moves on without ever triggering it -- which
  // reads as a detection failure rather than as an untaken lure. Scenarios with
  // no manifest are a no-op here (populateScenario returns manifestFound:false),
  // so turning this on cannot break them.
  const [populateOnDeploy, setPopulateOnDeploy] = useState(true);

  const handleSelectScenario = (id: string) => {
    // Coming-soon scenarios (e.g. EC2 bastion, Lambda+Secrets) are not
    // deployable yet - block selection so they can't be added to a deploy batch.
    if (scenarios.find(s => s.id === id)?.comingSoon) return;
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter(x => x !== id));
    } else {
      setSelectedIds([...selectedIds, id]);
    }
  };

  /**
   * Deployable ids only -- coming-soon scenarios are excluded for the same
   * reason handleSelectScenario refuses them: they cannot be deployed, so a
   * select-all that included them would build an unrunnable batch.
   */
  const customCount = scenarios.filter(s => s.source === 'custom').length;
  const visibleScenarios = scenarios.filter(s => (s.source === 'custom') === (catalogSection === 'custom'));
  const deployableIds = visibleScenarios.filter(s => !s.comingSoon).map(s => s.id);
  const allDeployableSelected =
    deployableIds.length > 0 && deployableIds.every(id => selectedIds.includes(id));

  // Select all / deselect all act on the section shown; picks in the other section are kept.
  const handleSelectAllScenarios = () => {
    setSelectedIds(allDeployableSelected
      ? selectedIds.filter(id => !deployableIds.includes(id))
      : [...new Set([...selectedIds, ...deployableIds])]);
  };

  const handleMasterDeploy = async () => {
    if (!globalAccountId || !globalRoleArn) {
      alert("Please provide the Global Spoke Account ID and Role ARN at the top right.");
      return;
    }
    // The hub bus ARN comes from the registered brain. If it's empty, no brain
    // is registered - block the deploy with a clear message rather than sending
    // a blank/fabricated bus ARN (which would silently break forwarding).
    if (!hubBusArn) {
      alert("No monitoring brain is registered. Deploy a brain first (Deploy Brain) so scenarios can forward events to the hub bus.");
      return;
    }

    const initialStatuses: Record<string, 'queued' | 'deploying' | 'success' | 'error'> = {};
    for (const id of selectedIds) {
      initialStatuses[id] = 'deploying';
    }
    setDeployStatuses(initialStatuses);

    let currentActiveScenarios = [...activeScenarios];

    // Build a name map to pass to the backend for history labels
    const scenarioNames: Record<string, string> = {};
    for (const id of selectedIds) {
      const found = scenarios.find(s => s.id === id);
      if (found) scenarioNames[id] = found.name;
    }
    
    try {
      const res = await fetch('/api/deploy-spoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: globalAccountId,
          region: deployRegion,
          roleArn: globalRoleArn,
          hubBusArn: hubBusArn,
          forwardingRoleArn: forwardingRoleArn,
          scenarioIds: selectedIds,
          scenarioNames,
          individualRule: isIndividualRule,
          populateOnDeploy
        })
      });

      if (!res.ok) {
        const errorData = await res.json();
        addNotification('deploy', 'failure', 'Deployment process failed', errorData.error);
        throw new Error(errorData.error || 'Deployment failed');
      }

      const data = await readOperationResponse(res);
      const deployedIds: string[] = data.deployed || [];
      const failedScenarios: { id: string, error: string }[] = data.failed || [];
      const duplicates: { scenarioId: string, resources: string[] }[] = data.duplicates || [];
      const populated: { scenarioId: string, manifestFound: boolean, results: { label: string, status: string, error?: string }[] }[] = data.populated || [];

      for (const p of populated) {
        const scenario = scenarios.find(s => s.id === p.scenarioId);
        const scenarioName = scenario ? scenario.name : p.scenarioId;
        const anyFailed = p.results.some(r => r.status === 'failed');
        if (anyFailed) {
          addNotification('populate', 'failure', `Populate had failures for ${scenarioName}`, p.results.filter(r => r.status === 'failed').map(r => `${r.label}: ${r.error}`).join('; '));
        } else {
          addNotification('populate', 'success', `Populated ${scenarioName} with seed content`);
        }
      }

      // Surface duplicate warnings per scenario
      const dupMap: Record<string, string[]> = {};
      for (const d of duplicates) {
        dupMap[d.scenarioId] = d.resources;
      }
      setDeployDuplicates(dupMap);

      for (const id of deployedIds) {
        setDeployStatuses(prev => ({ ...prev, [id]: 'success' }));
        
        const scenario = scenarios.find(s => s.id === id);
        const scenarioName = scenario ? scenario.name : id;
        addNotification('deploy', 'success', `Successfully deployed ${scenarioName} to ${globalAccountId}`);
        
        const existingIndex = currentActiveScenarios.findIndex(
          s => s.scenarioId === id && s.accountId === globalAccountId
        );

        if (existingIndex >= 0) {
          // Update existing active deployment in-place
          currentActiveScenarios[existingIndex] = {
            ...currentActiveScenarios[existingIndex],
            deployedAt: new Date().toISOString(),
          };
        } else {
          // Add new active deployment
          const newDeployment: ActiveScenario = {
            id: Math.random().toString(36).substr(2, 9),
            scenarioId: id,
            scenarioName: scenarioName,
            accountId: globalAccountId,
            deployedAt: new Date().toISOString(),
          };
          currentActiveScenarios = [newDeployment, ...currentActiveScenarios];
        }
      }

      for (const failure of failedScenarios) {
        setDeployStatuses(prev => ({ ...prev, [failure.id]: 'error' }));
        const scenario = scenarios.find(s => s.id === failure.id);
        addNotification('deploy', 'failure', `Failed to deploy ${scenario?.name || failure.id}`, failure.error);
      }
      
      setActiveScenarios(currentActiveScenarios);
      saveActiveScenarios(currentActiveScenarios);
      
    } catch (err) {
      console.error(`Failed to deploy batch:`, err);
      // Fallback for network errors or unhandled 500s
      for (const id of selectedIds) {
        setDeployStatuses(prev => ({ ...prev, [id]: 'error' }));
      }
    }
    
    // Wait a moment then clear selected
    setTimeout(() => {
      setSelectedIds([]);
      setDeployStatuses({});
      setDeployDuplicates({});
      setActiveTab("rules");
      setSelectedActiveAccount(globalAccountId);
    }, 3000);
  };


  return (
        <>
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
            {/* Own colours, so these read as sources rather than the red page tabs above:
                green like the GitHub sync bar, purple like the Custom badge on cards. */}
            {([
              ["official", `Open-source scenarios (${scenarios.length - customCount})`, "16, 185, 129", "#34d399"],
              ["custom", `Custom scenarios (${customCount})`, "139, 92, 246", "#a78bfa"],
            ] as const).map(([section, text, rgb, fg]) => {
              const on = catalogSection === section;
              return (
                <button key={section} className="btn btn-secondary" onClick={() => setCatalogSection(section)}
                  style={on ? { background: `rgba(${rgb}, 0.15)`, borderColor: `rgba(${rgb}, 0.6)`, color: fg } : undefined}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: fg, opacity: on ? 1 : 0.6 }} />
                  {text}
                </button>
              );
            })}
          </div>
          {catalogSection === "official"
            ? <ScenarioSyncBar onSynced={() => setScenariosVersion((v) => v + 1)} />
            : <CustomScenarioUpload onSaved={() => setScenariosVersion((v) => v + 1)} />}
          {isLoadingScenarios ? (
            <div className="glass-panel" style={{ padding: "3rem", textAlign: "center" }}>
              <p className="spinner-text text-muted">Loading scenarios...</p>
            </div>
          ) : (
            <>
              {/* Master Deploy Button Area */}
              {selectedIds.length > 0 && (
                <>
                  <IndividualRuleToggle
                    isIndividual={isIndividualRule}
                    onChange={setIsIndividualRule}
                  />
                  {selectedIds.some(id => scenarios.find(s => s.id === id)?.populateSupported) && (
                    <PopulateOnDeployToggle
                      populateOnDeploy={populateOnDeploy}
                      onChange={setPopulateOnDeploy}
                    />
                  )}
                  <div className="glass-panel" style={{ padding: "1.5rem", marginBottom: "2rem", border: "1px solid var(--accent-red)", background: "rgba(239, 68, 68, 0.05)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <h3 style={{ margin: 0 }}>{selectedIds.length} Scenario{selectedIds.length > 1 ? 's' : ''} Selected</h3>
                      <p className="text-muted" style={{ margin: 0, fontSize: "0.875rem" }}>Ready to deploy to Spoke Account {globalAccountId || "<Target Account>"}</p>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                      <button
                        className="btn btn-secondary"
                        onClick={handleSelectAllScenarios}
                        title={allDeployableSelected ? "Clear the selection" : `Select all ${deployableIds.length} deployable scenarios`}
                        style={{ padding: "0.75rem 1.25rem", fontSize: "0.875rem", whiteSpace: "nowrap" }}
                      >
                        {allDeployableSelected
                          ? <><X size={16} /> Deselect All</>
                          : <><CheckSquare size={16} /> Select All ({deployableIds.length})</>}
                      </button>
                      <button className="btn btn-primary" onClick={handleMasterDeploy} style={{ padding: "0.75rem 2rem", fontSize: "1rem" }}>
                        <Play size={18} /> Deploy Selected Paths
                      </button>
                    </div>
                  </div>
                </>
              )}

              <div className="catalog-grid" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                {visibleScenarios.length === 0 && (
                  <div className="glass-panel" style={{ padding: "3rem", textAlign: "center" }}>
                    <p className="text-muted" style={{ margin: 0 }}>
                      {catalogSection === "custom" ? "No custom scenarios yet. Use \"Add custom scenario\" to upload one." : "No open-source scenarios found."}
                    </p>
                  </div>
                )}
                {visibleScenarios.map((scenario) => {
                  const isSelected = selectedIds.includes(scenario.id);
                  const isExpanded = expandedId === scenario.id;
                  const isComingSoon = !!scenario.comingSoon;

                  return (
                    <div key={scenario.id} className={`glass-panel catalog-item`} style={{ padding: "1.5rem", border: isSelected ? "1px solid var(--accent-red)" : "", opacity: isComingSoon ? 0.55 : 1 }}>
                      <div className="item-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>

                        <div style={{ display: "flex", alignItems: "center", gap: "1rem", flex: 1, cursor: isComingSoon ? "not-allowed" : "pointer" }} onClick={() => handleSelectScenario(scenario.id)}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={isComingSoon}
                            onChange={() => handleSelectScenario(scenario.id)}
                            style={{ width: "20px", height: "20px", accentColor: "var(--accent-red)", cursor: isComingSoon ? "not-allowed" : "pointer" }}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div className="icon-wrapper" style={{ background: "rgba(239, 68, 68, 0.1)", padding: "0.75rem", borderRadius: "12px", display: "flex", alignItems: "center" }}>
                            <Shield size={24} className="accent-red" />
                          </div>
                          <div>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              <h3 style={{ margin: 0, fontSize: "1.1rem" }}>{scenario.name}</h3>
                              {isComingSoon && (
                                <span style={{ fontSize: "0.75rem", padding: "2px 8px", borderRadius: "10px", background: "rgba(148, 163, 184, 0.18)", color: "#94a3b8", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                                  Coming soon
                                </span>
                              )}
                              {scenario.source === "custom" && (
                                <>
                                  <span style={{ fontSize: "0.75rem", padding: "2px 8px", borderRadius: "10px", background: "rgba(139, 92, 246, 0.15)", color: "#a78bfa", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                                    Custom
                                  </span>
                                  <button
                                    className="btn btn-secondary"
                                    style={{ fontSize: "0.7rem", padding: "2px 8px" }}
                                    title="Delete this custom scenario (refused while it is deployed)"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (!confirm(`Delete custom scenario ${scenario.id}? This removes it from this install and its S3 backup.`)) return;
                                      const res = await fetch(`/api/custom-scenarios?id=${encodeURIComponent(scenario.id)}`, { method: "DELETE" });
                                      const body = await res.json();
                                      if (!res.ok) alert(body.error || "Delete failed.");
                                      else setScenariosVersion((v) => v + 1);
                                    }}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}
                              {activeScenarios.some(s => s.scenarioId === scenario.id && (globalAccountId ? s.accountId === globalAccountId : true)) && (
                                <span style={{ fontSize: "0.75rem", padding: "2px 8px", borderRadius: "10px", background: "rgba(16, 185, 129, 0.15)", color: "#10b981", fontWeight: "600" }}>
                                  Active in {activeScenarios.find(s => s.scenarioId === scenario.id && (globalAccountId ? s.accountId === globalAccountId : true))?.accountId}
                                </span>
                              )}
                            </div>
                            {!isExpanded && <p className="text-muted" style={{ margin: 0, fontSize: "0.875rem", marginTop: "4px" }}>{scenario.description.substring(0, 90)}...</p>}
                          </div>
                        </div>

                        {/* Deployment Status UI */}
                        {deployStatuses[scenario.id] && (
                          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "flex-end", justifyContent: "center", paddingRight: "2rem", gap: "4px" }}>
                            {deployStatuses[scenario.id] === 'queued' && (
                              <span style={{ padding: "0.25rem 0.75rem", borderRadius: "12px", background: "rgba(255,255,255,0.1)", fontSize: "0.875rem", color: "var(--text-muted)" }}>Queued</span>
                            )}
                            {deployStatuses[scenario.id] === 'deploying' && (
                              <div style={{ display: "flex", alignItems: "center", gap: "1rem", width: "100%", maxWidth: "300px", justifyContent: "flex-end" }}>
                                <span className="spinner-text" style={{ fontSize: "0.875rem", color: "var(--accent-red)", whiteSpace: "nowrap" }}>Deploying...</span>
                                <div style={{ height: "6px", width: "150px", background: "rgba(255,255,255,0.1)", borderRadius: "4px", overflow: "hidden" }}>
                                  <div className="progress-bar-fill"></div>
                                </div>
                              </div>
                            )}
                            {deployStatuses[scenario.id] === 'success' && (
                              <span style={{ padding: "0.25rem 0.75rem", borderRadius: "12px", background: "rgba(16, 185, 129, 0.1)", color: "#10b981", fontSize: "0.875rem" }}>Complete ✓</span>
                            )}
                            {deployStatuses[scenario.id] === 'error' && (
                              <span style={{ padding: "0.25rem 0.75rem", borderRadius: "12px", background: "rgba(239, 68, 68, 0.1)", color: "var(--accent-red)", fontSize: "0.875rem" }}>Failed ✕</span>
                            )}
                            {/* Duplicate resource warning */}
                            {deployDuplicates[scenario.id] && deployDuplicates[scenario.id].length > 0 && (
                              <span title={`Already registered: ${deployDuplicates[scenario.id].join(', ')}`} style={{ padding: "0.25rem 0.75rem", borderRadius: "12px", background: "rgba(234,179,8,0.12)", color: "#eab308", fontSize: "0.8rem", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "help" }}>
                                ⚠️ {deployDuplicates[scenario.id].length} resource{deployDuplicates[scenario.id].length > 1 ? 's' : ''} already registered
                              </span>
                            )}
                          </div>
                        )}
                    
                        <div 
                          style={{ padding: "0.5rem", cursor: "pointer", background: "rgba(255,255,255,0.05)", borderRadius: "8px" }}
                          onClick={() => setExpandedId(isExpanded ? null : scenario.id)}
                        >
                          {isExpanded ? <ChevronUp className="text-muted" /> : <ChevronDown className="text-muted" />}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="item-details" style={{ marginTop: "1.5rem", borderTop: "1px solid var(--border-color)", paddingTop: "1.5rem", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2rem" }}>
                          <div className="details-left">
                            <h4 className="text-gradient" style={{ marginBottom: "0.5rem" }}>Attack Path Overview</h4>
                            <p className="text-muted" style={{ marginBottom: "1.5rem", whiteSpace: "pre-wrap" }}>{scenario.description}</p>
                            <div style={{ padding: "1rem", background: "rgba(239, 68, 68, 0.1)", borderRadius: "8px", border: "1px solid var(--border-red)" }}>
                              <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text-main)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                <AlertCircle size={16} className="accent-red"/>
                                Rule changes wait for your review in Active Rules; nothing is pushed until you approve.
                              </p>
                            </div>
                          </div>

                          <div className="details-right" style={{ background: "rgba(0,0,0,0.3)", padding: "1.5rem", borderRadius: "12px", border: "1px solid var(--border-color)" }}>
                            <h4 style={{ marginBottom: "1.5rem" }}>Resources Deployed</h4>
                            <p className="text-muted" style={{ fontSize: "0.875rem", whiteSpace: "pre-wrap", margin: 0 }}>
                              {scenario.resources || "No resources listed."}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
  );
}
