import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db } from "../firebase";

export default function Home({ user }) {
  const [company, setCompany] = useState("");
  const [url, setUrl] = useState("");
  const [feeds, setFeeds] = useState([]);
  const [busyNow, setBusyNow] = useState(false);
  const [toast, setToast] = useState(null);
  const [busyArchiveId, setBusyArchiveId] = useState(null);

  useEffect(() => {
    const feedsRef = collection(db, "users", user.uid, "feeds");
    const qFeeds = query(feedsRef, orderBy("createdAt", "desc"));
    return onSnapshot(qFeeds, (snap) =>
      setFeeds(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
  }, [user.uid]);

  const activeFeeds = useMemo(
    () => feeds.filter((f) => !f.archivedAt),
    [feeds]
  );

  const archivedFeeds = useMemo(
    () => feeds.filter((f) => !!f.archivedAt),
    [feeds]
  );

  async function addFeed(e) {
    e.preventDefault();
    if (!company.trim() || !url.trim()) return;

    const u = url.trim();
    if (!/^https:\/\/.+/i.test(u)) {
      alert("Please use an https:// URL");
      return;
    }

    await addDoc(collection(db, "users", user.uid, "feeds"), {
      company: company.trim(),
      url: u,
      createdAt: serverTimestamp(),
      lastCheckedAt: null,
      lastError: null,
      archivedAt: null,
    });

    setCompany("");
    setUrl("");
  }

  async function fetchNow() {
    setBusyNow(true);
    try {
      const functions = getFunctions();
      const callFn = httpsCallable(functions, "pollNow");
      const resp = await callFn({});
      const data = resp.data || {};
      setToast({
        text: `Fetched ${data.feeds ?? 0} feed(s). ${data.newCount ?? 0} new job(s).`,
      });
      setTimeout(() => setToast(null), 6000);
    } finally {
      setBusyNow(false);
    }
  }

  async function archiveFeed(feedId) {
    setBusyArchiveId(feedId);
    await updateDoc(doc(db, "users", user.uid, "feeds", feedId), {
      archivedAt: serverTimestamp(),
    });
    setBusyArchiveId(null);
  }

  async function restoreFeed(feedId) {
    setBusyArchiveId(feedId);
    await updateDoc(doc(db, "users", user.uid, "feeds", feedId), {
      archivedAt: null,
    });
    setBusyArchiveId(null);
  }

  return (
    <div className="space-y-12 py-10">
      {/* ===== TOP GRID ===== */}
      <div className="section-grid">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Job Board Sources
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Connect Greenhouse job boards. Our system will automatically monitor
            these for new opportunities.
          </p>

          <div className="mt-6">
            <button
              onClick={fetchNow}
              disabled={busyNow}
              className="btn-secondary w-full sm:w-auto"
            >
              {busyNow ? "Checking..." : "Check for new jobs now"}
            </button>
          </div>
        </div>

        <div className="md:col-span-2">
          <form onSubmit={addFeed} className="space-y-4">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-6">
              <div className="sm:col-span-4">
                <label className="block text-sm font-medium text-gray-900">
                  Company Name
                </label>
                <input
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="input-standard mt-2"
                  placeholder="e.g. OpenAI"
                />
              </div>

              <div className="col-span-full">
                <label className="block text-sm font-medium text-gray-900">
                  Greenhouse API Endpoint
                </label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="input-standard mt-2"
                  placeholder="https://boards-api.greenhouse.io/v1/..."
                />
              </div>
            </div>

            <button type="submit" className="btn-primary">
              Add Feed
            </button>
          </form>
        </div>
      </div>

      {/* ===== CENTERED FEEDS ===== */}
      <div className="mx-auto max-w-3xl space-y-10">
        {/* ACTIVE FEEDS */}
        <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b bg-indigo-50/60 border-indigo-100">
            <h3 className="text-sm font-semibold text-indigo-900">
              Active Feeds{" "}
              <span className="ml-1 text-indigo-700 font-medium">
                ({activeFeeds.length})
              </span>
            </h3>
            <p className="text-xs text-indigo-700 mt-1">
              These feeds are monitored for new jobs.
            </p>
          </div>

          <ul className="divide-y divide-gray-100">
            {activeFeeds.map((feed) => (
              <li
                key={feed.id}
                className="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {feed.company || "Company"}
                  </p>
                  <p className="mt-1 truncate text-xs text-gray-500 font-mono">
                    {feed.url}
                  </p>
                </div>

                <button
                  onClick={() => archiveFeed(feed.id)}
                  disabled={busyArchiveId === feed.id}
                  className="text-xs font-bold uppercase tracking-wider text-amber-700 hover:text-amber-900 disabled:opacity-50"
                >
                  Archive
                </button>
              </li>
            ))}

            {activeFeeds.length === 0 && (
              <li className="px-6 py-10 text-center text-sm text-gray-500">
                No active feeds.
              </li>
            )}
          </ul>
        </div>

        {/* ARCHIVED FEEDS */}
        <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b bg-indigo-50/60 border-indigo-100">
            <h3 className="text-sm font-semibold text-indigo-900">
              Archived Feeds{" "}
              <span className="ml-1 text-gray-500 font-medium">
                ({archivedFeeds.length})
              </span>
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              Archived feeds are not monitored. You can restore them anytime.
            </p>
          </div>

          <ul className="divide-y divide-gray-100">
            {archivedFeeds.map((feed) => (
              <li
                key={feed.id}
                className="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {feed.company || "Company"}
                  </p>
                  <p className="mt-1 truncate text-xs text-gray-500 font-mono">
                    {feed.url}
                  </p>
                </div>

                <button
                  onClick={() => restoreFeed(feed.id)}
                  disabled={busyArchiveId === feed.id}
                  className="text-xs font-bold uppercase tracking-wider text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                >
                  Restore
                </button>
              </li>
            ))}

            {archivedFeeds.length === 0 && (
              <li className="px-6 py-10 text-center text-sm text-gray-500">
                No archived feeds.
              </li>
            )}
          </ul>
        </div>
      </div>

      {toast && (
        <div className="fixed right-6 bottom-6 z-40 px-4 py-3 rounded-lg shadow-lg bg-zinc-900 text-zinc-100">
          {toast.text}
        </div>
      )}
    </div>
  );
}
