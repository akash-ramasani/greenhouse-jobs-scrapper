import React, { useEffect, useState } from "react";
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db } from "../firebase";

export default function Home({ user }) {
  const [company, setCompany] = useState("");
  const [url, setUrl] = useState("");
  const [feeds, setFeeds] = useState([]);
  const [busyNow, setBusyNow] = useState(false);

  useEffect(() => {
    const feedsRef = collection(db, "users", user.uid, "feeds");
    const qFeeds = query(feedsRef, orderBy("createdAt", "desc"));
    return onSnapshot(qFeeds, (snap) => setFeeds(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, [user.uid]);

  async function addFeed(e) {
    e.preventDefault();
    if (!company.trim() || !url.trim()) return;
    await addDoc(collection(db, "users", user.uid, "feeds"), {
      company, url, createdAt: serverTimestamp(),
    });
    setCompany(""); setUrl("");
  }

  return (
    <div className="space-y-12 py-10">
      <div className="section-grid">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Job Board Sources</h2>
          <p className="mt-1 text-sm text-gray-600">
            Connect Greenhouse job boards. Our system will automatically monitor these for new opportunities.
          </p>
          <div className="mt-6">
            <button className="btn-secondary w-full sm:w-auto">
              Check for new jobs now
            </button>
          </div>
        </div>

        <div className="md:col-span-2 space-y-10">
          <form onSubmit={addFeed} className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-6">
            <div className="sm:col-span-4">
              <label className="block text-sm font-medium text-gray-900">Company Name</label>
              <div className="mt-2">
                <input 
                  value={company} 
                  onChange={e => setCompany(e.target.value)} 
                  className="input-standard" 
                  placeholder="e.g. OpenAI"
                />
              </div>
            </div>

            <div className="sm:col-span-2 flex items-end">
              <button type="submit" className="btn-primary w-full">Add Feed</button>
            </div>

            <div className="col-span-full">
              <label className="block text-sm font-medium text-gray-900">Greenhouse API Endpoint</label>
              <div className="mt-2">
                <input 
                  value={url} 
                  onChange={e => setUrl(e.target.value)} 
                  className="input-standard" 
                  placeholder="https://boards-api.greenhouse.io/v1/..."
                />
              </div>
            </div>
          </form>

          <div className="overflow-hidden bg-white shadow-sm ring-1 ring-gray-200 sm:rounded-xl">
            <ul className="divide-y divide-gray-100">
              {feeds.map((feed) => (
                <li key={feed.id} className="flex items-center justify-between gap-x-6 px-4 py-5 sm:px-6 hover:bg-gray-50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{feed.company}</p>
                    <p className="mt-1 truncate text-xs text-gray-500 font-mono">{feed.url}</p>
                  </div>
                  <button 
                    onClick={() => deleteDoc(doc(db, "users", user.uid, "feeds", feed.id))}
                    className="text-xs font-bold uppercase tracking-wider text-red-600 hover:text-red-800"
                  >
                    Remove
                  </button>
                </li>
              ))}
              {feeds.length === 0 && (
                <li className="px-4 py-12 text-center text-sm text-gray-500">
                  No active feeds found. Add one above to start monitoring.
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}