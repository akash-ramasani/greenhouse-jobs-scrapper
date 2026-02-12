// src/pages/FetchHistory.jsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import { collection, query, orderBy, limit, onSnapshot } from "firebase/firestore";

function fmtDateTime(tsOrDate) {
  const d =
    tsOrDate?.toDate ? tsOrDate.toDate() :
    tsOrDate instanceof Date ? tsOrDate :
    null;

  if (!d || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtSince(tsOrDate) {
  const d =
    tsOrDate?.toDate ? tsOrDate.toDate() :
    tsOrDate instanceof Date ? tsOrDate :
    null;

  if (!d || Number.isNaN(d.getTime())) return "—";

  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusLabel(s) {
  return String(s || "done").toUpperCase();
}

function metric(n) {
  return Number.isFinite(n) ? n : 0;
}

/**
 * SyncRuns doc shape (new):
 * {
 *   ok: true/false,
 *   userId: "...",
 *   source: "syncRecentJobsHourly" | "runSyncNow" | ...,
 *   ranAt: Firestore Timestamp,
 *   scanned: number,
 *   updated: number,
 *   jobsWritten: number (optional),
 *   recentCutoffIso: string (optional),
 *   error: string (optional)
 * }
 */

export default function FetchHistory({ user }) {
  const [runs, setRuns] = useState([]);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!user?.uid) return;

    // ✅ NEW: users/{uid}/syncRuns
    const ref = collection(db, "users", user.uid, "syncRuns");
    const q = query(ref, orderBy("ranAt", "desc"), limit(60));

    return onSnapshot(q, (snap) => {
      setRuns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [user?.uid]);

  const openRun = useMemo(() => runs.find((r) => r.id === openId) || null, [runs, openId]);

  return (
    <div className="space-y-8 py-10" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Sync History</h1>
        <p className="mt-1 text-sm text-gray-600">
          Logs for the “Last 65 Minutes” ingestion window (scheduler runs hourly).
        </p>

        <p className="mt-2 text-xs text-gray-500">
          <span className="font-semibold">Scanned</span> = jobs examined (from feeds / candidate pool).
          {" "}
          <span className="font-semibold">Updated</span> = jobs written/merged to Firestore.
          {" "}
          <span className="font-semibold">Jobs Written</span> = optional field if your backend logs it separately.
        </p>
      </div>

      <div className="overflow-hidden bg-white shadow-sm ring-1 ring-gray-200 sm:rounded-xl">
        <div className="px-4 py-4 sm:px-6 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Recent Runs</h3>
        </div>

        <ul className="divide-y divide-gray-100">
          {runs.map((r) => {
            const isOpen = openId === r.id;

            // Determine run type from `source`
            const source = String(r.source || "");
            const runType =
              source.toLowerCase().includes("manual") ||
              source.toLowerCase().includes("runsyncnow") ||
              source.toLowerCase().includes("http")
                ? "Manual"
                : "Scheduled";

            const badgeCls =
              runType === "Scheduled"
                ? "bg-gray-100 text-gray-700 ring-gray-200"
                : "bg-indigo-50 text-indigo-700 ring-indigo-100";

            // Status derived from ok + error
            const status =
              r.ok === true ? "DONE" :
              r.ok === false ? "FAILED" :
              "DONE";

            const statusCls =
              status === "DONE"
                ? "text-green-700"
                : status === "FAILED"
                ? "text-red-700"
                : "text-gray-500";

            const ranAt = r.ranAt || null;

            const scanned = metric(r.scanned);
            const updated = metric(r.updated);
            const jobsWritten = metric(r.jobsWritten) || updated;

            const durationMs = r.durationMs; // optional if you add it later
            const recentCutoffIso = r.recentCutoffIso || "";
            const recentCutoffDisplay = recentCutoffIso ? fmtDateTime(new Date(recentCutoffIso)) : "—";

            const hasError = Boolean(r.error) || r.ok === false;

            return (
              <li key={r.id} className="px-4 py-5 sm:px-6 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between gap-x-6">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${badgeCls}`}
                      >
                        {runType}
                      </span>

                      <span className="text-sm font-semibold text-gray-900">
                        Ran {fmtSince(ranAt)}
                      </span>

                      <span className="text-gray-300">|</span>

                      <span className="text-sm text-gray-600">{fmtDateTime(ranAt)}</span>

                      <span className="text-gray-300">|</span>

                      <span className={`text-xs font-black uppercase tracking-widest ${statusCls}`}>
                        {statusLabel(status)}
                      </span>
                    </div>

                    {/* Topline summary */}
                    <div className="mt-2 text-sm text-gray-700">
                      Scanned <span className="font-semibold">{scanned}</span>
                      {" "}• Updated <span className="font-semibold">{updated}</span>
                      {" "}• Jobs Written <span className="font-semibold">{jobsWritten}</span>
                      {" "}• Cutoff <span className="font-semibold">{recentCutoffDisplay}</span>
                      {" "}• Duration <span className="font-semibold">{fmtDuration(durationMs)}</span>
                    </div>

                    {/* Mini cards */}
                    <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="rounded-lg ring-1 ring-inset ring-gray-200 bg-white p-3">
                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                          Scanned
                        </div>
                        <div className="mt-1 text-lg font-extrabold text-gray-900">{scanned}</div>
                      </div>

                      <div className="rounded-lg ring-1 ring-inset ring-gray-200 bg-white p-3">
                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                          Updated
                        </div>
                        <div className="mt-1 text-lg font-extrabold text-gray-900">{updated}</div>
                      </div>

                      <div className="rounded-lg ring-1 ring-inset ring-gray-200 bg-white p-3">
                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                          Jobs Written
                        </div>
                        <div className="mt-1 text-lg font-extrabold text-gray-900">{jobsWritten}</div>
                      </div>

                      <div className="rounded-lg ring-1 ring-inset ring-gray-200 bg-white p-3">
                        <div className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                          Result
                        </div>
                        <div className={`mt-1 text-lg font-extrabold ${hasError ? "text-red-700" : "text-green-700"}`}>
                          {hasError ? "Error" : "OK"}
                        </div>
                      </div>
                    </div>

                    {isOpen && (
                      <div className="mt-5 space-y-4">
                        {hasError ? (
                          <div className="rounded-lg bg-red-50 ring-1 ring-inset ring-red-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-red-700">
                              Error
                            </div>

                            <div className="mt-3 text-xs text-red-800 font-mono whitespace-pre-wrap break-words">
                              {String(r.error || "Unknown error")}
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-lg bg-green-50 ring-1 ring-inset ring-green-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-green-700">
                              No errors in this run
                            </div>
                            <div className="mt-2 text-sm text-green-800">
                              Sync completed successfully.
                            </div>
                          </div>
                        )}

                        {/* Details */}
                        <div className="rounded-lg bg-white ring-1 ring-inset ring-gray-200 p-4">
                          <div className="text-[11px] font-black uppercase tracking-widest text-gray-600">
                            Details
                          </div>

                          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm text-gray-700">
                            <div>
                              Source: <span className="font-semibold">{source || "—"}</span>
                            </div>
                            <div>
                              UserId: <span className="font-semibold">{r.userId || user.uid}</span>
                            </div>
                            <div>
                              Ran At: <span className="font-semibold">{fmtDateTime(ranAt)}</span>
                            </div>
                            <div>
                              Recent Cutoff: <span className="font-semibold">{recentCutoffDisplay}</span>
                            </div>
                          </div>

                          {typeof r.jobsWritten === "number" ? (
                            <div className="mt-3 text-xs text-gray-600">
                              Note: <span className="font-semibold">jobsWritten</span> is optional — if missing, UI uses{" "}
                              <span className="font-semibold">updated</span>.
                            </div>
                          ) : null}
                        </div>

                        {/* Human explanation */}
                        <div className="rounded-lg bg-indigo-50 ring-1 ring-inset ring-indigo-100 p-4">
                          <div className="text-[11px] font-black uppercase tracking-widest text-indigo-700">
                            How to read this run
                          </div>
                          <div className="mt-2 text-sm text-indigo-900/90 leading-relaxed">
                            <ul className="list-disc pl-5 space-y-1">
                              <li>
                                <span className="font-semibold">Scanned</span> is how many job records were evaluated.
                              </li>
                              <li>
                                <span className="font-semibold">Updated</span> is how many job docs were written (merge/upsert).
                              </li>
                              <li>
                                <span className="font-semibold">Cutoff</span> shows the start of the “recent window” used by the sync.
                              </li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => setOpenId(isOpen ? null : r.id)}
                    className={`text-xs font-bold uppercase tracking-wider ${
                      isOpen
                        ? "text-gray-600 hover:text-gray-900"
                        : hasError
                        ? "text-red-600 hover:text-red-800"
                        : "text-indigo-600 hover:text-indigo-800"
                    }`}
                  >
                    {isOpen ? "Hide" : "View"}
                  </button>
                </div>
              </li>
            );
          })}

          {!runs.length && (
            <li className="px-4 py-12 text-center text-sm text-gray-500">
              No sync runs yet.
            </li>
          )}
        </ul>
      </div>

      {openRun ? (
        <div className="text-xs text-gray-500">
          Note: With a “last 65 minutes” ingestion window,{" "}
          <span className="font-semibold">Updated</span> may be small when there are no new jobs.
        </div>
      ) : null}
    </div>
  );
}
