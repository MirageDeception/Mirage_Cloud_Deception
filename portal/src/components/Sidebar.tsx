"use client";

import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  BrainCircuit,
  Network,
  Settings,
  ShieldAlert,
  ListChecks,
  Menu,
  X,
} from "lucide-react";
import { NotificationBell } from "@/components/NotificationBell";

const NAV = [
  { href: "/", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/deploy-brain", label: "Deploy Brain", Icon: BrainCircuit },
  { href: "/catalog", label: "Deception Catalog", Icon: Network },
  { href: "/queue", label: "Process Queue", Icon: ListChecks },
  { href: "/alerts", label: "Active Alerts", Icon: ShieldAlert },
  { href: "/settings", label: "Settings", Icon: Settings },
];

/**
 * The nav rail, plus an off-canvas drawer below the narrow breakpoint.
 *
 * Client-side because the drawer needs open/closed state; `layout.tsx` stays a
 * server component. Whether the drawer is available at all is decided in CSS, not
 * here -- no viewport measuring, so there is no server/client mismatch and no
 * flash of the wrong layout on first paint. Above the breakpoint the rail is
 * simply always visible and the toggle is `display: none`, so `open` is inert.
 */
export function Sidebar() {
  const [open, setOpen] = useState(false);

  // Escape closes the drawer, matching the overlay click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="sidebar-toggle"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-controls="mirage-sidebar"
        aria-label={open ? "Close navigation" : "Open navigation"}
      >
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Click-away target. aria-hidden because the toggle already exposes the
          same action to assistive tech. */}
      <div
        className={`sidebar-overlay${open ? " is-open" : ""}`}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      <aside id="mirage-sidebar" className={`sidebar${open ? " is-open" : ""}`}>
        <div className="sidebar-header">
          <h2 className="text-gradient">MIRAGE</h2>
          <NotificationBell />
        </div>
        <nav className="sidebar-nav">
          {NAV.map(({ href, label, Icon }) => (
            <a key={href} href={href} className="nav-link" onClick={() => setOpen(false)}>
              <Icon size={20} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
      </aside>
    </>
  );
}
