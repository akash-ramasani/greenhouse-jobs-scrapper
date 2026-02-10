// src/pages/FetchHistory.jsx
import React, { useEffect, useState } from "react";
import { db } from "../firebase";
import { collection, query, orderBy, limit, onSnapshot } from "firebase/firestore";

function fmtDateTime(ts) {
  if (!ts?.toDate) return "—";
  const d = ts.toDate();
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtSince(ts) {
  if (!ts?.toDate) return "—";
  const d = ts.toDate();
  const diffMs = Date.now() - d.getTime();
  const secs = Math.floor(diffMs / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  if (secs > 5) return `${secs}s ago`;
  return "just now";
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pickRunTime(r) {
  return r.startedAt || r.enqueuedAt || r.createdAt || r.updatedAt || null;
}

function prettyRunType(runType) {
  if (runType === "scheduled") return "Scheduled";
  if (runType === "manual") return "Manual";
  if (runType === "cleanup_scheduled") return "Cleanup (Scheduled)";
  if (runType === "cleanup_manual") return "Cleanup (Manual)";
  return runType ? String(runType) : "Run";
}

function badgeClassForRunType(runType) {
  if (runType === "scheduled") return "bg-gray-100 text-gray-700 ring-gray-200";
  if (runType === "manual") return "bg-indigo-50 text-indigo-700 ring-indigo-100";
  if (String(runType || "").startsWith("cleanup"))
    return "bg-emerald-50 text-emerald-700 ring-emerald-100";
  return "bg-gray-50 text-gray-600 ring-gray-200";
}

function statusClass(statusUpper) {
  if (statusUpper === "DONE") return "text-green-700";
  if (statusUpper === "RUNNING") return "text-amber-700";
  if (statusUpper === "ENQUEUED") return "text-gray-600";
  if (statusUpper === "DONE_WITH_ERRORS") return "text-red-700";
  if (statusUpper === "FAILED" || statusUpper === "ENQUEUE_FAILED") return "text-red-700";
  return "text-gray-500";
}

export default function FetchHistory({ user }) {
  const [runs, setRuns] = useState([]);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!user?.uid) return;
    const ref = collection(db, "users", user.uid, "fetchRuns");
    const q = query(ref, orderBy("createdAt", "desc"), limit(50));

    return onSnapshot(q, (snap) => {
      setRuns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [user?.uid]);

  return (
    <div className="space-y-8 py-10" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Fetch History</h1>
        <p className="mt-1 text-sm text-gray-600">
          “Added” = number of brand-new job documents created in Firestore during that run.
        </p>
      </div>

      <div className="overflow-hidden bg-white shadow-sm ring-1 ring-gray-200 sm:rounded-xl">
        <div className="px-4 py-4 sm:px-6 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900">Recent Runs</h3>
          <p className="text-xs text-gray-500 mt-1">
            Expand a run to see error details (URL + message).
          </p>
        </div>

        <ul className="divide-y divide-gray-100">
          {runs.map((r) => {
            const isOpen = openId === r.id;

            const runTypeLabel = prettyRunType(r.runType);
            const badgeCls = badgeClassForRunType(r.runType);

            const statusUpper = String(r.status || "done").toUpperCase();
            const statusCls = statusClass(statusUpper);

            const runTime = pickRunTime(r);

            const feedsCount = r.feedsCount ?? 0;
            const processedCount = r.processed ?? 0;
            const addedCount = r.createdCount ?? 0;
            const errorsCount = r.errorsCount ?? 0;

            const errorSamples = Array.isArray(r.errorSamples) ? r.errorSamples : [];

            const deletedCount = r.deleted ?? null;
            const isCleanup = String(r.runType || "").startsWith("cleanup");

            return (
              <li key={r.id} className="px-4 py-5 sm:px-6 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between gap-x-6">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${badgeCls}`}
                      >
                        {runTypeLabel}
                      </span>

                      <span className="text-sm font-semibold text-gray-900">
                        Ran {fmtSince(runTime)}
                      </span>

                      <span className="text-gray-300">|</span>

                      <span className="text-sm text-gray-600">{fmtDateTime(runTime)}</span>

                      <span className="text-gray-300">|</span>

                      <span className={`text-xs font-black uppercase tracking-widest ${statusCls}`}>
                        {statusUpper}
                      </span>
                    </div>

                    <div className="mt-2 text-sm text-gray-700">
                      {isCleanup ? (
                        <>
                          Deleted <span className="font-semibold">{deletedCount ?? 0}</span> • Duration{" "}
                          <span className="font-semibold">{fmtDuration(r.durationMs)}</span>
                        </>
                      ) : (
                        <>
                          Feeds <span className="font-semibold">{feedsCount}</span> • Processed{" "}
                          <span className="font-semibold">{processedCount}</span> • Added{" "}
                          <span className="font-semibold">{addedCount}</span> • Duration{" "}
                          <span className="font-semibold">{fmtDuration(r.durationMs)}</span>
                        </>
                      )}
                    </div>

                    {isOpen && (
                      <div className="mt-5 space-y-4">
                        {(statusUpper === "RUNNING" || statusUpper === "ENQUEUED") ? (
                          <div className="rounded-lg bg-amber-50 ring-1 ring-inset ring-amber-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-amber-700">
                              In progress
                            </div>
                            <div className="mt-2 text-sm text-amber-800">
                              This run is still updating.
                            </div>
                          </div>
                        ) : errorsCount === 0 && statusUpper !== "FAILED" && statusUpper !== "ENQUEUE_FAILED" ? (
                          <div className="rounded-lg bg-green-50 ring-1 ring-inset ring-green-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-green-700">
                              No errors in this run
                            </div>
                            <div className="mt-2 text-sm text-green-800">
                              {isCleanup ? "Cleanup completed successfully." : "All feeds completed successfully."}
                            </div>
                          </div>
                        ) : (
                          <div className="rounded-lg bg-red-50 ring-1 ring-inset ring-red-100 p-4">
                            <div className="text-xs font-bold uppercase tracking-widest text-red-700">
                              Errors detected
                            </div>

                            <div className="mt-2 text-sm text-red-800">
                              {statusUpper === "ENQUEUE_FAILED"
                                ? "The run could not be enqueued."
                                : statusUpper === "FAILED"
                                ? "The task failed."
                                : "Some feeds failed during the run."}
                            </div>

                            <div className="mt-2 text-sm text-gray-700">
                              Errors count: <span className="font-semibold">{errorsCount}</span>
                            </div>

                            {r.enqueueError ? (
                              <div className="mt-3 text-xs text-red-800 font-mono whitespace-pre-wrap break-words">
                                {r.enqueueError}
                              </div>
                            ) : null}

                            {r.error ? (
                              <div className="mt-3 text-xs text-red-800 font-mono whitespace-pre-wrap break-words">
                                {r.error}
                              </div>
                            ) : null}

                            {errorSamples.length > 0 ? (
                              <div className="mt-4">
                                <div className="text-xs font-bold uppercase tracking-widest text-red-700">
                                  Error samples
                                </div>
                                <ul className="mt-2 space-y-2">
                                  {errorSamples.map((e, idx) => (
                                    <li
                                      key={idx}
                                      className="rounded-md bg-white/60 ring-1 ring-inset ring-red-100 p-2"
                                    >
                                      <div className="text-[11px] font-mono text-gray-700 break-words">
                                        <span className="font-semibold text-gray-900">URL:</span>{" "}
                                        {e?.url || "—"}
                                      </div>
                                      <div className="text-[11px] font-mono text-red-800 whitespace-pre-wrap break-words mt-1">
                                        {e?.error || "—"}
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : (
                              <div className="mt-3 text-xs text-gray-600">
                                No error samples stored (or older run schema).
                              </div>
                            )}
                          </div>
                        )}

                        <div className="rounded-lg bg-gray-50 ring-1 ring-inset ring-gray-200 p-4">
                          <div className="text-xs font-bold uppercase tracking-widest text-gray-600">
                            Run details
                          </div>
                          <div className="mt-2 text-xs text-gray-700 space-y-1">
                            <div>Created: <span className="font-mono">{fmtDateTime(r.createdAt)}</span></div>
                            <div>Enqueued: <span className="font-mono">{fmtDateTime(r.enqueuedAt)}</span></div>
                            <div>Started: <span className="font-mono">{fmtDateTime(r.startedAt)}</span></div>
                            <div>Finished: <span className="font-mono">{fmtDateTime(r.finishedAt)}</span></div>
                            {isCleanup && r.cutoffUpdatedAtTs ? (
                              <div>
                                Cutoff (updatedAtTs &lt;):{" "}
                                <span className="font-mono">{fmtDateTime(r.cutoffUpdatedAtTs)}</span>
                              </div>
                            ) : null}
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
                        : (errorsCount || 0) > 0 || statusUpper === "FAILED" || statusUpper === "ENQUEUE_FAILED"
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
              No fetch runs yet. Click “Check for new jobs now” or wait for the scheduled poll.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
