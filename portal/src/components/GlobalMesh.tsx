"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus, RotateCcw, Route } from "lucide-react";
import { meshAncestors as ancestors, meshIdentities, meshKey, shortCaller, type MeshActor } from "@/lib/mesh-paths";

// Global mesh: an explorable canvas of the deception fabric. The hub is the root;
// clicking a spoke opens its scenarios, clicking a scenario opens its decoys. Spokes
// never link to each other -- the only edge out of an account goes to the hub.
// "Attack paths" overlays the hits one actor made, in order, across accounts.
// Identities (caller + IP) with unresolved alerts sit outside the accounts, linked to what they touched.

export type MeshDecoy = {
  name: string; type: string; category?: string; alerted: boolean; alerts?: number; lastSeen?: string;
  /** Is a pushed rule watching it: yes, only in one region (an older regional rule), or no. */
  watch?: 'yes' | 'partial' | 'no';
  /** Who touched it, from its unresolved alerts. */
  actors?: MeshActor[];
};
const AMBER = "#eab308";
export type MeshScenario = { id: string; name: string; custom?: boolean; decoys: MeshDecoy[] };
export type MeshSpoke = { accountId: string; name?: string; region: string; scenarios: MeshScenario[] };
export type MeshHit = {
  id: string; ts: string; accountId: string; eventName: string; resourceName: string;
  caller: string; sourceIp?: string; userAgent?: string; accessKeyId?: string;
  node?: string; // the decoy's canvas id (meshKey.decoy) when it is still deployed
  resolved?: boolean;
};

const RED = "#ef4444", GREY = "#64748b";
// Red is for what still needs attention; resolved history is drawn grey.
const allResolved = (hits: MeshHit[]) => hits.every(h => h.resolved);
const COLX = [0, 280, 580, 880, 1300], ROW = 50, SPOKE_GAP = 40, H = 580;
const R = { hub: 30, spoke: 18, scen: 11, decoy: 6, identity: 9 };
type Kind = keyof typeof R;
type XY = { x: number; y: number };
type Node = XY & { key: string; kind: Kind; parent?: string; title: string; sub?: string; hot: boolean; open?: boolean; custom?: boolean; spoke?: number; decoy?: MeshDecoy;
  links?: string[]; caller?: string; alerts?: number; decoys?: string[] };

const label = (s: MeshSpoke) => s.name ?? s.accountId;

/** Visible tree in canvas coordinates: one row per leaf, parents centred on children. */
function layout(spokes: MeshSpoke[], open: Set<string>): Node[] {
  const out: Node[] = [];
  let y = 0;
  const leaf = () => { const v = y; y += ROW; return v; };
  const mid = (kids: Node[]) => (kids[0].y + kids[kids.length - 1].y) / 2;
  const spokeNodes = spokes.map((s, i) => {
    const sk = meshKey.spoke(s.accountId), sOpen = open.has(sk);
    const scens = !sOpen ? [] : s.scenarios.map(c => {
      const ck = meshKey.scen(s.accountId, c.id), cOpen = open.has(ck);
      const ds = !cOpen ? [] : c.decoys.map((d): Node => ({
        key: meshKey.decoy(s.accountId, c.id, d.name), kind: "decoy", parent: ck, x: COLX[3], y: leaf(), title: d.name, sub: d.type, hot: d.alerted, spoke: i, decoy: d,
      }));
      const node: Node = { key: ck, kind: "scen", parent: sk, x: COLX[2], y: ds.length ? mid(ds) : leaf(), title: c.name,
        sub: `${c.decoys.length} decoy${c.decoys.length === 1 ? "" : "s"}${c.custom ? " · custom" : ""}`,
        hot: c.decoys.some(d => d.alerted), open: cOpen, custom: c.custom, spoke: i };
      out.push(...ds);
      return node;
    });
    const n = s.scenarios.reduce((a, c) => a + c.decoys.length, 0);
    const node: Node = { key: sk, kind: "spoke", parent: "hub", x: COLX[1], y: scens.length ? mid(scens) : leaf(), title: label(s),
      sub: `${s.scenarios.length} scenarios · ${n} decoys`, // regions are on the account boundary label
      hot: s.scenarios.some(c => c.decoys.some(d => d.alerted)), open: sOpen, spoke: i };
    out.push(...scens);
    y += SPOKE_GAP;
    return node;
  });
  out.push(...spokeNodes);
  out.push({ key: "hub", kind: "hub", x: COLX[0], y: spokeNodes.length ? mid(spokeNodes) : 0, title: "Mirage hub", sub: "event bus", hot: false });
  // Identities: level with what they touched, stacked so they never overlap.
  const yOf = new Map(out.map(n => [n.key, n.y]));
  const ids = meshIdentities(spokes, new Set(yOf.keys())).filter(a => a.links.length)
    .map(a => ({ ...a, y: a.links.reduce((t, k) => t + yOf.get(k)!, 0) / a.links.length })).sort((a, b) => a.y - b.y);
  let last = -Infinity;
  for (const a of ids) {
    last = Math.max(a.y, last + ROW);
    out.push({ key: a.key, kind: "identity", x: COLX[4], y: last, title: shortCaller(a.caller), sub: a.ip ?? "no IP", hot: true,
      links: a.links, caller: a.caller, alerts: a.alerts, decoys: a.decoys });
  }
  return out;
}

const curve = (a: XY, b: XY) => {
  const mx = (a.x + b.x) / 2;
  return `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
};
// Attack arrows bow out to the left of the decoys, through the dimmed tree.
const arc = (a: XY, b: XY, n: number, move: string) =>
  `${move}${a.x - 8},${a.y} Q${Math.min(a.x, b.x) - 150 - 24 * n},${(a.y + b.y) / 2} ${b.x - 8},${b.y}`;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

export function GlobalMesh({ spokes, paths }: { spokes: MeshSpoke[]; paths: MeshHit[][] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(spokes.length === 1 ? [meshKey.spoke(spokes[0].accountId)] : []));
  const [attack, setAttack] = useState(false);
  const [pathIdx, setPathIdx] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const box = useRef<HTMLDivElement>(null);
  // One pointer gesture: pans the canvas, or drags `node` when it started on one.
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; node?: string } | null>(null);
  const [moved, setMoved] = useState<Record<string, XY>>({}); // offsets of nodes the user dragged, by stable id
  const [live, setLive] = useState<{ key: string; dx: number; dy: number } | null>(null); // the drag in progress

  // Open paths first, so the default selection is the one that needs attention.
  const ordered = useMemo(() => [...paths].sort((a, b) => Number(allResolved(a)) - Number(allResolved(b))), [paths]);
  const openCount = ordered.filter(p => !allResolved(p)).length;
  const path = attack ? ordered[Math.min(pathIdx, ordered.length - 1)] : undefined;
  const pathDone = !!path && allResolved(path);
  // Attack mode opens whatever the selected path touches, without changing the user's own expansion.
  const effOpen = useMemo(() => {
    if (!path) return open;
    const s = new Set(open);
    path.forEach(h => h.node && ancestors(h.node).forEach(a => s.add(a)));
    return s;
  }, [open, path]);
  const target = useMemo(
    () => layout(spokes, effOpen).map(n => (moved[n.key] ? { ...n, x: n.x + moved[n.key].x, y: n.y + moved[n.key].y } : n)),
    [spokes, effOpen, moved]);

  // Glide nodes to their new spots; new nodes grow out of their parent.
  const [pos, setPos] = useState<Record<string, XY>>(() => Object.fromEntries(target.map(n => [n.key, { x: n.x, y: n.y }])));
  const posRef = useRef(pos);
  useEffect(() => {
    const from = posRef.current, start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = ease(Math.min(1, (now - start) / 380));
      const next: Record<string, XY> = {};
      for (const n of target) {
        const f = from[n.key] ?? (n.parent && from[n.parent]) ?? n;
        next[n.key] = { x: f.x + (n.x - f.x) * t, y: f.y + (n.y - f.y) * t };
      }
      posRef.current = next;
      setPos(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  const at = (n: Node): XY => {
    const p = pos[n.key] ?? (n.parent && pos[n.parent]) ?? n;
    return live?.key === n.key ? { x: p.x + live.dx, y: p.y + live.dy } : p;
  };
  // Drop a dragged node where it is: keep its offset, and start any glide from the drop point.
  const endGesture = () => {
    if (live) {
      const p = posRef.current[live.key];
      if (p) { posRef.current = { ...posRef.current, [live.key]: { x: p.x + live.dx, y: p.y + live.dy } }; setPos(posRef.current); }
      setMoved(m => ({ ...m, [live.key]: { x: (m[live.key]?.x ?? 0) + live.dx, y: (m[live.key]?.y ?? 0) + live.dy } }));
      setLive(null);
    }
    setTimeout(() => { drag.current = null; }, 0); // after the click that ends a drag has been ignored
  };

  const fit = () => {
    const el = box.current;
    if (!el || !target.length) return;
    const xs = target.map(n => n.x), ys = target.map(n => n.y);
    const x0 = Math.min(...xs) - 60, x1 = Math.max(...xs) + 300, y0 = Math.min(...ys) - 60, y1 = Math.max(...ys) + 60;
    const w = el.clientWidth, k = Math.min(1.4, Math.max(0.2, Math.min(w / (x1 - x0), H / (y1 - y0))));
    setView({ k, x: (w - (x1 - x0) * k) / 2 - x0 * k, y: (H - (y1 - y0) * k) / 2 - y0 * k });
  };
  const fitRef = useRef(fit);
  useEffect(() => { fitRef.current = fit; });
  // Fit on load and when the attack view changes (the visible set changes a lot).
  useEffect(() => { const t = setTimeout(() => fitRef.current(), 0); return () => clearTimeout(t); }, [attack, pathIdx]);
  // ...and when the canvas changes width (window resize, sidebar), so it never opens off-centre.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => { if (el.clientWidth !== w) { w = el.clientWidth; fitRef.current(); } });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoomAt = (cx: number, cy: number, factor: number) =>
    setView(v => {
      const k = Math.min(3, Math.max(0.2, v.k * factor));
      return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
    });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false }); // a passive listener cannot stop the page scrolling
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const toggle = (key: string) => {
    if (drag.current?.moved) return; // the click that ends a drag is not an expand
    setOpen(prev => {
      const s = new Set(prev);
      if (!s.has(key)) s.add(key);
      else {
        s.delete(key);
        if (key.startsWith("s|")) [...s].filter(k => k.startsWith(`c|${key.slice(2)}|`)).forEach(k => s.delete(k));
      }
      return s;
    });
  };

  const byKey = Object.fromEntries(target.map(n => [n.key, n]));

  // Path steps: consecutive hits on the same decoy collapse into one step.
  const steps: { hits: MeshHit[]; node?: string }[] = [];
  path?.forEach(h => {
    const last = steps[steps.length - 1];
    if (last && h.node && last.node === h.node) last.hits.push(h);
    else steps.push({ hits: [h], node: h.node });
  });
  const onPath = new Set(steps.flatMap(s => (s.node ? [s.node, ...ancestors(s.node)] : [])));
  const drawn = steps.filter(s => s.node && byKey[s.node]);
  const dim = (key: string) => {
    if (!path || key === "hub" || onPath.has(key)) return 1;
    return byKey[key]?.links?.some(k => onPath.has(k)) ? 1 : 0.22; // an identity stays lit when it touched the path
  };

  const describe = (key: string) => {
    const n = byKey[key];
    if (!n) return "";
    if (n.kind === "decoy") {
      const d = n.decoy!;
      const watch = d.watch === "no" ? " · NOT MONITORED: its rule is not pushed yet"
        : d.watch === "partial" ? " · only partly monitored: push the identity rule" : "";
      return `${d.type} · ${d.name} · ${d.alerted ? `${d.alerts ?? 1} unresolved alert${d.alerts === 1 ? "" : "s"}` : "no unresolved alerts"}${watch}`;
    }
    if (n.kind === "identity") return `${n.caller} · ${n.sub} · ${n.alerts} unresolved alert${n.alerts === 1 ? "" : "s"} on ${n.decoys!.length} decoy${n.decoys!.length === 1 ? "" : "s"}`;
    if (n.kind === "spoke") return `${spokes[n.spoke!].accountId} · ${spokes[n.spoke!].region} · ${n.sub} · click to ${n.open ? "collapse" : "expand"}`;
    if (n.kind === "scen") return `${n.title} · ${n.sub} · click to ${n.open ? "collapse" : "expand"}`;
    return "Mirage hub · every spoke forwards decoy events here";
  };

  const allDecoys = spokes.flatMap(s => s.scenarios.flatMap(c => c.decoys));
  const ctrl: React.CSSProperties = { width: 32, height: 32, display: "grid", placeItems: "center", background: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: 8, color: "var(--text-main)", cursor: "pointer" };
  const center = (): [number, number] => [(box.current?.clientWidth ?? 0) / 2, H / 2];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        <span className="text-muted" style={{ fontSize: "0.85rem" }}>
          {spokes.length} account{spokes.length === 1 ? "" : "s"} · {allDecoys.length} decoys · {allDecoys.filter(d => d.alerted).length} with unresolved alerts
          {(n => n > 0 && ` · ${n} identit${n === 1 ? "y" : "ies"}`)(target.filter(n => n.kind === "identity").length)}
          {allDecoys.some(d => d.watch && d.watch !== "yes") && (
            <span style={{ color: AMBER }}> · {allDecoys.filter(d => d.watch && d.watch !== "yes").length} not fully monitored (push their rules in Active Rules)</span>
          )}
        </span>
        {/* One line, never wraps: a taller header would move the canvas under the pointer and flicker the hover. */}
        <span className="text-muted" style={{ fontSize: "0.8rem", minHeight: "1.2em", flex: "1 1 0", minWidth: 0, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {hover ? describe(hover) : "Drag the canvas or any node · scroll or buttons to zoom · click a node to expand"}
        </span>
      </div>

      <div ref={box} style={{ position: "relative", height: H, borderRadius: 12, border: "1px solid var(--border-color)", overflow: "hidden", cursor: "grab", touchAction: "none",
        backgroundColor: "#070707", backgroundImage: "radial-gradient(rgba(239,68,68,0.12) 1px, transparent 1px)",
        backgroundSize: `${28 * view.k}px ${28 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; }}
        onPointerMove={e => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x, dy = e.clientY - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          d.moved = true;
          if (d.node) setLive({ key: d.node, dx: dx / view.k, dy: dy / view.k });
          else setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
        }}
        onPointerUp={endGesture}
        onPointerLeave={endGesture}>

        <svg width="100%" height={H} role="img" aria-label="Global deception mesh" style={{ display: "block", userSelect: "none" }}>
          <defs>
            <filter id="mesh-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="3.5" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <radialGradient id="mesh-hub" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#7f1d1d" /><stop offset="100%" stopColor="#1a0505" />
            </radialGradient>
            <marker id="mesh-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1 1L9 5L1 9z" fill={RED} />
            </marker>
            <marker id="mesh-arrow-grey" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1 1L9 5L1 9z" fill={GREY} />
            </marker>
          </defs>

          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {/* account boundaries */}
            {spokes.map((s, i) => {
              const mine = target.filter(n => n.spoke === i);
              if (!mine.length) return null;
              const ps = mine.map(at);
              const deepest = Math.max(...mine.map(n => COLX.indexOf(n.x)));
              const x0 = COLX[1] - 50, x1 = COLX[deepest] + (deepest === 3 ? 320 : 250);
              const y0 = Math.min(...ps.map(p => p.y)) - 44, y1 = Math.max(...ps.map(p => p.y)) + 34;
              return (
                <g key={`band${i}`} opacity={dim(meshKey.spoke(s.accountId)) === 1 ? 1 : 0.4}>
                  <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx={18} fill="rgba(239,68,68,0.025)" stroke="rgba(239,68,68,0.25)" strokeDasharray="6 5" />
                  <text x={x0 + 14} y={y0 + 17} fill="#64748b" fontSize={10} fontFamily="Roboto Mono, monospace" letterSpacing={0.5}>
                    {s.accountId} · {s.region.toUpperCase()} · ISOLATED
                  </text>
                </g>
              );
            })}

            {/* tree edges */}
            {target.filter(n => n.parent).map(n => (
              <path key={`e${n.key}`} d={curve(at(n), at(byKey[n.parent!]))} fill="none" opacity={dim(n.key)}
                stroke={n.kind === "spoke" ? "rgba(239,68,68,0.45)" : n.hot ? "rgba(239,68,68,0.55)" : "rgba(148,163,184,0.16)"}
                strokeWidth={n.kind === "spoke" ? 1.6 : n.hot ? 1.3 : 0.9} />
            ))}

            {/* identity -> what it touched */}
            {target.filter(n => n.kind === "identity").flatMap(n => n.links!.filter(k => byKey[k]).map(k => (
              <path key={`i${n.key}>${k}`} d={curve(at(byKey[k]), at(n))} fill="none" opacity={dim(n.key)}
                stroke={RED} strokeOpacity={0.55} strokeWidth={1.1} strokeDasharray="4 3" />
            )))}

            {/* live pulses: hot nodes forward to the hub; quiet spokes send a heartbeat */}
            {!path && target.filter(n => n.kind !== "hub" && n.kind !== "identity" && (n.hot || n.kind === "spoke") && !(n.kind !== "decoy" && n.open && n.hot)).map(n => {
              let d = "", cur = n;
              while (cur.parent) {
                const p = byKey[cur.parent];
                d += (d ? " " : "") + curve(at(cur), at(p)).replace(/^M/, d ? "L" : "M");
                cur = p;
              }
              return (
                <circle key={`p${n.key}`} r={n.hot ? 3.2 : 2} fill={n.hot ? "#fca5a5" : "rgba(248,250,252,0.5)"} filter={n.hot ? "url(#mesh-glow)" : undefined}>
                  <animateMotion dur={n.hot ? "2.6s" : "3.4s"} repeatCount="indefinite" path={d} />
                </circle>
              );
            })}

            {/* attack path arrows; account hops are thicker and dashed */}
            {drawn.slice(1).map((s, n) => {
              const hop = drawn[n].hits[0].accountId !== s.hits[0].accountId, done = allResolved(s.hits);
              return (
                <path key={`a${n}`} d={arc(at(byKey[drawn[n].node!]), at(byKey[s.node!]), n, "M")} fill="none"
                  stroke={done ? GREY : RED} strokeWidth={hop ? 2.6 : 1.8} strokeDasharray={hop ? "7 4" : undefined}
                  markerEnd={`url(#${done ? "mesh-arrow-grey" : "mesh-arrow"})`} filter={done ? undefined : "url(#mesh-glow)"} />
              );
            })}
            {drawn.length > 1 && (
              <circle r={4} fill={pathDone ? "#94a3b8" : "#fecaca"} filter={pathDone ? undefined : "url(#mesh-glow)"}>
                <animateMotion dur={`${1.2 * drawn.length}s`} repeatCount="indefinite"
                  path={drawn.slice(1).map((s, n) => arc(at(byKey[drawn[n].node!]), at(byKey[s.node!]), n, n ? "L" : "M")).join(" ")} />
              </circle>
            )}

            {/* nodes */}
            {target.map(n => {
              const p = at(n), r = R[n.kind], clickable = n.kind === "spoke" || n.kind === "scen";
              const big = hover === n.key ? 2 : 0;
              return (
                <g key={n.key} opacity={dim(n.key)} style={{ cursor: live?.key === n.key ? "grabbing" : clickable ? "pointer" : "grab" }}
                  onPointerDown={e => { e.stopPropagation(); drag.current = { x: e.clientX, y: e.clientY, vx: 0, vy: 0, moved: false, node: n.key }; }}
                  onClick={() => clickable && toggle(n.key)} onMouseEnter={() => setHover(n.key)} onMouseLeave={() => setHover(null)}>
                  <circle cx={p.x} cy={p.y} r={r + 12} fill="transparent" />
                  {n.kind === "hub" ? (
                    <g filter="url(#mesh-glow)">
                      <circle cx={p.x} cy={p.y} r={r} fill="url(#mesh-hub)" stroke={RED} strokeWidth={2} />
                      <circle cx={p.x} cy={p.y} r={r} fill="none" stroke={RED}>
                        <animate attributeName="r" from={r} to={r + 18} dur="2.4s" repeatCount="indefinite" />
                        <animate attributeName="opacity" from="0.7" to="0" dur="2.4s" repeatCount="indefinite" />
                      </circle>
                    </g>
                  ) : n.kind === "identity" ? (
                    <g filter="url(#mesh-glow)">
                      <circle cx={p.x} cy={p.y} r={r + big} fill="#1a0505" stroke={RED} strokeWidth={1.4} />
                      <circle cx={p.x} cy={p.y - 3} r={2.6} fill="#fca5a5" />
                      <path d={`M${p.x - 4.5},${p.y + 5.5}a4.5,4 0 0 1 9,0z`} fill="#fca5a5" />
                    </g>
                  ) : n.kind === "decoy" ? (
                    <>
                      <circle cx={p.x} cy={p.y} r={r + big} fill={n.hot ? RED : "#1c1c1c"} stroke={n.hot ? "#fca5a5" : "#525252"} filter={n.hot ? "url(#mesh-glow)" : undefined} />
                      {n.decoy?.watch && n.decoy.watch !== "yes" && (
                        <circle cx={p.x} cy={p.y} r={r + 4 + big} fill="none" stroke={AMBER} strokeWidth={1.4} strokeDasharray="3 2" pointerEvents="none" />
                      )}
                    </>
                  ) : (
                    <>
                      <circle cx={p.x} cy={p.y} r={r + big} fill={n.kind === "spoke" ? "#1a0a0a" : "#141414"} stroke={RED}
                        strokeOpacity={n.kind === "spoke" ? 1 : 0.7} strokeWidth={n.kind === "spoke" ? 1.6 : 1.2}
                        strokeDasharray={n.custom ? "3 2" : undefined} filter={n.hot ? "url(#mesh-glow)" : undefined} />
                      <circle cx={p.x} cy={p.y} r={r * 0.42} fill={n.hot ? RED : "#7f1d1d"} />
                      {/* expand / collapse badge */}
                      <circle cx={p.x + r * 0.75} cy={p.y + r * 0.75} r={6} fill="#0b0b0b" stroke="#525252" />
                      <path d={`M${p.x + r * 0.75 - 3},${p.y + r * 0.75}h6${n.open ? "" : `M${p.x + r * 0.75},${p.y + r * 0.75 - 3}v6`}`} stroke="#cbd5e1" strokeWidth={1.2} />
                    </>
                  )}
                  {n.kind === "hub" ? (
                    <>
                      <text x={p.x} y={p.y + r + 20} textAnchor="middle" fill="#f8fafc" fontSize={13} fontWeight={600}>{n.title}</text>
                      <text x={p.x} y={p.y + r + 35} textAnchor="middle" fill="#94a3b8" fontSize={10} fontFamily="Roboto Mono, monospace">{n.sub}</text>
                    </>
                  ) : n.kind === "decoy" ? (
                    <text x={p.x + r + 10} y={p.y + 4} fill={n.hot ? "#fca5a5" : "#e2e8f0"} fontSize={12}>
                      <tspan fill="#64748b" fontFamily="Roboto Mono, monospace" fontSize={10}>{n.sub!.toUpperCase()} </tspan>{n.title}
                    </text>
                  ) : (
                    <>
                      <text x={p.x + r + 10} y={p.y - 2} fill="#f1f5f9" fontSize={n.kind === "spoke" ? 13 : 12} fontWeight={600}>{n.title}</text>
                      <text x={p.x + r + 10} y={p.y + 13} fill="#94a3b8" fontSize={10} fontFamily="Roboto Mono, monospace">{n.sub}</text>
                    </>
                  )}
                </g>
              );
            })}

            {/* step numbers */}
            {steps.map((s, n) => {
              if (!s.node || !byKey[s.node]) return null;
              const p = at(byKey[s.node]);
              const same = steps.slice(0, n).filter(o => o.node === s.node).length;
              return (
                <g key={`n${n}`} pointerEvents="none">
                  <circle cx={p.x - 20 - same * 20} cy={p.y - 12} r={8} fill={allResolved(s.hits) ? GREY : RED} filter={allResolved(s.hits) ? undefined : "url(#mesh-glow)"} />
                  <text x={p.x - 20 - same * 20} y={p.y - 8.5} textAnchor="middle" fill="#fff" fontSize={10} fontWeight={700}>{n + 1}</text>
                </g>
              );
            })}
          </g>
        </svg>

        <div style={{ position: "absolute", top: 12, right: 12, display: "flex", flexDirection: "column", gap: 6 }} onPointerDown={e => e.stopPropagation()}>
          <button aria-label="Zoom in" title="Zoom in" style={ctrl} onClick={() => zoomAt(...center(), 1.25)}><Plus size={16} /></button>
          <button aria-label="Zoom out" title="Zoom out" style={ctrl} onClick={() => zoomAt(...center(), 0.8)}><Minus size={16} /></button>
          <button aria-label="Fit to screen" title="Fit to screen" style={ctrl} onClick={fit}><Maximize2 size={15} /></button>
          {Object.keys(moved).length > 0 && (
            <button aria-label="Reset layout" title="Put dragged nodes back" style={ctrl} onClick={() => setMoved({})}><RotateCcw size={15} /></button>
          )}
        </div>
        <div style={{ position: "absolute", top: 12, left: 12 }} onPointerDown={e => e.stopPropagation()}>
          <button className={`btn ${attack ? "btn-primary" : "btn-secondary"}`} style={{ padding: "0.45rem 0.85rem", fontSize: "0.8rem" }}
            onClick={() => setAttack(a => !a)} title="Show the decoys one actor hit, in order">
            <Route size={14} /> Attack paths ({openCount} open{ordered.length > openCount ? ` · ${ordered.length - openCount} resolved` : ""})
          </button>
        </div>
        <div style={{ position: "absolute", bottom: 10, right: 14, fontSize: 11, color: "#64748b", fontFamily: "Roboto Mono, monospace" }}>{Math.round(view.k * 100)}%</div>
      </div>

      {attack && (
        <div style={{ marginTop: "0.9rem" }}>
          {ordered.length === 0 ? (
            <p className="text-muted" style={{ fontSize: "0.85rem" }}>No attack paths yet. A path appears when one actor (same access key, or same IP and tool within an hour) hits decoys more than once.</p>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "0.75rem" }}>
                {ordered.map((p, i) => {
                  const accts = new Set(p.map(h => h.accountId)).size, done = allResolved(p), on = i === Math.min(pathIdx, ordered.length - 1);
                  return (
                    <button key={p[0].id} className={`btn ${on && !done ? "btn-primary" : "btn-secondary"}`} onClick={() => setPathIdx(i)}
                      style={{ padding: "0.35rem 0.75rem", fontSize: "0.75rem", ...(on && done ? { borderColor: "#94a3b8", color: "var(--text-main)" } : {}) }}>
                      Path {i + 1}{done ? " · Resolved" : ""} · {p.length} hits · {accts} account{accts === 1 ? "" : "s"} · {new Date(p[p.length - 1].ts).toLocaleString()}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                {steps.map((s, n) => {
                  const h = s.hits[0], prev = steps[n - 1]?.hits[0];
                  const hop = prev && prev.accountId !== h.accountId, c = allResolved(s.hits) ? GREY : RED;
                  return (
                    <div key={h.id} style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr)", gap: 10, alignItems: "start", fontSize: "0.8rem", opacity: s.node ? 1 : 0.55 }}>
                      <span style={{ width: 22, height: 22, borderRadius: 999, background: c, color: "#fff", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700 }}>{n + 1}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: "var(--text-main)" }}>
                          {hop && <span style={{ color: c, fontWeight: 600 }}>Hop to {h.accountId} · </span>}
                          {h.eventName} on <span style={{ fontFamily: "Roboto Mono, monospace" }}>{h.resourceName}</span>
                          {s.hits.length > 1 && <span className="text-muted"> ×{s.hits.length}</span>}
                          {!s.node && <span className="text-muted"> (decoy no longer deployed)</span>}
                          {allResolved(s.hits) && <span className="text-muted"> · resolved</span>}
                        </div>
                        <div className="text-muted" style={{ fontSize: "0.72rem", overflowWrap: "anywhere" }}>
                          {new Date(h.ts).toLocaleString()} · {h.accountId} · {h.caller}{h.sourceIp ? ` · ${h.sourceIp}` : ""}{h.accessKeyId ? ` · key ${h.accessKeyId.slice(0, 8)}…` : ""}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "1.25rem", marginTop: "0.9rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
        <Legend label="Hub"><circle cx={8} cy={8} r={6} fill="url(#mesh-hub)" stroke={RED} strokeWidth={1.5} /></Legend>
        <Legend label="Spoke account"><circle cx={8} cy={8} r={6} fill="#1a0a0a" stroke={RED} strokeWidth={1.4} /><circle cx={8} cy={8} r={2.5} fill="#7f1d1d" /></Legend>
        <Legend label="Scenario"><circle cx={8} cy={8} r={5} fill="#141414" stroke={RED} strokeOpacity={0.7} /></Legend>
        <Legend label="Custom scenario"><circle cx={8} cy={8} r={5} fill="#141414" stroke={RED} strokeOpacity={0.7} strokeDasharray="3 2" /></Legend>
        <Legend label="Decoy, quiet"><circle cx={8} cy={8} r={4} fill="#1c1c1c" stroke="#525252" /></Legend>
        <Legend label="Decoy, unresolved alert"><circle cx={8} cy={8} r={4} fill={RED} stroke="#fca5a5" /></Legend>
        <Legend label="Not monitored yet"><circle cx={8} cy={8} r={3} fill="#1c1c1c" stroke="#525252" /><circle cx={8} cy={8} r={6.5} fill="none" stroke={AMBER} strokeDasharray="3 2" /></Legend>
        <Legend label="Identity that touched a decoy (name · IP)"><circle cx={8} cy={8} r={6.5} fill="#1a0505" stroke={RED} strokeWidth={1.2} /><circle cx={8} cy={6} r={2} fill="#fca5a5" /><path d="M4.6,12a3.4,3 0 0 1 6.8,0z" fill="#fca5a5" /></Legend>
        <Legend label="Isolated account"><rect x={1} y={2} width={14} height={12} rx={3} fill="none" stroke="rgba(239,68,68,0.5)" strokeDasharray="3 2" /></Legend>
        <Legend label="Attack step"><path d="M1 13 Q8 0 15 8" fill="none" stroke={RED} strokeWidth={1.6} /></Legend>
        <Legend label="Account hop"><path d="M1 13 Q8 0 15 8" fill="none" stroke={RED} strokeWidth={2} strokeDasharray="3 2" /></Legend>
        <Legend label="Resolved step"><path d="M1 13 Q8 0 15 8" fill="none" stroke={GREY} strokeWidth={1.6} /></Legend>
      </div>
    </div>
  );
}

function Legend({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <svg width={16} height={16} aria-hidden="true">{children}</svg>{label}
    </span>
  );
}
