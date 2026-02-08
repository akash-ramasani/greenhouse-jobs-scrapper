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
import { useToast } from "../components/Toast/ToastProvider.jsx";

export default function Home({ user }) {
  const { showToast } = useToast();
  const [company, setCompany] = useState("");
  const [url, setUrl] = useState("");
  const [feeds, setFeeds] = useState([]);
  const [busyNow, setBusyNow] = useState(false);
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
    const cleanCompany = company.trim();
    const cleanUrl = url.trim().toLowerCase();

    if (!cleanCompany || !cleanUrl) return;

    if (!/^https:\/\/.+/i.test(cleanUrl)) {
      showToast("Please use a valid https:// URL", "error");
      return;
    }

    // Duplicate Check Logic
    const isDuplicate = feeds.some(
      (f) => f.url.toLowerCase() === cleanUrl
    );

    if (isDuplicate) {
      showToast("This feed URL has already been added.", "error");
      return;
    }

    try {
      await addDoc(collection(db, "users", user.uid, "feeds"), {
        company: cleanCompany,
        url: cleanUrl,
        createdAt: serverTimestamp(),
        lastCheckedAt: null,
        lastError: null,
        archivedAt: null,
      });

      showToast(`${cleanCompany} feed added successfully`, "success");
      setCompany("");
      setUrl("");
    } catch (err) {
      showToast("Failed to add feed. Please try again.", "error");
    }
  }

  async function fetchNow() {
  setBusyNow(true);
  try {
    // IMPORTANT: use the same region you deployed the Gen2 functions to
    const functions = getFunctions(undefined, "us-central1");

    // IMPORTANT: call the V2 callable name you deployed (Option A)
    const callFn = httpsCallable(functions, "pollNowV2");

    const resp = await callFn({});
    const data = resp.data || {};

    // Your V2 returns { enqueued: true }, not {feeds,newCount} immediately.
    // So show a different message.
    showToast("Fetch started. New jobs will appear shortly.", "success");
  } catch (err) {
    console.error(err);
    showToast("Manual fetch failed. Try again later.", "error");
  } finally {
    setBusyNow(false);
  }
}


  async function archiveFeed(feedId) {
    setBusyArchiveId(feedId);
    try {
      await updateDoc(doc(db, "users", user.uid, "feeds", feedId), {
        archivedAt: serverTimestamp(),
      });
      showToast("Feed archived", "info");
    } catch (err) {
      showToast("Error archiving feed", "error");
    } finally {
      setBusyArchiveId(null);
    }
  }

  async function restoreFeed(feedId) {
    setBusyArchiveId(feedId);
    try {
      await updateDoc(doc(db, "users", user.uid, "feeds", feedId), {
        archivedAt: null,
      });
      showToast("Feed restored to active", "success");
    } catch (err) {
      showToast("Error restoring feed", "error");
    } finally {
      setBusyArchiveId(null);
    }
  }

  return (
    <div className="space-y-12 py-10" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      {/* ===== TOP GRID ===== */}
      <div className="section-grid">
        <div>
          <h2 className="text-[10px] font-black uppercase tracking-widest text-gray-400">
            Job Board Sources
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Connect Greenhouse job boards. Our system will automatically monitor
            these for new opportunities.
          </p>

          <div className="mt-6">
            <button
              onClick={fetchNow}
              disabled={busyNow}
              className="btn-secondary w-full sm:w-auto uppercase tracking-widest text-[11px] font-black"
            >
              {busyNow ? "Checking..." : "Check for new jobs now"}
            </button>
          </div>
        </div>

        <div className="md:col-span-2">
          <form onSubmit={addFeed} className="space-y-4">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-6">
              <div className="sm:col-span-4">
                <label className="block text-xs font-black uppercase tracking-widest text-gray-400">
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
                <label className="block text-xs font-black uppercase tracking-widest text-gray-400">
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

            <button type="submit" className="btn-primary uppercase tracking-widest text-[11px] font-black">
              Add Feed
            </button>
          </form>
        </div>
      </div>

      {/* ===== CENTERED FEEDS ===== */}
      <div className="mx-auto max-w-3xl space-y-10">
        {/* ACTIVE FEEDS */}
        <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b bg-indigo-50/60 border-indigo-100 flex items-center justify-between">
            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-indigo-900">
                Active Feeds{" "}
                <span className="ml-1 text-indigo-700">
                  ({activeFeeds.length})
                </span>
              </h3>
              <p className="text-[11px] text-indigo-700 mt-1">
                These feeds are monitored for new jobs.
              </p>
            </div>
          </div>

          <ul className="divide-y divide-gray-100">
            {activeFeeds.map((feed) => (
              <li
                key={feed.id}
                className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
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
                  className="text-[10px] font-black uppercase tracking-widest text-amber-600 hover:text-amber-800 disabled:opacity-50"
                >
                  Archive
                </button>
              </li>
            ))}

            {activeFeeds.length === 0 && (
              <li className="px-6 py-10 text-center text-sm text-gray-400 italic">
                No active feeds. Add one above to start monitoring.
              </li>
            )}
          </ul>
        </div>

        {/* ARCHIVED FEEDS */}
        <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b bg-gray-50/80 border-gray-200 flex items-center justify-between">
            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-600">
                Archived Feeds{" "}
                <span className="ml-1 text-gray-400">
                  ({archivedFeeds.length})
                </span>
              </h3>
              <p className="text-[11px] text-gray-500 mt-1">
                Archived feeds are not monitored.
              </p>
            </div>
          </div>

          <ul className="divide-y divide-gray-100">
            {archivedFeeds.map((feed) => (
              <li
                key={feed.id}
                className="flex items-center justify-between px-6 py-4 hover:bg-gray-50 transition-colors"
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
                  className="text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                >
                  Restore
                </button>
              </li>
            ))}

            {archivedFeeds.length === 0 && (
              <li className="px-6 py-10 text-center text-sm text-gray-400 italic">
                No archived feeds.
              </li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}