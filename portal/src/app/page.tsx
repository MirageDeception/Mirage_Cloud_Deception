import { Shield, Server, ShieldAlert, AlertTriangle } from "lucide-react";
import { getDashboardMetrics } from "@/lib/metrics";
import { DashboardRefresh } from "@/components/DashboardRefresh";
import { GlobalMesh } from "@/components/GlobalMesh";
import { buildMesh } from "@/lib/mesh";

// Metrics are read per request: a cached dashboard would show a deploy that has
// since been torn down, which is the class of problem this page is meant to end.
export const dynamic = "force-dynamic";

function StatCard({
  icon,
  label,
  value,
  caption,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  caption: string;
}) {
  const unknown = value === null;
  return (
    <div className="glass-panel stat-card">
      <div className="stat-icon">{icon}</div>
      <div className="stat-info">
        <h3>{label}</h3>
        {/* An em dash rather than 0 when the store could not be read -- 0 would read
            as a measurement. See DashboardMetrics in lib/metrics.ts. */}
        <p className="stat-value" title={unknown ? "Could not be determined" : caption}>
          {unknown ? "—" : value}
        </p>
        <p className="text-muted" style={{ fontSize: "0.75rem" }}>
          {unknown ? "unavailable" : caption}
        </p>
      </div>
    </div>
  );
}

export default async function Home() {
  const { activeDecoys, spokeAccounts, activeAlerts, scenarios, detections, rules, errors } = await getDashboardMetrics();
  // Without the scenario read there is no mesh to draw; without alerts it still draws, all quiet.
  const mesh = scenarios ? await buildMesh(scenarios, detections ?? [], rules) : null;

  return (
    <div className="dashboard-overview">
      <header className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div>
          <h1>Fabric Overview</h1>
          <p className="text-muted">Monitor your multi-cloud deception network.</p>
        </div>
        <DashboardRefresh />
      </header>

      {errors.length > 0 && (
        <div
          className="glass-panel"
          style={{
            padding: "0.875rem 1.25rem",
            marginBottom: "1.5rem",
            borderColor: "var(--accent-red)",
            display: "flex",
            alignItems: "flex-start",
            gap: "0.75rem",
            fontSize: "0.875rem",
          }}
        >
          <AlertTriangle size={18} className="accent-red" style={{ flexShrink: 0, marginTop: "2px" }} />
          <div>
            {errors.map(e => (
              <p key={e} style={{ color: "var(--accent-red)" }}>{e}</p>
            ))}
            <p className="text-muted" style={{ fontSize: "0.8rem" }}>
              Figures below are shown as — rather than 0, because an empty result and an
              unreachable store are not the same answer.
            </p>
          </div>
        </div>
      )}

      <div className="stats-grid">
        <StatCard
          icon={<Server size={24} className="accent-red" />}
          label="Active Decoys"
          value={activeDecoys}
          caption="decoy resources deployed"
        />
        <StatCard
          icon={<Shield size={24} className="accent-red" />}
          label="Spoke Accounts"
          value={spokeAccounts}
          caption="accounts holding decoys"
        />
        <StatCard
          icon={<ShieldAlert size={24} className="accent-red" />}
          label="Active Alerts"
          value={activeAlerts}
          caption="detections awaiting triage"
        />
      </div>

      <div className="glass-panel main-panel mt-4">
        <h2>Global Mesh Status</h2>
        {mesh === null ? (
          <div className="empty-state"><p className="text-muted">Mesh unavailable: deployed-decoy state could not be read.</p></div>
        ) : mesh.spokes.length === 0 ? (
          <div className="empty-state"><p className="text-muted">No decoys deployed yet. Deploy a scenario from the catalog to see it here.</p></div>
        ) : (
          <>
            {detections === null && <p className="text-muted" style={{ fontSize: "0.8rem" }}>Alert state unavailable: every decoy is shown as quiet.</p>}
            <GlobalMesh spokes={mesh.spokes} paths={mesh.paths} />
          </>
        )}
      </div>
    </div>
  );
}
