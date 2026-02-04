import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { 
  collection, onSnapshot, orderBy, query, 
  limit, startAfter, getDocs 
} from "firebase/firestore";
import { db } from "../firebase";

export default function Jobs({ user, search: globalSearch }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [lastDoc, setLastDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  
  const [locationSearch, setLocationSearch] = useState("");
  const [selectedCompany, setSelectedCompany] = useState(null);
  
  const observer = useRef();

  // Visual Refinement: Professional Date Formatting
  const formatTimeLabel = (timestamp) => {
    if (!timestamp) return "Recent";
    const date = new Date(timestamp);
    const diff = new Date() - date;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    return "Now";
  };

  useEffect(() => {
    setLoading(true);
    const jobsRef = collection(db, "users", user.uid, "jobs");
    
    // Sort logic targeting the nested Greenhouse 'updated_at'
    const q = query(
      jobsRef, 
      orderBy("raw.updated_at", "desc"), 
      limit(25)
    );

    const unsub = onSnapshot(q, (snap) => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setJobs(docs);
      setLastDoc(snap.docs[snap.docs.length - 1]);
      setHasMore(snap.docs.length === 25);
      setLoading(false);
    }, (err) => {
      console.error("Firestore Index Required:", err);
      setLoading(false);
    });

    return () => unsub();
  }, [user.uid]);

  // Logic Fix: Aggregating unique companies from raw data
  const companies = useMemo(() => {
    const set = new Set();
    jobs.forEach(j => {
      if (j.raw?.company_name) set.add(j.raw.company_name);
    });
    return Array.from(set).sort();
  }, [jobs]);

  // Search Logic Fix: Ensuring it checks both j.title and j.raw.company_name
  const filteredJobs = useMemo(() => {
    return jobs.filter(j => {
      const company = j.raw?.company_name || "";
      const title = j.title || j.raw?.title || "";
      const location = j.location?.name || j.raw?.location?.name || "";
      
      const searchTerms = (globalSearch || "").toLowerCase();
      const locTerms = locationSearch.toLowerCase();

      const matchesGlobal = title.toLowerCase().includes(searchTerms) || 
                            company.toLowerCase().includes(searchTerms);
      const matchesLocation = location.toLowerCase().includes(locTerms);
      const matchesCompanyPill = !selectedCompany || company === selectedCompany;

      return matchesGlobal && matchesLocation && matchesCompanyPill;
    });
  }, [jobs, globalSearch, locationSearch, selectedCompany]);

  // Infinite Scroll Logic
  const fetchMore = async () => {
    if (!lastDoc || loading) return;
    setLoading(true);
    const jobsRef = collection(db, "users", user.uid, "jobs");
    const nextQ = query(jobsRef, orderBy("raw.updated_at", "desc"), startAfter(lastDoc), limit(25));
    const snap = await getDocs(nextQ);
    const nextJobs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    setJobs(prev => [...prev, ...nextJobs]);
    setLastDoc(snap.docs[snap.docs.length - 1]);
    setHasMore(snap.docs.length === 25);
    setLoading(false);
  };

  const lastElementRef = useCallback(node => {
    if (loading) return;
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore) fetchMore();
    });
    if (node) observer.current.observe(node);
  }, [loading, hasMore, lastDoc]);

  return (
    <div className="py-8" style={{ fontFamily: 'Ubuntu, sans-serif' }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Opportunities</h1>
        <p className="text-sm text-gray-500 mt-1">{filteredJobs.length} roles found</p>
      </div>

      {/* Filters */}
      <div className="space-y-4 mb-8">
        <div className="flex flex-wrap gap-4 p-4 bg-white rounded-xl ring-1 ring-gray-200 shadow-sm">
          <div className="flex-[2] min-w-[240px]">
            <input 
              placeholder="Search by role or company..."
              className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
              value={globalSearch} 
              readOnly
            />
          </div>
          <div className="flex-1 min-w-[200px]">
            <input 
              placeholder="Location..."
              className="input-standard !bg-gray-50 border-transparent focus:!bg-white"
              value={locationSearch}
              onChange={(e) => setLocationSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Horizontal Company List (No Scrollbar) */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-2">
          {companies.map(c => {
            const isSelected = selectedCompany === c;
            return (
              <button
                key={c}
                onClick={() => setSelectedCompany(isSelected ? null : c)}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-all ${
                  isSelected 
                  ? "bg-indigo-600 border-indigo-600 text-white shadow-sm" 
                  : "bg-white border-gray-200 text-gray-600 hover:border-indigo-400"
                }`}
              >
                {c}
                {isSelected && <span className="text-[10px] opacity-80">✕</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Job List */}
      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden">
        <ul className="divide-y divide-gray-100">
          {filteredJobs.map((job, index) => (
            <li 
              key={job.id} 
              ref={index === filteredJobs.length - 1 ? lastElementRef : null}
              className="group px-6 py-5 hover:bg-gray-50/80 transition-all"
            >
              <a href={job.absolute_url} target="_blank" rel="noreferrer" className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs font-bold text-indigo-600 uppercase tracking-tight">
                      {job.raw?.company_name || "Company"}
                    </span>
                    <span className="text-gray-300">|</span>
                    <span className="text-xs text-gray-500 font-medium">
                      {job.location?.name || job.raw?.location?.name || "Remote"}
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors truncate">
                    {job.title || job.raw?.title}
                  </h3>
                </div>
                <div className="flex items-center gap-4 ml-4">
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] font-black text-gray-300 group-hover:text-indigo-200 uppercase tracking-tighter transition-colors">
                      Updated
                    </span>
                    <span className="text-sm font-bold text-gray-900">
                      {formatTimeLabel(job.raw?.updated_at)}
                    </span>
                  </div>
                  <div className="h-8 w-8 rounded-full bg-gray-50 flex items-center justify-center text-gray-400 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-all">
                    →
                  </div>
                </div>
              </a>
            </li>
          ))}
        </ul>
        {loading && <div className="p-8 text-center text-xs text-gray-400 animate-pulse uppercase tracking-widest">Loading...</div>}
      </div>
    </div>
  );
}