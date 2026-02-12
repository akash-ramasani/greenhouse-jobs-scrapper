// src/pages/Home.jsx — NO `active` anywhere, and polling button removed.
// Adds only feeds, archive/restore, and “Reset feeds” trigger.

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

const URL_RULES = {
  greenhouse: {
    label: "Greenhouse API Endpoint",
    placeholder: "https://boards-api.greenhouse.io/v1/boards/<company>/jobs",
    isValid: (u) =>
      /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/[^/]+\/jobs(?:\?.*)?$/i.test(
        u
      ),
    normalize: (u) => u.trim().toLowerCase(),
  },
  ashby: {
    label: "AshbyHQ Job Board Endpoint",
    placeholder: "https://api.ashbyhq.com/posting-api/job-board/<company>",
    isValid: (u) =>
      /^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/[^/?#]+(?:\?.*)?$/i.test(
        u
      ),
    normalize: (u) => u.trim(),
  },
};

function detectSourceFromUrl(raw) {
  const u = (raw || "").trim().toLowerCase();
  if (u.includes("boards-api.greenhouse.io/v1/boards/")) return "greenhouse";
  if (u.includes("api.ashbyhq.com/posting-api/job-board/")) return "ashby";
  return "greenhouse";
}

function prettySourceLabel(source) {
  return source === "ashby" ? "AshbyHQ" : "Greenhouse";
}

function validateUrlForSource(source, rawUrl) {
  const cleanUrl = (rawUrl || "").trim();
  if (!cleanUrl) return { ok: false, error: "Please enter a URL." };
  if (!/^https:\/\//i.test(cleanUrl))
    return { ok: false, error: "Please use a valid https:// URL." };

  const rules = URL_RULES[source] || URL_RULES.greenhouse;
  if (!rules.isValid(cleanUrl)) {
    return {
      ok: false,
      error:
        source === "ashby"
          ? "Ashby URL should look like: https://api.ashbyhq.com/posting-api/job-board/<company>"
          : "Greenhouse URL should look like: https://boards-api.greenhouse.io/v1/boards/<company>/jobs",
    };
  }
  return { ok: true, normalizedUrl: rules.normalize(cleanUrl) };
}

export default function Home({ user }) {
  const { showToast } = useToast();
  const [company, setCompany] = useState("");
  const [url, setUrl] = useState("");
  const [feeds, setFeeds] = useState([]);
  const [busyArchiveId, setBusyArchiveId] = useState(null);
  const [busyReset, setBusyReset] = useState(false);

  useEffect(() => {
    const feedsRef = collection(db, "users", user.uid, "feeds");
    const qFeeds = query(feedsRef, orderBy("createdAt", "desc"));
    return onSnapshot(qFeeds, (snap) =>
      setFeeds(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
  }, [user.uid]);

  const activeFeeds = useMemo(() => feeds.filter((f) => !f.archivedAt), [feeds]);
  const archivedFeeds = useMemo(() => feeds.filter((f) => !!f.archivedAt), [feeds]);
  const detectedSource = useMemo(() => detectSourceFromUrl(url), [url]);

  async function addFeed(e) {
    e.preventDefault();
    const cleanCompany = company.trim();
    const rawUrl = url.trim();
    if (!cleanCompany || !rawUrl) return;

    const source = detectSourceFromUrl(rawUrl);
    const v = validateUrlForSource(source, rawUrl);
    if (!v.ok) {
      showToast(v.error, "error");
      return;
    }

    // Duplicate check (case-insensitive)
    const candidate = (v.normalizedUrl || "").toLowerCase();
    const isDuplicate = feeds.some((f) => (f.url || "").toLowerCase() === candidate);
    if (isDuplicate) {
      showToast("This feed URL has already been added.", "error");
      return;
    }

    try {
      await addDoc(collection(db, "users", user.uid, "feeds"), {
        company: cleanCompany,
        url: v.normalizedUrl,
        source,
        createdAt: serverTimestamp(),
        archivedAt: null,
        lastCheckedAt: null,
        lastError: null,
      });

      showToast(
        `${cleanCompany} (${prettySourceLabel(source)}) feed added successfully`,
        "success"
      );
      setCompany("");
      setUrl("");
    } catch (err) {
      console.error(err);
      showToast("Failed to add feed. Please try again.", "error");
    }
  }

  async function resetFeeds() {
    setBusyReset(true);
    try {
      const functions = getFunctions(undefined, "us-central1");
      const callFn = httpsCallable(functions, "resetFeedsV1");
      const res = await callFn({});
      showToast(res?.data?.message || "Feeds reset completed.", "success");
    } catch (e) {
      console.error(e);
      showToast(e?.message || "Reset failed.", "error");
    } finally {
      setBusyReset(false);
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
      console.error(err);
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
      console.error(err);
      showToast("Error restoring feed", "error");
    } finally {
      setBusyArchiveId(null);
    }
  }

  return (
    <div className="space-y-12 py-10" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      <div className="section-grid">
        <div>
          <h2 className="text-[10px] font-black uppercase tracking-widest text-gray-400">
            Job Board Sources
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Connect <span className="font-semibold">Greenhouse</span> and{" "}
            <span className="font-semibold">AshbyHQ</span> job boards.
          </p>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              onClick={resetFeeds}
              disabled={busyReset}
              className="btn-secondary w-full sm:w-auto uppercase tracking-widest text-[11px] font-black"
            >
              {busyReset ? "Resetting..." : "Reset feeds (remove old fields)"}
            </button>
          </div>

          <p className="mt-3 text-[11px] text-gray-400">
            Reset keeps only: company, url, source, createdAt, archivedAt, lastCheckedAt, lastError.
          </p>
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
                  Job Board API Endpoint{" "}
                  <span className="ml-2 text-[10px] font-black tracking-widest text-gray-300">
                    (Detected: {prettySourceLabel(detectedSource)})
                  </span>
                </label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="input-standard mt-2"
                  placeholder={
                    detectedSource === "ashby"
                      ? URL_RULES.ashby.placeholder
                      : URL_RULES.greenhouse.placeholder
                  }
                />
                <p className="mt-2 text-[11px] text-gray-400">
                  Greenhouse:{" "}
                  <span className="font-mono">
                    https://boards-api.greenhouse.io/v1/boards/&lt;company&gt;/jobs
                  </span>
                  <br />
                  AshbyHQ:{" "}
                  <span className="font-mono">
                    https://api.ashbyhq.com/posting-api/job-board/&lt;company&gt;
                  </span>
                </p>
              </div>
            </div>

            <button
              type="submit"
              className="btn-primary uppercase tracking-widest text-[11px] font-black"
            >
              Add Feed
            </button>
          </form>
        </div>
      </div>

      <div className="mx-auto max-w-3xl space-y-10">
        <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b bg-indigo-50/60 border-indigo-100 flex items-center justify-between">
            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-indigo-900">
                Active Feeds{" "}
                <span className="ml-1 text-indigo-700">({activeFeeds.length})</span>
              </h3>
              <p className="text-[11px] text-indigo-700 mt-1">
                These feeds are enabled (archivedAt is null).
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
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900">
                      {feed.company || "Company"}
                    </p>
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-widest bg-gray-100 text-gray-600">
                      {prettySourceLabel(feed.source || detectSourceFromUrl(feed.url))}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-gray-500 font-mono">{feed.url}</p>
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

        <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b bg-gray-50/80 border-gray-200 flex items-center justify-between">
            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-gray-600">
                Archived Feeds{" "}
                <span className="ml-1 text-gray-400">({archivedFeeds.length})</span>
              </h3>
              <p className="text-[11px] text-gray-500 mt-1">
                Archived feeds are not used (archivedAt is set).
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
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900">
                      {feed.company || "Company"}
                    </p>
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-widest bg-gray-100 text-gray-600">
                      {prettySourceLabel(feed.source || detectSourceFromUrl(feed.url))}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-gray-500 font-mono">{feed.url}</p>
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
