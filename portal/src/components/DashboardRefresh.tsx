"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

/**
 * Keeps the dashboard's numbers current without a page reload.
 *
 * The dashboard is a server component (app/page.tsx reads getDashboardMetrics()
 * directly and is force-dynamic), so there is nothing client-side to re-fetch.
 * router.refresh() re-runs that server render and swaps in the new values,
 * which means the metric logic stays in one place -- no duplicate client-side
 * copy of the counts, and no new API route to keep in sync.
 *
 * Deliberately NOT a full reload: refresh() preserves scroll position and
 * component state, so a background tick cannot yank the page under the reader.
 */
const REFRESH_MS = 10_000;

export function DashboardRefresh() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [manual, setManual] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      // Skip the tick while the tab is hidden. A background tab polling a
      // force-dynamic route hits DynamoDB every 10s for nobody to read.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      startTransition(() => router.refresh());
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);

  const spinning = isPending || manual;

  return (
    <button
      className="btn btn-secondary"
      onClick={() => {
        setManual(true);
        startTransition(() => router.refresh());
        // The transition can resolve faster than the eye can see it; hold the
        // spin briefly so a click always registers as having done something.
        setTimeout(() => setManual(false), 600);
      }}
      title={`Refresh now (auto-refreshes every ${REFRESH_MS / 1000}s)`}
      style={{ padding: "0.5rem 0.9rem", fontSize: "0.8125rem", display: "flex", alignItems: "center", gap: "0.4rem" }}
    >
      <RefreshCw
        size={14}
        style={{
          animation: spinning ? "spin 0.8s linear infinite" : undefined,
        }}
      />
      Refresh
    </button>
  );
}
