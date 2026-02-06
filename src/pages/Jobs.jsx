// src/pages/Jobs.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  updateDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx";

const PAGE_SIZE = 100;

// --- Helper Data & Formatters ---
const US_STATES = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" }, { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" }, { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" }, { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" }, { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" }, { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" }, { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" }, { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" }, { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" }, { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" }, { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" }, { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" }, { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" }, { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" }, { code: "DC", name: "District of Columbia" },
];

function normalizeStateInputToCode(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();
  const byCode = US_STATES.find((s) => s.code === upper);
  if (byCode) return byCode.code;
  const lower = raw.toLowerCase();
  const byName = US_STATES.find((s) => s.name.toLowerCase() === lower);
  return byName ? byName.code : "";
}

function stateCodeToLabel(code) {
  const st = US_STATES.find((s) => s.code === code);
  return st ? `${st.code} - ${st.name}` : code || "";
}

function timeAgoFromFirestore(ts) {
  if (!ts?.toDate) return "";
  const d = ts.toDate();
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

function shortAgoFromISO(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (mins > 0) return `${mins}m`;
  return "Now";
}

export default function Jobs({ user, userMeta }) {
  const profileCountry = userMeta?.country || "United States";
  const { showToast } = useToast();

  const [companies, setCompanies] = useState([]);
  const [selectedCompanyKey, setSelectedCompanyKey] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [locationSearch, setLocationSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [stateInput, setStateInput] = useState("");
  const [timeframe, setTimeframe] = useState("all"); 
  const observer = useRef(null);

  // 1. Load companies and auto-select the first one
  useEffect(() => {
    const companiesRef = collection(db, "users", user.uid, "companies");
    const qCompanies = query(companiesRef, orderBy("lastSeenAt", "desc"), limit(50));
    return onSnapshot(qCompanies, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setCompanies(list);
      if (!selectedCompanyKey && list.length) {
        setSelectedCompanyKey(list[0].id);
      }
    });
  }, [user.uid]);

  // 2. Fetch jobs for the selected company
  useEffect(() => {
    if (!selectedCompanyKey) return;
    setLoading(true); setJobs([]); setLastDoc(null); setHasMore(true);
    const jobsRef = collection(db, "users", user.uid, "companies", selectedCompanyKey, "jobs");
    const qJobs = query(jobsRef, orderBy("updatedAtIso", "desc"), limit(PAGE_SIZE));
    return onSnapshot(qJobs, (snap) => {
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setJobs(docs);
      setLastDoc(snap.docs[snap.docs.length - 1] || null);
      setHasMore(snap.docs.length === PAGE_SIZE);
      setLoading(false);
    }, () => setLoading(false));
  }, [user.uid, selectedCompanyKey]);

  // Infinite Scroll logic
  const fetchMore = async () => {
    if (!selectedCompanyKey || !lastDoc || loading) return;
    setLoading(true);
    try {
      const jobsRef = collection(db, "users", user.uid, "companies", selectedCompanyKey, "jobs");
      const nextQ = query(jobsRef, orderBy("updatedAtIso", "desc"), startAfter(lastDoc), limit(PAGE_SIZE));
      const snap = await getDocs(nextQ);
      const nextJobs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setJobs((prev) => [...prev, ...nextJobs]);
      setLastDoc(snap.docs[snap.docs.length - 1] || null);
      setHasMore(snap.docs.length === PAGE_SIZE);
    } finally { setLoading(false); }
  };

  const lastElementRef = useCallback((node) => {
    if (loading) return;
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore) fetchMore();
    });
    if (node) observer.current.observe(node);
  }, [loading, hasMore, lastDoc]);

  const toggleBookmark = async (e, job) => {
    e.preventDefault();
    const jobRef = doc(db, "users", user.uid, "companies", selectedCompanyKey, "jobs", job.id);
    try {
      const newState = !job.saved;
      await updateDoc(jobRef, { saved: newState });
      showToast(newState ? "Job pinned" : "Pin removed", "info");
    } catch (err) {
      showToast("Error updating bookmark", "error");
    }
  };

  const { bookmarkedJobs, regularJobs } = useMemo(() => {
    const locTerms = locationSearch.trim().toLowerCase();
    const now = Date.now();
    const filtered = jobs.filter((j) => {
      if (timeframe !== "all") {
        let hours = timeframe === "12h" ? 12 : timeframe === "6h" ? 6 : 24;
        const thresholdMs = hours * 60 * 60 * 1000;
        const firstSeen = j.firstSeenAt?.toDate ? j.firstSeenAt.toDate().getTime() : 0;
        if (now - firstSeen > thresholdMs) return false;
      }
      const location = (j.locationName || j.raw?.location?.name || "").trim();
      if (locTerms && !location.toLowerCase().includes(locTerms)) return false;
      if (profileCountry === "United States" && stateFilter) {
        const re = new RegExp(`(?:^|[\\s,•|/()\\-])${stateFilter}(?=$|[\\s,•|/()\\-])`);
        if (!re.test(location)) return false;
      }
      return true;
    });
    return { bookmarkedJobs: filtered.filter(j => j.saved), regularJobs: filtered.filter(j => !j.saved) };
  }, [jobs, locationSearch, stateFilter, profileCountry, timeframe]);

  const selectedCompany = useMemo(() => companies.find((c) => c.id === selectedCompanyKey) || null, [companies, selectedCompanyKey]);

  const renderJobItem = (job, ref = null) => (
    <li key={job.id} ref={ref} className="group relative px-6 py-5 hover:bg-gray-50/80 transition-all border-l-4 border-transparent hover:border-indigo-500">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="flex items-center justify-between">
        <a href={job.absolute_url || "#"} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs font-bold text-indigo-600 uppercase tracking-tight">
              {selectedCompany?.companyName || job.companyName || "Company"}
            </span>
            <span className="text-gray-300">|</span>
            <span className="text-xs text-gray-500 font-medium truncate">{job.locationName || "Remote"}</span>
          </div>
          <h3 className="text-base font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors truncate">{job.title}</h3>
          <div className="mt-1 text-xs text-gray-400">Fetched {timeAgoFromFirestore(job.firstSeenAt)}</div>
        </a>
        <div className="flex items-center gap-4 ml-4">
          <button onClick={(e) => toggleBookmark(e, job)} className={`p-2 rounded-full transition-colors ${job.saved ? 'text-amber-500 bg-amber-50' : 'text-gray-300 hover:bg-gray-100 hover:text-gray-500'}`}>
            <svg className="size-5" fill={job.saved ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
          </button>
          <div className="hidden sm:flex flex-col items-end">
            <span className="text-[10px] font-black text-gray-300 group-hover:text-indigo-200 uppercase tracking-tighter transition-colors">Updated</span>
            <span className="text-sm font-bold text-gray-900">{shortAgoFromISO(job.updatedAtIso)}</span>
          </div>
        </div>
      </div>
    </li>
  );

  return (
    <div className="py-8" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Opportunities</h1>
          <p className="text-sm text-gray-500 mt-1">
            {selectedCompany ? <>Filtering: <span className="font-semibold text-indigo-600">{selectedCompany.companyName}</span></> : "Select a source below"}
          </p>
        </div>

        {/* --- Segmented Timeframe Toggle --- */}
        <div className="inline-flex p-1 bg-gray-100 rounded-xl overflow-x-auto max-w-full">
          {[
            { id: 'all', label: 'All Jobs' }, 
            { id: '24h', label: 'Last 24h' }, 
            { id: '12h', label: 'Last 12h' }, 
            { id: '6h', label: 'Last 6h' }
          ].map((option) => (
            <button 
              key={option.id} 
              onClick={() => setTimeframe(option.id)} 
              className={`px-4 py-1.5 text-[11px] font-bold rounded-lg transition-all whitespace-nowrap ${timeframe === option.id ? "bg-white text-indigo-600 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-6 mb-8">
        <div className="flex flex-wrap items-center gap-4 p-4 bg-white rounded-xl ring-1 ring-gray-200 shadow-sm">
          <div className="min-w-[240px] flex-1">
            <label className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-2 block px-1">Location Search</label>
            <input placeholder="e.g. San Francisco or Remote" className="input-standard !bg-gray-50 border-transparent focus:!bg-white" value={locationSearch} onChange={(e) => setLocationSearch(e.target.value)} />
          </div>

          <div className="w-full sm:w-auto">
             <label className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-2 block px-1">US State Filter</label>
             <input list="us-states" value={stateInput} onChange={(e) => { setStateInput(e.target.value); const code = normalizeStateInputToCode(e.target.value); if(code || !e.target.value) setStateFilter(code); }} onBlur={() => { const code = normalizeStateInputToCode(stateInput); setStateFilter(code); setStateInput(stateCodeToLabel(code)); }} placeholder="Type State..." className="input-standard !bg-gray-50 border-transparent focus:!bg-white" />
             <datalist id="us-states">{US_STATES.map((s) => <option key={s.code} value={`${s.code} - ${s.name}`} />)}</datalist>
          </div>
          
          <div className="pt-6">
            <button onClick={() => { setLocationSearch(""); setStateFilter(""); setTimeframe("all"); }} className="text-xs font-bold text-gray-400 hover:text-indigo-600 transition-colors px-2">Reset</button>
          </div>
        </div>

        {/* Company Pills Section */}
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {companies.map((c) => {
              const isSelected = selectedCompanyKey === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => !isSelected && setSelectedCompanyKey(c.id)}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold transition-all border
                    ${isSelected 
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-100" 
                      : "bg-white border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50"
                    }`}
                >
                  {c.companyName || c.id}
                  {isSelected && (
                    <svg viewBox="0 0 20 20" fill="currentColor" className="size-3.5 opacity-80">
                      <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 1 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden">
        {bookmarkedJobs.length > 0 && (
          <>
            <div className="bg-amber-50/40 px-6 py-3 border-b border-amber-100/50 flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-amber-700">📌 Pinned for Review</span>
            </div>
            <ul className="divide-y divide-gray-100">
              {bookmarkedJobs.map((job) => renderJobItem(job))}
            </ul>
            <div className="relative py-4 bg-white flex items-center px-6">
              <div className="flex-grow border-t border-dashed border-gray-200"></div>
              <span className="flex-shrink mx-4 text-[10px] font-black text-gray-300 uppercase tracking-widest">Recent Postings</span>
              <div className="flex-grow border-t border-dashed border-gray-200"></div>
            </div>
          </>
        )}
        <ul className="divide-y divide-gray-100">
          {regularJobs.map((job, index) => renderJobItem(job, index === regularJobs.length - 1 ? lastElementRef : null))}
        </ul>
        {loading && <div className="p-8 text-center text-xs text-gray-400 animate-pulse">Scanning...</div>}
        {!loading && bookmarkedJobs.length === 0 && regularJobs.length === 0 && (
          <div className="p-10 text-center text-sm text-gray-500 italic">No roles found matching these filters.</div>
        )}
      </div>
    </div>
  );
}