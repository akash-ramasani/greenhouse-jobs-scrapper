// src/pages/Jobs.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  collectionGroup,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx";

const PAGE_SIZE = 50;

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
  const { showToast } = useToast();

  const [companies, setCompanies] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [titleSearch, setTitleSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [stateInput, setStateInput] = useState("");
  const [timeframe, setTimeframe] = useState("all"); 
  const observer = useRef(null);

  useEffect(() => {
    const companiesRef = collection(db, "users", user.uid, "companies");
    const qCompanies = query(companiesRef, orderBy("lastSeenAt", "desc"), limit(100));
    return onSnapshot(qCompanies, (snap) => {
      setCompanies(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [user.uid]);

  const fetchJobs = useCallback(async (isFirstPage = true) => {
    if (loading) return;
    setLoading(true);

    try {
      const jobsQueryBase = collectionGroup(db, "jobs");
      let constraints = [
        where("uid", "==", user.uid),
        orderBy("updatedAtIso", "desc"),
        limit(PAGE_SIZE)
      ];

      if (selectedKeys.length > 0) {
        constraints.unshift(where("companyKey", "in", selectedKeys));
      }

      if (!isFirstPage && lastDoc) {
        constraints.push(startAfter(lastDoc));
      }

      const qJobs = query(jobsQueryBase, ...constraints);
      const snap = await getDocs(qJobs);
      const docs = snap.docs.map((d) => ({ 
        id: d.id, 
        ...d.data(), 
        _path: d.ref.path 
      }));

      setJobs(prev => isFirstPage ? docs : [...prev, ...docs]);
      setLastDoc(snap.docs[snap.docs.length - 1] || null);
      setHasMore(snap.docs.length === PAGE_SIZE);
    } catch (err) {
      console.error("Fetch jobs error:", err);
      showToast("Error loading jobs.", "error");
    } finally {
      setLoading(false);
    }
  }, [user.uid, selectedKeys, lastDoc, loading, showToast]);

  useEffect(() => {
    setLastDoc(null);
    setJobs([]);
    fetchJobs(true);
  }, [selectedKeys]);

  const lastElementRef = useCallback((node) => {
    if (loading || !hasMore) return;
    if (observer.current) observer.current.disconnect();

    observer.current = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loading) {
        fetchJobs(false);
      }
    }, { 
      rootMargin: '400px', 
      threshold: 0 
    });

    if (node) observer.current.observe(node);
  }, [loading, hasMore, fetchJobs]);

  const toggleCompany = (key) => {
    setSelectedKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const toggleBookmark = async (e, job) => {
    e.preventDefault();
    const newState = !job.saved;
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, saved: newState } : j));
    try {
      await updateDoc(doc(db, job._path), { saved: newState });
      showToast(newState ? "Job pinned" : "Pin removed", "info");
    } catch (err) {
      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, saved: !newState } : j));
      showToast("Error updating bookmark", "error");
    }
  };

  const filteredJobs = useMemo(() => {
    const titleTerm = titleSearch.trim().toLowerCase();
    const now = Date.now();
    
    return jobs.filter((j) => {
      if (timeframe !== "all") {
        const hoursMap = { '24h': 24, '12h': 12, '6h': 6, '1h': 1 };
        const thresholdMs = hoursMap[timeframe] * 60 * 60 * 1000;
        const firstSeen = j.firstSeenAt?.toDate ? j.firstSeenAt.toDate().getTime() : 0;
        if (now - firstSeen > thresholdMs) return false;
      }

      if (titleTerm && !j.title?.toLowerCase().includes(titleTerm)) return false;

      if (stateFilter) {
        const location = (j.locationName || "").trim().toUpperCase();
        const stateRegex = new RegExp(`(?:^|[^A-Z])${stateFilter}(?:$|[^A-Z])`);
        if (!stateRegex.test(location)) return false;
      }

      return true;
    });
  }, [jobs, titleSearch, stateFilter, timeframe]);

  const { bookmarkedJobs, regularJobs } = useMemo(() => {
    const showPinnedSeparately = selectedKeys.length === 0 && timeframe === "all";

    if (showPinnedSeparately) {
      return {
        bookmarkedJobs: filteredJobs.filter(j => j.saved),
        regularJobs: filteredJobs.filter(j => !j.saved)
      };
    } else {
      return {
        bookmarkedJobs: [],
        regularJobs: filteredJobs
      };
    }
  }, [filteredJobs, selectedKeys, timeframe]);

  const renderJobItem = (job) => (
    <li key={job.id} className="group relative px-6 py-5 hover:bg-gray-50/80 transition-all border-l-4 border-transparent hover:border-indigo-500">
      <div className="absolute top-0 left-0 right-0 h-[1px] bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="flex items-center justify-between">
        <a href={job.absolute_url || "#"} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs font-bold text-indigo-600 uppercase tracking-tight">{job.companyName}</span>
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
        <div className="text-center md:text-left">
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Opportunities</h1>
          <p className="text-sm text-gray-500 mt-1">{selectedKeys.length === 0 ? "Viewing all companies" : `Filtering ${selectedKeys.length} source(s)`}</p>
        </div>
        
        {/* Centered Horizontal Timeframe Toggle */}
        <div className="flex justify-center w-full md:w-auto overflow-hidden">
          <div className="inline-flex p-1 bg-gray-100 rounded-xl overflow-x-auto no-scrollbar scroll-smooth">
            {['all', '24h', '12h', '6h', '1h'].map((id) => (
              <button 
                key={id} 
                onClick={() => setTimeframe(id)} 
                className={`px-4 py-1.5 text-[11px] font-bold rounded-lg transition-all whitespace-nowrap min-w-fit ${
                  timeframe === id ? "bg-white text-indigo-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {id === 'all' ? 'All Jobs' : `Last ${id}`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-6 mb-8">
        <div className="flex flex-wrap items-center gap-4 p-4 bg-white rounded-xl ring-1 ring-gray-200 shadow-sm">
          <div className="min-w-[240px] flex-1">
            <label className="caps-label mb-2 block px-1">Job Title Search</label>
            <input placeholder="e.g. Software Engineer" className="input-standard !bg-gray-50 border-transparent focus:!bg-white" value={titleSearch} onChange={(e) => setTitleSearch(e.target.value)} />
          </div>
          <div className="w-full sm:w-auto">
             <label className="caps-label mb-2 block px-1">US State Filter</label>
             <input list="us-states" value={stateInput} onChange={(e) => { setStateInput(e.target.value); const code = normalizeStateInputToCode(e.target.value); if(code || !e.target.value) setStateFilter(code); }} onBlur={() => { const code = normalizeStateInputToCode(stateInput); setStateFilter(code); setStateInput(stateCodeToLabel(code)); }} placeholder="Type State..." className="input-standard !bg-gray-50 border-transparent focus:!bg-white" />
             <datalist id="us-states">{US_STATES.map((s) => <option key={s.code} value={`${s.code} - ${s.name}`} />)}</datalist>
          </div>
          <div className="pt-6">
            <button onClick={() => { setTitleSearch(""); setStateFilter(""); setTimeframe("all"); setSelectedKeys([]); setStateInput(""); }} className="text-xs font-bold text-gray-400 hover:text-indigo-600 px-2">Reset All</button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button onClick={() => setSelectedKeys([])} className={`px-4 py-2 rounded-full text-xs font-bold border transition-all ${selectedKeys.length === 0 ? "bg-indigo-600 text-white" : "bg-white text-gray-500"}`}>All Companies</button>
          {companies.map((c) => (
            <button key={c.id} onClick={() => toggleCompany(c.id)} className={`px-4 py-2 rounded-full text-xs font-bold border transition-all ${selectedKeys.includes(c.id) ? "bg-indigo-600 text-white" : "bg-white text-gray-500"}`}>{c.companyName}</button>
          ))}
        </div>
      </div>

      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden pb-4">
        {bookmarkedJobs.length > 0 && (
          <>
            <div className="bg-amber-50/40 px-6 py-3 border-b border-amber-100/50 flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-amber-700">📌 Pinned for Review</span>
            </div>
            <ul className="divide-y divide-gray-100">{bookmarkedJobs.map((job) => renderJobItem(job))}</ul>
            <div className="relative py-4 bg-white flex items-center px-6">
              <div className="flex-grow border-t border-dashed border-gray-200"></div>
              <span className="flex-shrink mx-4 text-[10px] font-black text-gray-300 uppercase tracking-widest">Recent Postings</span>
              <div className="flex-grow border-t border-dashed border-gray-200"></div>
            </div>
          </>
        )}
        
        <ul className="divide-y divide-gray-100">
          {regularJobs.map((job) => renderJobItem(job))}
        </ul>

        <div ref={lastElementRef} className="h-10 w-full flex items-center justify-center">
            {loading && hasMore && (
                <span className="text-[10px] font-black text-gray-300 uppercase tracking-widest animate-pulse">Scanning...</span>
            )}
        </div>
        
        {!loading && filteredJobs.length === 0 && (
          <div className="p-10 text-center text-sm text-gray-500 italic">No roles found matching these filters.</div>
        )}
        
        {!hasMore && filteredJobs.length > 0 && (
          <div className="p-4 text-center border-t border-gray-50 mt-4">
             <span className="text-[10px] font-black text-gray-200 uppercase tracking-widest">End of Feed</span>
          </div>
        )}
      </div>
    </div>
  );
}