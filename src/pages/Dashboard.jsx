import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  limit,
  getDoc,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { motion, AnimatePresence } from "framer-motion";
import { db } from "../firebase";
import Card from "../components/Card.jsx";

export default function Dashboard({ user }) {
  const [url, setUrl] = useState("");
  const [feeds, setFeeds] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [userMeta, setUserMeta] = useState(null);
  const [busyNow, setBusyNow] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const feedsRef = collection(db, "users", user.uid, "feeds");
    const qFeeds = query(feedsRef, orderBy("createdAt", "desc"));
    const unsubFeeds = onSnapshot(qFeeds, (snap) => {
      setFeeds(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });

    const jobsRef = collection(db, "users", user.uid, "jobs");
    const qJobs = query(jobsRef, orderBy("firstSeenAt", "desc"), limit(100));
    const unsubJobs = onSnapshot(qJobs, (snap) => {
      setJobs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });

    // listen for user doc metadata (lastFetchAt etc)
    const userRef = doc(db, "users", user.uid);
    const unsubUser = onSnapshot(userRef, (snap) => {
      setUserMeta(snap.exists() ? snap.data() : null);
    });

    return () => {
      unsubFeeds();
      unsubJobs();
      unsubUser();
    };
  }, [user.uid]);

  const hint = useMemo(() => {
    const u = url.trim();
    if (!u) return "https://...";
    return u.length > 68 ? u.slice(0, 68) + "…" : u;
  }, [url]);

  async function addFeed(e) {
    e.preventDefault();
    const u = url.trim();
    if (!u) return;

    if (!/^https:\/\/.+/i.test(u)) {
      alert("Please use an https:// URL");
      return;
    }

    await addDoc(collection(db, "users", user.uid, "feeds"), {
      url: u,
      createdAt: serverTimestamp(),
      lastCheckedAt: null,
      lastError: null,
    });

    setUrl("");
  }

  async function removeFeed(id) {
    await deleteDoc(doc(db, "users", user.uid, "feeds", id));
  }

  // Manual trigger: calls the cloud function pollNow
  async function fetchNow() {
    setBusyNow(true);
    try {
      const functions = getFunctions(); // uses default app
      const callFn = httpsCallable(functions, "pollNow");

      const resp = await callFn({});
      const data = resp.data || {};
      const newCount = data.newCount ?? 0;
      const feedsCount = data.feeds ?? 0;

      setToast({ text: `Fetched ${feedsCount} feed(s). ${newCount} new job(s).` });
      setTimeout(() => setToast(null), 6000);
    } catch (err) {
      console.error("Manual fetch error", err);
      setToast({ text: "Fetch failed: " + (err?.message || err), error: true });
      setTimeout(() => setToast(null), 8000);
    } finally {
      setBusyNow(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Your Profile</h1>
          <div className="text-xs text-zinc-500">
            Last fetched:{" "}
            {userMeta?.lastFetchAt?.toDate ? userMeta.lastFetchAt.toDate().toLocaleString() : "Never"}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchNow}
            disabled={busyNow}
            className="px-3 py-2 rounded-xl bg-zinc-100 text-black font-medium hover:bg-white transition disabled:opacity-50"
          >
            {busyNow ? "Fetching…" : "Fetch now"}
          </button>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <Header
            title="Profile links"
            subtitle="Add all your Greenhouse job feed links. They’ll show here after saving."
          />

          <form onSubmit={addFeed} className="mt-5 flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://boards-api.greenhouse.io/v1/boards/…/jobs?content=true"
              className="flex-1 px-3 py-2 rounded-xl bg-black border border-zinc-800 focus:outline-none focus:border-zinc-600 transition"
            />
            <button className="px-4 py-2 rounded-xl bg-zinc-100 text-black font-medium hover:bg-white transition">
              Add
            </button>
          </form>

          <div className="mt-2 text-xs text-zinc-600">Preview: {hint}</div>

          <div className="mt-6 space-y-2">
            <AnimatePresence>
              {feeds.map((f) => (
                <motion.div
                  key={f.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-900"
                >
                  <div className="min-w-0">
                    <div className="text-sm truncate">{f.url}</div>
                    <div className="text-xs text-zinc-600">
                      {f.lastCheckedAt?.toDate
                        ? `Last checked: ${f.lastCheckedAt.toDate().toLocaleString()}`
                        : "Not checked yet"}
                      {f.lastError ? <span className="text-red-400"> • {f.lastError}</span> : null}
                    </div>
                  </div>
                  <button
                    onClick={() => removeFeed(f.id)}
                    className="text-sm text-zinc-400 hover:text-zinc-200 transition"
                  >
                    Remove
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>

            {!feeds.length ? <div className="text-sm text-zinc-500 mt-2">No links yet.</div> : null}
          </div>
        </Card>

        <Card>
          <Header
            title="New job openings"
            subtitle="Populated by the scheduled backend fetch (every 30 minutes), or by your manual Fetch now."
          />

          <div className="mt-5 space-y-2">
            <AnimatePresence>
              {jobs.map((j) => (
                <motion.a
                  key={j.id}
                  href={j.absolute_url || "#"}
                  target="_blank"
                  rel="noreferrer"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                  className="block px-3 py-3 rounded-xl bg-zinc-950 border border-zinc-900 hover:border-zinc-700 transition"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{j.title || "Untitled role"}</div>
                      <div className="text-xs text-zinc-500 truncate">
                        {(j.location && (j.location.name || j.location)) || "Location unknown"}
                        {" • "}
                        {j.source ? "feed" : "source"}
                      </div>
                    </div>
                    <span className="text-xs text-zinc-600 whitespace-nowrap">
                      {j.firstSeenAt?.toDate ? j.firstSeenAt.toDate().toLocaleDateString() : ""}
                    </span>
                  </div>
                </motion.a>
              ))}
            </AnimatePresence>

            {!jobs.length ? <div className="text-sm text-zinc-500 mt-2">No jobs stored yet.</div> : null}
          </div>
        </Card>
      </div>

      {/* toast */}
      <AnimatePresence>
        {toast ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className={`fixed right-6 bottom-6 z-40 px-4 py-3 rounded-lg shadow-lg ${
              toast.error ? "bg-red-700 text-white" : "bg-zinc-900 text-zinc-100"
            }`}
          >
            {toast.text}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Header({ title, subtitle }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-zinc-400 mt-1">{subtitle}</p>
    </div>
  );
}
