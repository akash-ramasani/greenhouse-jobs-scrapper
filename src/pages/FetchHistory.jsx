import React, { useEffect, useState } from "react";
import { db } from "../firebase";
import { collection, query, orderBy, limit, onSnapshot, doc, updateDoc } from "firebase/firestore";
import { useToast } from "../components/Toast/ToastProvider.jsx";

function fmtDateTime(ts) {
  if (!ts?.toDate) return "—";
  const d = ts.toDate();
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtSince(ts) {
  if (!ts?.toDate) return "—";
  const diffMs = Date.now() - ts.toDate().getTime();
  const mins = Math.floor(diffMs / 60000), hours = Math.floor(mins / 60), days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return mins > 0 ? `${mins}m ago` : "just now";
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function FetchHistory({ user }) {
  const { showToast } = useToast();
  const [runs, setRuns] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [schedulerEnabled, setSchedulerEnabled] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    const unsubRuns = onSnapshot(query(collection(db, "users", user.uid, "fetchRuns"), orderBy("startedAt", "desc"), limit(50)), (snap) => {
      setRuns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });

    const unsubUser = onSnapshot(doc(db, "users", user.uid), (snap) => {
      if (snap.exists()) setSchedulerEnabled(snap.data().schedulerEnabled !== false);
    });

    return () => { unsubRuns(); unsubUser(); };
  }, [user.uid]);

  const toggleScheduler = async () => {
    setIsUpdating(true);
    try {
      await updateDoc(doc(db, "users", user.uid), { schedulerEnabled: !schedulerEnabled });
      showToast(schedulerEnabled ? "Schedule Paused" : "Schedule Resumed", "info");
    } catch (err) {
      showToast("Update failed", "error");
    } finally { setIsUpdating(false); }
  };

  return (
    <div className="space-y-8 py-10" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Fetch History</h1>
          <p className="mt-1 text-sm text-gray-600 tracking-tight">Logs for every automated and manual job search.</p>
        </div>

        <div className="flex items-center gap-3 bg-white p-2 rounded-xl ring-1 ring-gray-200 shadow-sm transition-all hover:ring-indigo-200">
          <div className="px-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Schedule Status</p>
            <p className={`text-xs font-bold ${schedulerEnabled ? 'text-green-600' : 'text-amber-600'}`}>
              {schedulerEnabled ? '● Active' : '○ Paused'}
            </p>
          </div>
          <button
            onClick={toggleScheduler}
            disabled={isUpdating}
            className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${
              schedulerEnabled ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200" : "bg-indigo-600 text-white shadow-lg"
            }`}
          >
            {isUpdating ? "..." : schedulerEnabled ? "Pause Schedule" : "Resume Schedule"}
          </button>
        </div>
      </div>

      <div className="overflow-hidden bg-white shadow-sm ring-1 ring-gray-200 sm:rounded-xl">
        <ul className="divide-y divide-gray-100">
          {runs.map((r) => {
            const isOpen = openId === r.id;
            const badgeCls = r.runType === "scheduled" ? "bg-gray-100 text-gray-700 ring-gray-200" : "bg-indigo-50 text-indigo-700 ring-indigo-100";
            return (
              <li key={r.id} className="px-4 py-5 sm:px-6 hover:bg-gray-50/80 transition-colors">
                <div className="flex items-start justify-between gap-x-6">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ring-1 ring-inset ${badgeCls}`}>{r.runType}</span>
                      <span className="text-sm font-semibold text-gray-900">Ran {fmtSince(r.startedAt)}</span>
                      <span className="text-gray-300">|</span>
                      <span className="text-sm text-gray-600">{fmtDateTime(r.startedAt)}</span>
                    </div>
                    <div className="mt-2 text-sm text-gray-700">
                      Fetched <span className="font-bold">{r.feedsCount}</span> feed(s) • Found <span className="font-bold text-indigo-600">{r.newCount}</span> new job(s) • Duration <span className="font-bold">{fmtDuration(r.durationMs)}</span>
                    </div>
                    {isOpen && r.errorSamples?.length > 0 && (
                      <div className="mt-4 rounded-lg bg-red-50 ring-1 ring-inset ring-red-100 p-4">
                        <ul className="space-y-3">
                          {r.errorSamples.map((e, idx) => (
                            <li key={idx} className="text-xs">
                              <div className="text-gray-500 font-mono truncate">{e.url}</div>
                              <div className="text-red-800 mt-1 font-semibold">{e.message}</div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  <button onClick={() => setOpenId(isOpen ? null : r.id)} className="text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800">
                    {isOpen ? "Hide" : "View"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}