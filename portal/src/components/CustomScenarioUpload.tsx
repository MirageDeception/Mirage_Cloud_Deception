"use client";

import { useState } from "react";
import { Upload, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";

/**
 * "Add custom scenario": name + description + a zip of the scenario folder (built from
 * scenarios/_template). Check first -- shows exactly what the files would create and any
 * problem -- then Save, which only works when every check passed.
 */
interface Result {
  id: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  resources: string[];
  exists?: boolean;
  saved?: boolean;
  warning?: string | null;
  error?: string;
}

export function CustomScenarioUpload({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (action: "check" | "save") => {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("name", name);
    form.append("description", description);
    form.append("file", file);
    form.append("action", action);
    form.append("replace", String(replace));
    try {
      const res = await fetch("/api/custom-scenarios", { method: "POST", body: form });
      const body: Result = await res.json();
      if (!res.ok && !body.id) {
        setResult(null);
        setError(body.error || "Upload failed.");
      } else {
        setResult(body);
        if (body.error) setError(body.error);
        if (body.saved) onSaved();
      }
    } catch {
      setError("Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  // Any edit invalidates an earlier check.
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); setResult(null); setError(null); };

  if (!open) {
    return (
      <div style={{ marginBottom: "1rem" }}>
        <button className="btn btn-secondary" onClick={() => setOpen(true)}>
          <Upload size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          Add custom scenario
        </button>
      </div>
    );
  }

  const canSave = !!result?.ok && !result.saved && (!result.exists || replace);

  return (
    <div className="glass-panel" style={{ padding: "1.25rem", marginBottom: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <h3 style={{ margin: 0, fontSize: "1rem" }}>Add a custom scenario</h3>
        <button className="btn btn-secondary" style={{ fontSize: "0.8rem" }} onClick={() => setOpen(false)}>Close</button>
      </div>
      <p className="text-muted" style={{ margin: "0 0 0.75rem", fontSize: "0.8rem" }}>
        Private to this install. Start from <code>scenarios/_template</code> in the repo (its README lists the rules),
        then upload the folder as a .zip. Nothing is saved until every check passes.
      </p>
      <div style={{ display: "grid", gap: "0.6rem" }}>
        <input className="input-field" placeholder="Name, e.g. Payroll database lure" value={name}
          onChange={(e) => edit(setName)(e.target.value)} />
        <textarea className="input-field" placeholder="What it baits and what it detects" rows={2} value={description}
          onChange={(e) => edit(setDescription)(e.target.value)} />
        <input type="file" accept=".zip,application/zip"
          onChange={(e) => edit(setFile)(e.target.files?.[0] ?? null)} />
      </div>
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-secondary" disabled={busy || !file || !name || !description} onClick={() => submit("check")}>
          {busy ? "Working…" : "Check"}
        </button>
        <button className="btn btn-primary" disabled={busy || !canSave} onClick={() => submit("save")}>Save</button>
        {result?.exists && !result.saved && (
          <label style={{ fontSize: "0.8rem" }}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace existing {result.id}
          </label>
        )}
      </div>

      {error && <p style={{ color: "var(--accent-red)", fontSize: "0.85rem", margin: "0.75rem 0 0" }}>{error}</p>}

      {result && (
        <div style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
          {result.saved ? (
            <p style={{ color: "#10b981", margin: 0 }}>
              <CheckCircle2 size={14} style={{ verticalAlign: "-2px" }} /> Saved as <strong>{result.id}</strong> — it is now in the catalog.
            </p>
          ) : result.ok ? (
            <p style={{ color: "#10b981", margin: 0 }}>
              <CheckCircle2 size={14} style={{ verticalAlign: "-2px" }} /> All checks passed for <strong>{result.id}</strong>.
            </p>
          ) : (
            <p style={{ color: "var(--accent-red)", margin: 0 }}>
              <XCircle size={14} style={{ verticalAlign: "-2px" }} /> {result.errors.length} problem(s) — fix them and check again.
            </p>
          )}
          {result.warning && (
            <p style={{ color: "#f59e0b", margin: "0.4rem 0 0" }}><AlertTriangle size={14} style={{ verticalAlign: "-2px" }} /> {result.warning}</p>
          )}
          {result.errors.length > 0 && (
            <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.25rem", color: "var(--accent-red)" }}>
              {result.errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          {result.warnings.length > 0 && (
            <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.25rem", color: "#f59e0b" }}>
              {result.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          {result.resources.length > 0 && (
            <>
              <p className="text-muted" style={{ margin: "0.6rem 0 0.2rem" }}>Resources these files create:</p>
              <ul style={{ margin: 0, paddingLeft: "1.25rem" }} className="text-muted">
                {result.resources.map((r) => <li key={r}><code>{r}</code></li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
