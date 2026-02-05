// src/pages/Jobs.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
} from "firebase/firestore";
import { db } from "../firebase";

const PAGE_SIZE = 100;

// --- US states list for dropdown search ---
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
  if (byName) return byName.code;
  return "";
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

function OptionsDropdown({ buttonLabel = "Options", children }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    function onDocClick(e) { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); }
    function onEsc(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onEsc); };
  }, []);
  return (
    <div ref={rootRef} className="relative inline-block">
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex w-full justify-center gap-x-1.5 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50 transition-all">
        {buttonLabel}
        <svg viewBox="0 0 20 20" fill="currentColor" className="-mr-1 size-5 text-gray-400">
          <path d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" fillRule="evenodd" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 origin-top-right rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
          <div className="py-2">{children}</div>
        </div>
      )}
    </div>
  );
}

export default function Jobs({ user, userMeta }) {
  const profileCountry = userMeta?.country || "United States";
  const [companies, setCompanies] = useState([]);
  const [selectedCompanyKey, setSelectedCompanyKey] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [locationSearch, setLocationSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [stateInput, setStateInput] = useState("");
  const [showRecentOnly, setShowRecentOnly] = useState(false); // New Filter State
  const observer = useRef(null);

  // 12 runs = 6 hours (based on 30m intervals)
  const RECENT_THRESHOLD_MS = 6 * 60 * 60 * 1000;

  useEffect(() => {
    const companiesRef = collection(db, "users", user.uid, "companies");
    const qCompanies = query(companiesRef, orderBy("lastSeenAt", "desc"), limit(50));
    return onSnapshot(qCompanies, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setCompanies(list);
      if (!selectedCompanyKey && list.length) setSelectedCompanyKey(list[0].id);
    });
  }, [user.uid]);

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

  const filteredJobs = useMemo(() => {
    const locTerms = locationSearch.trim().toLowerCase();
    const now = Date.now();

    return jobs.filter((j) => {
      // 1. Recent Only Filter (Past 12 Runs / 6 Hours)
      if (showRecentOnly) {
        const firstSeen = j.firstSeenAt?.toDate ? j.firstSeenAt.toDate().getTime() : 0;
        if (now - firstSeen > RECENT_THRESHOLD_MS) return false;
      }

      const location = (j.locationName || j.raw?.location?.name || "").trim();
      
      // 2. Location Search
      if (locTerms && !location.toLowerCase().includes(locTerms)) return false;

      // 3. State Filter
      if (profileCountry === "United States" && stateFilter) {
        const re = new RegExp(`(?:^|[\\s,•|/()\\-])${stateFilter}(?=$|[\\s,•|/()\\-])`);
        if (!re.test(location)) return false;
      }
      return true;
    });
  }, [jobs, locationSearch, stateFilter, profileCountry, showRecentOnly]);

  const selectedCompany = useMemo(() => companies.find((c) => c.id === selectedCompanyKey) || null, [companies, selectedCompanyKey]);

  return (
    <div className="py-8" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      <div className="mb-6 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Opportunities</h1>
          <p className="text-sm text-gray-500 mt-1">
            {selectedCompany ? <>Company: <span className="font-semibold">{selectedCompany.companyName}</span></> : "Select a company"}
            <span className="text-gray-300"> • </span> {filteredJobs.length} roles found
          </p>
        </div>
      </div>

      <div className="space-y-4 mb-8">
        <div className="flex flex-wrap items-center gap-4 p-4 bg-white rounded-xl ring-1 ring-gray-200 shadow-sm">
          <div className="min-w-[240px] flex-1">
            <label className="caps-label mb-2 block">Company</label>
            <select value={selectedCompanyKey || ""} onChange={(e) => setSelectedCompanyKey(e.target.value)} className="input-standard !bg-gray-50 border-transparent focus:!bg-white">
              {companies.map((c) => <option key={c.id} value={c.id}>{c.companyName || c.id}</option>)}
            </select>
          </div>

          <div className="min-w-[240px] flex-1">
            <label className="caps-label mb-2 block">Location contains</label>
            <input placeholder="e.g. San Francisco" className="input-standard !bg-gray-50 border-transparent focus:!bg-white" value={locationSearch} onChange={(e) => setLocationSearch(e.target.value)} />
          </div>

          {/* New Toggle Filter Button */}
          <div className="pt-6">
            <button
              onClick={() => setShowRecentOnly(!showRecentOnly)}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all shadow-sm ring-1 ring-inset ${
                showRecentOnly 
                ? "bg-indigo-600 text-white ring-indigo-600 hover:bg-indigo-700" 
                : "bg-white text-gray-900 ring-gray-300 hover:bg-gray-50"
              }`}
            >
              <svg className={`size-4 ${showRecentOnly ? "text-indigo-200" : "text-gray-400"}`} fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
              {showRecentOnly ? "Latest (Past 12 Runs)" : "All History"}
            </button>
          </div>

          <div className="pt-6">
            <OptionsDropdown buttonLabel="Filters">
              <div className="px-4 py-2">
                <div className="text-xs font-bold uppercase tracking-widest text-gray-400">Regional Filters</div>
                <div className="mt-3">
                  <div className="text-sm font-semibold text-gray-900">US State</div>
                  <input list="us-states" value={stateInput} onChange={(e) => { setStateInput(e.target.value); const code = normalizeStateInputToCode(e.target.value); if(code || !e.target.value) setStateFilter(code); }} onBlur={() => { const code = normalizeStateInputToCode(stateInput); setStateFilter(code); setStateInput(stateCodeToLabel(code)); }} placeholder="e.g. CA" className="input-standard mt-2 !bg-gray-50" />
                  <datalist id="us-states">{US_STATES.map((s) => <option key={s.code} value={`${s.code} - ${s.name}`} />)}</datalist>
                </div>
                <button onClick={() => { setLocationSearch(""); setStateFilter(""); setShowRecentOnly(false); }} className="mt-4 w-full text-center text-sm font-semibold text-indigo-600 hover:text-indigo-700 pt-3 border-t border-gray-100">Clear All Filters</button>
              </div>
            </OptionsDropdown>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {showRecentOnly && (
            <span className="inline-flex items-center gap-2 rounded-full bg-amber-50 text-amber-700 px-3 py-1 text-xs font-semibold ring-1 ring-inset ring-amber-100 animate-in fade-in zoom-in duration-200">
              ⚡ Showing past 12 runs only
              <button onClick={() => setShowRecentOnly(false)} className="hover:text-amber-900">✕</button>
            </span>
          )}
          {stateFilter && (
            <span className="inline-flex items-center gap-2 rounded-full bg-indigo-50 text-indigo-700 px-3 py-1 text-xs font-semibold ring-1 ring-inset ring-indigo-100">
              State: {stateFilter}
              <button onClick={() => setStateFilter("")} className="hover:text-indigo-900">✕</button>
            </span>
          )}
        </div>
      </div>

      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden">
        <ul className="divide-y divide-gray-100">
          {filteredJobs.map((job, index) => (
            <li key={job.id} ref={index === filteredJobs.length - 1 ? lastElementRef : null} className="group px-6 py-5 hover:bg-gray-50/80 transition-all">
              <a href={job.absolute_url || "#"} target="_blank" rel="noreferrer" className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs font-bold text-indigo-600 uppercase tracking-tight">{selectedCompany?.companyName || "Company"}</span>
                    <span className="text-gray-300">|</span>
                    <span className="text-xs text-gray-500 font-medium truncate">{job.locationName || "Remote"}</span>
                  </div>
                  <h3 className="text-base font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors truncate">{job.title || "Untitled role"}</h3>
                  <div className="mt-1 text-xs text-gray-400">Fetched {timeAgoFromFirestore(job.firstSeenAt)}</div>
                </div>
                <div className="flex items-center gap-4 ml-4">
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] font-black text-gray-300 group-hover:text-indigo-200 uppercase tracking-tighter transition-colors">Updated</span>
                    <span className="text-sm font-bold text-gray-900">{shortAgoFromISO(job.updatedAtIso)}</span>
                  </div>
                  <div className="h-8 w-8 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-all">→</div>
                </div>
              </a>
            </li>
          ))}
        </ul>
        {loading && <div className="p-8 text-center text-xs text-gray-400 animate-pulse uppercase tracking-widest">Loading...</div>}
        {!loading && !filteredJobs.length && <div className="p-10 text-center text-sm text-gray-500">No jobs match your filters.</div>}
      </div>
    </div>
  );
}