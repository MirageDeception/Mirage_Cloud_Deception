"use client";

import { useState, useEffect } from "react";
import { BrainCircuit, CheckCircle, Trash2 } from "lucide-react";
import { Loader } from "../../components/Loader";
import type { BrainRecord } from "@/lib/brains";

export default function DeployBrain() {
  const [activeTab, setActiveTab] = useState<"deploy" | "remove">("deploy");
  const [status, setStatus] = useState<"idle" | "deploying" | "removing" | "success" | "removed" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deployedHubs, setDeployedHubs] = useState<string[]>([]);
  const [brains, setBrains] = useState<BrainRecord[]>([]);
  // The hub account is fixed by roleArns.brainDeploy(); the form must not imply
  // otherwise. Fetched rather than hardcoded so it follows MIRAGE_HUB_ACCOUNT_ID.
  const [hubAccountId, setHubAccountId] = useState<string>("");

  const [accountId, setAccountId] = useState("");

  const fetchBrains = async () => {
    try {
      const res = await fetch("/api/brains");
      if (res.ok) {
        const data = await res.json();
        if (data.brains) {
          setBrains(data.brains);
        }
        if (data.hubAccountId) {
          setHubAccountId(data.hubAccountId);
          setAccountId(data.hubAccountId);
        }
      }
    } catch { /* the form still works without the list */ }
  };
  
  useEffect(() => {
    // From a timer, not the effect body, so no setState runs synchronously in the effect.
    const first = setTimeout(() => {
      fetchBrains();
      const saved = localStorage.getItem("deployedHubAccounts");
      if (saved) {
        try {
          setDeployedHubs(JSON.parse(saved));
        } catch { /* corrupt list: start empty */ }
      }
    }, 0);
    return () => clearTimeout(first);
  }, []);

  const [email, setEmail] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [whitelistedArns, setWhitelistedArns] = useState(
    `${process.env.NEXT_PUBLIC_MIRAGE_RESOURCE_PREFIX || "mirage-ops"}-spoke-deployment-role,AWSServiceRoleForConfig,AWSServiceRoleForResourceExplorer,AWSServiceRoleForAccessAnalyzer,AWSServiceRoleForTrustedAdvisor,AWSServiceRoleForComputeOptimizer`
  );

  const [removeAccountId, setRemoveAccountId] = useState("");
  const [removeRoleArn, setRemoveRoleArn] = useState("");

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountId) return;

    setStatus("deploying");
    setErrorMessage(null);

    try {
      const response = await fetch("/api/deploy-brain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, email, webhookUrl, whitelistedArns }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Deployment script failed");
      }

      const updatedHubs = Array.from(new Set([...deployedHubs, accountId]));
      setDeployedHubs(updatedHubs);
      localStorage.setItem("deployedHubAccounts", JSON.stringify(updatedHubs));

      // ONLY transition to success when the backend has fully finished with HTTP 200
      setStatus("success");
      fetchBrains();
    } catch (error) {
      console.error("[MIRAGE Deployment Error]:", error);
      const msg = error instanceof Error ? error.message : "Deployment failed";
      setErrorMessage(msg);
      setStatus("error");
    }
  };

  const handleRemove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!removeAccountId || !removeRoleArn) return;

    if (!confirm("Are you sure you want to completely tear down the Hub architecture? This action cannot be undone.")) return;

    setStatus("removing");
    setErrorMessage(null);

    try {
      const response = await fetch("/api/remove-brain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: removeAccountId, roleArn: removeRoleArn }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Removal script failed");
      }

      // ONLY transition to removed when the backend has fully finished with HTTP 200
      setStatus("removed");
      fetchBrains();
    } catch (error) {
      console.error("[MIRAGE Removal Error]:", error);
      const msg = error instanceof Error ? error.message : "Removal failed";
      setErrorMessage(msg);
      setStatus("error");
    }
  };

  return (
    <div className="deploy-brain-page">
      <header className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "2rem" }}>
        <div>
          <h1>Manage Hub Architecture</h1>
          <p className="text-muted">Deploy or remove the centralized monitoring brain.</p>
        </div>
      </header>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "2rem", borderBottom: "1px solid var(--border-color)", paddingBottom: "1rem" }}>
        <button 
          className={`btn ${activeTab === "deploy" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("deploy")}
        >
          <BrainCircuit size={18} /> Deploy Brain
        </button>
        <button 
          className={`btn ${activeTab === "remove" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setActiveTab("remove")}
        >
          <Trash2 size={18} /> Remove Brain
        </button>
      </div>

      <div className="glass-panel deploy-panel" style={{ position: "relative", minHeight: "400px", overflow: "hidden" }}>
        <Loader active={status === "deploying" || status === "removing"} text={status === "deploying" ? "Orchestrating Deployment..." : "Tearing Down Architecture..."} />

        {activeTab === "deploy" && (
          <>
            <div className="panel-header">
              <BrainCircuit size={32} className="accent-red" />
              <h2>Hub Configuration</h2>
              <p className="text-muted text-sm mt-2">
                Provide the credentials for the AWS Account that will act as your centralized monitoring brain. MIRAGE will automatically deploy the Global EventBus, Event Processor Lambda, and Alert SNS Topic into this account.
              </p>
            </div>

            {status === "error" && errorMessage && (
              <div className="error-banner mt-4" style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid var(--accent-red)", padding: "1rem", borderRadius: "8px", color: "var(--accent-red)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <strong>Deployment Failed:</strong> {errorMessage}
                </div>
                <button type="button" className="btn btn-secondary" style={{ padding: "0.25rem 0.75rem", fontSize: "0.8rem" }} onClick={() => setStatus("idle")}>Dismiss</button>
              </div>
            )}

            {status === "success" ? (
              <div className="success-state mt-4">
                <CheckCircle size={48} className="accent-red mb-4" />
                <h3>Deployment Successful</h3>
                <p className="text-muted">The Monitoring Brain is now active in account <span className="mono">{accountId}</span>.</p>
                <a href="/catalog" className="btn btn-primary mt-4">Proceed to Deception Catalog</a>
              </div>
            ) : (
              <form className="deploy-form mt-4" onSubmit={handleDeploy}>
                <div className="form-group">
                  <label htmlFor="accountId">Hub AWS Account ID</label>
                  <input
                    id="accountId"
                    type="text"
                    value={accountId}
                    readOnly
                    placeholder={hubAccountId ? "" : "loading..."}
                    className="input-field mono"
                  />
                  <small className="text-muted">
                    The monitoring brain always deploys into the hub account. This is not
                    selectable: the deployment role is fixed to the hub, so a different value
                    here would be ignored for placement but still recorded, leaving the registry
                    claiming a brain that lives elsewhere.
                  </small>
                </div>
                
                <div className="form-group mt-4">
                  <label htmlFor="roleArn">Brain Deployment Role (auto-derived)</label>
                  <input
                    id="roleArn"
                    type="text"
                    value={accountId ? `arn:aws:iam::${accountId}:role/${process.env.NEXT_PUBLIC_MIRAGE_RESOURCE_PREFIX || "mirage-ops"}-brain-deployment-role` : ""}
                    readOnly
                    placeholder="Enter the hub account ID above"
                    className="input-field mono"
                  />
                  <small className="text-muted">Assumed via the hub service role. No manual ARN needed.</small>
                </div>

                <div className="form-group mt-4">
                  <label htmlFor="email">Alert Email (Optional)</label>
                  <input 
                    id="email"
                    type="email" 
                    placeholder="analyst@enterprise.com" 
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input-field"
                  />
                </div>

                <div className="form-group mt-4">
                  <label htmlFor="webhookUrl">SOAR Webhook URL (Optional)</label>
                  <input 
                    id="webhookUrl"
                    type="url" 
                    placeholder="https://hooks.slack.com/... or SOAR Endpoint" 
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    className="input-field"
                  />
                </div>

                <div className="form-group mt-4">
                  <label htmlFor="whitelistedArns">Whitelisted ARNs (Comma-separated)</label>
                  <input 
                    id="whitelistedArns"
                    type="text" 
                    placeholder=":role/Scanner" 
                    value={whitelistedArns}
                    onChange={(e) => setWhitelistedArns(e.target.value)}
                    className="input-field mono"
                  />
                </div>

                <div className="form-actions mt-4">
                  <button 
                    type="submit" 
                    className="btn btn-primary w-full"
                    disabled={status === "deploying"}
                  >
                    <BrainCircuit size={20} />
                    Deploy Monitoring Brain
                  </button>
                </div>
              </form>
            )}
          </>
        )}

        {activeTab === "remove" && (
          <>
            <div className="panel-header">
              <Trash2 size={32} className="accent-red" />
              <h2>Teardown Hub</h2>
              <p className="text-muted text-sm mt-2">
                Permanently delete the Global EventBus, Processor Lambda, and all Service Rules from the Hub account. This action cannot be undone.
              </p>
            </div>

            {status === "error" && errorMessage && (
              <div className="error-banner mt-4" style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid var(--accent-red)", padding: "1rem", borderRadius: "8px", color: "var(--accent-red)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <strong>Teardown Failed:</strong> {errorMessage}
                </div>
                <button type="button" className="btn btn-secondary" style={{ padding: "0.25rem 0.75rem", fontSize: "0.8rem" }} onClick={() => setStatus("idle")}>Dismiss</button>
              </div>
            )}

            {status === "removed" ? (
              <div className="success-state mt-4">
                <CheckCircle size={48} className="accent-red mb-4" />
                <h3>Architecture Removed</h3>
                <p className="text-muted">The Hub architecture was successfully deleted from account <span className="mono">{removeAccountId}</span>.</p>
                <button className="btn btn-secondary mt-4" onClick={() => setStatus("idle")}>Remove Another</button>
              </div>
            ) : (
              <form className="deploy-form mt-4" onSubmit={handleRemove}>
                <div className="form-group">
                  <label htmlFor="removeAccountId">Target AWS Account ID</label>
                  <input 
                    id="removeAccountId"
                    type="text" 
                    list="deployed-hubs-list"
                    placeholder="e.g., 123456789012" 
                    value={removeAccountId}
                    onChange={(e) => setRemoveAccountId(e.target.value)}
                    required
                    className="input-field mono"
                  />
                  <datalist id="deployed-hubs-list">
                    {deployedHubs.map(hub => (
                      <option key={hub} value={hub} />
                    ))}
                  </datalist>
                </div>
                
                <div className="form-group mt-4">
                  <label htmlFor="removeRoleArn">Cross-Account Hub Role ARN</label>
                  <input 
                    id="removeRoleArn"
                    type="text" 
                    placeholder="arn:aws:iam::123456789012:role/Mirage-Hub-Deployment-Role" 
                    value={removeRoleArn}
                    onChange={(e) => setRemoveRoleArn(e.target.value)}
                    required
                    className="input-field mono"
                  />
                </div>

                <div className="form-actions mt-4">
                  <button 
                    type="submit" 
                    className="btn btn-secondary w-full"
                    style={{ borderColor: "var(--accent-red)", color: "var(--accent-red)" }}
                    disabled={status === "removing"}
                  >
                    <Trash2 size={20} />
                    Remove Architecture
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
      
      {/* Registered Monitoring Brains Registry List */}
      <div className="glass-panel" style={{ marginTop: "2rem", padding: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "1rem" }}>
          <BrainCircuit size={22} className="accent-red" />
          <h3 style={{ margin: 0, fontSize: "1.1rem" }}>Registered Monitoring Brains</h3>
        </div>
        {brains.length === 0 ? (
          <p className="text-muted text-sm">No monitoring brains registered yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {brains.map((b) => (
              <div 
                key={b.accountId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.75rem 1rem",
                  borderRadius: "8px",
                  background: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid var(--border-color)",
                  flexWrap: "wrap",
                  gap: "10px"
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span className="mono" style={{ fontWeight: "600", color: "#fff" }}>{b.accountId}</span>
                    <span style={{ fontSize: "0.75rem", padding: "2px 8px", borderRadius: "10px", background: b.status === 'active' ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)", color: b.status === 'active' ? "#10b981" : "#ef4444", fontWeight: "600" }}>
                      {b.status === 'active' ? 'Active Hub' : 'Removed'}
                    </span>
                    <span className="text-muted text-xs">({b.region})</span>
                  </div>
                  <div className="mono text-muted text-xs mt-1" style={{ wordBreak: "break-all" }}>
                    {b.globalBusArn}
                  </div>
                </div>
                <div className="text-muted text-xs">
                  Registered: {new Date(b.deployedAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
