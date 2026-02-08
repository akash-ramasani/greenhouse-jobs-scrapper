// src/pages/Jobs.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  collectionGroup,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  updateDoc,
  where,
  Timestamp,
} from "firebase/firestore";
import { AnimatePresence, motion } from "framer-motion";
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
  { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" }, { code: "DC", name: "DC" },
];

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

function timeframeToThresholdTs(timeframe) {
  if (timeframe === "all") return null;
  const hoursMap = { "24h": 24, "12h": 12, "6h": 6, "1h": 1 };
  const hours = hoursMap[timeframe];
  if (!hours) return null;
  const ms = hours * 60 * 60 * 1000;
  return Timestamp.fromDate(new Date(Date.now() - ms));
}

export default function Jobs({ user, userMeta }) {
  const { showToast } = useToast();

  const [companies, setCompanies] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(true);
  const [lastDoc, setLastDoc] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [titleSearch, setTitleSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [timeframe, setTimeframe] = useState("1h");
  const [isFilterExpanded, setIsFilterExpanded] = useState(false);
  const observer = useRef(null);

  // ✅ CHANGE: use getDocs instead of onSnapshot to avoid constant reads as backend updates companies
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const companiesRef = collection(db, "users", user.uid, "companies");
        const qCompanies = query(companiesRef, orderBy("lastSeenAt", "desc"), limit(200));
        const snap = await getDocs(qCompanies);
        if (!cancelled) {
          setCompanies(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        }
      } catch (e) {
        console.error("Load companies error:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [user.uid]);

  // ✅ CHANGE: apply timeframe in Firestore query using updatedAtTs
  // This stops infinite paging when timeframe filters out old jobs client-side.
  const fetchJobs = useCallback(async (isFirstPage = true) => {
    setLoading(true);
    setIsProcessing(true);

    try {
      const jobsQueryBase = collectionGroup(db, "jobs");

      const constraints = [];

      // always scoped to current user
      constraints.push(where("uid", "==", user.uid));

      // timeframe server-side
      const thresholdTs = timeframeToThresholdTs(timeframe);
      if (thresholdTs) {
        constraints.push(where("updatedAtTs", ">=", thresholdTs));
      }

      // company filter
      if (selectedKeys.length > 0) {
        // NOTE: Firestore "in" supports max 10 items
        constraints.push(where("companyKey", "in", selectedKeys.slice(0, 10)));
      }

      // order must match range field
      constraints.push(orderBy("updatedAtTs", "desc"));
      constraints.push(limit(PAGE_SIZE));

      if (!isFirstPage && lastDoc) {
        constraints.push(startAfter(lastDoc));
      }

      const qJobs = query(jobsQueryBase, ...constraints);
      const snap = await getDocs(qJobs);

      const docs = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
        _path: d.ref.path,
      }));

      setJobs((prev) => (isFirstPage ? docs : [...prev, ...docs]));
      setLastDoc(snap.docs[snap.docs.length - 1] || null);
      setHasMore(snap.docs.length === PAGE_SIZE);
    } catch (err) {
      console.error("Fetch jobs error:", err);
      showToast("Error loading jobs.", "error");
      setHasMore(false);
    } finally {
      setTimeout(() => {
        setLoading(false);
        setIsProcessing(false);
      }, 150);
    }
  }, [user.uid, selectedKeys, lastDoc, timeframe, showToast]);

  // ✅ CHANGE: when selectedKeys OR timeframe changes, reset paging and refetch first page
  useEffect(() => {
    setLastDoc(null);
    setJobs([]);
    setHasMore(true);
    fetchJobs(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKeys, timeframe]);

  const lastElementRef = useCallback((node) => {
    if (loading || !hasMore) return;
    if (observer.current) observer.current.disconnect();

    observer.current = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loading) {
        fetchJobs(false);
      }
    }, { rootMargin: "400px", threshold: 0 });

    if (node) observer.current.observe(node);
  }, [loading, hasMore, fetchJobs]);

  const toggleCompany = (key) => {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const toggleBookmark = async (e, job) => {
    e.preventDefault();
    const newState = !job.saved;

    setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, saved: newState } : j)));

    try {
      await updateDoc(doc(db, job._path), { saved: newState });
      showToast(newState ? "Job pinned" : "Pin removed", "info");
    } catch (err) {
      setJobs((prev) => prev.map((j) => (j.id === job.id ? { ...j, saved: !newState } : j)));
      showToast("Error updating bookmark", "error");
    }
  };

  // ✅ NOTE: timeframe filtering is now server-side; keep only title + state client-side
  const filteredJobs = useMemo(() => {
    const titleTerm = titleSearch.trim().toLowerCase();
    return jobs.filter((j) => {
      if (titleTerm && !j.title?.toLowerCase().includes(titleTerm)) return false;

      if (stateFilter) {
        const location = (j.locationName || "").trim().toUpperCase();
        const stateRegex = new RegExp(`(?:^|[^A-Z])${stateFilter}(?:$|[^A-Z])`);
        if (!stateRegex.test(location)) return false;
      }
      return true;
    });
  }, [jobs, titleSearch, stateFilter]);

  const { bookmarkedJobs, regularJobs } = useMemo(() => {
    const showPinnedSeparately = selectedKeys.length === 0 && timeframe === "all";
    if (showPinnedSeparately) {
      return {
        bookmarkedJobs: filteredJobs.filter((j) => j.saved),
        regularJobs: filteredJobs.filter((j) => !j.saved),
      };
    }
    return { bookmarkedJobs: [], regularJobs: filteredJobs };
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
          <h3 className="text-base font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors truncate">
            {job.title}
          </h3>
          <div className="mt-1 text-xs text-gray-400">Fetched {timeAgoFromFirestore(job.firstSeenAt)}</div>
        </a>

        <div className="flex items-center gap-4 ml-4">
          <button
            onClick={(e) => toggleBookmark(e, job)}
            className={`p-2 rounded-full transition-colors ${job.saved ? "text-amber-500 bg-amber-50" : "text-gray-300 hover:bg-gray-100 hover:text-gray-500"}`}
          >
            <svg className="size-5" fill={job.saved ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" />
            </svg>
          </button>

          <div className="hidden sm:flex flex-col items-end">
            <span className="text-[10px] font-black text-gray-300 group-hover:text-indigo-200 uppercase tracking-tighter transition-colors">Updated</span>
            <span className="text-sm font-bold text-gray-900">{shortAgoFromISO(job.updatedAtIso)}</span>
          </div>
        </div>
      </div>
    </li>
  );

  const renderSkeleton = () => (
    <div className="px-6 py-8 border-b border-gray-100 animate-pulse">
      <div className="h-3 w-24 bg-gray-200 rounded mb-3" />
      <div className="h-6 w-3/4 bg-gray-200 rounded mb-3" />
      <div className="h-3 w-40 bg-gray-100 rounded" />
    </div>
  );

  console.log("AUTH user.uid:", user.uid);
console.log("Firestore projectId:", db.app.options.projectId);
console.error("Fetch jobs error:", err);

  return (
    <div className="py-8 px-4 md:px-0 min-h-screen" style={{ fontFamily: "Ubuntu, sans-serif" }}>
      {/* HEADER */}
      <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4 text-center md:text-left">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Opportunities</h1>
          <p className="text-sm text-gray-500 mt-1">
            {selectedKeys.length === 0 ? "Viewing all companies" : `Filtering ${selectedKeys.length} source(s)`}
          </p>
        </div>

        <div className="flex justify-center w-full md:w-auto overflow-hidden">
          <div className="inline-flex p-1 bg-gray-100 rounded-xl overflow-x-auto no-scrollbar scroll-smooth">
            {["all", "24h", "12h", "6h", "1h"].map((id) => (
              <button
                key={id}
                onClick={() => setTimeframe(id)}
                className={`px-4 py-1.5 text-[11px] font-bold rounded-lg transition-all whitespace-nowrap min-w-fit ${timeframe === id ? "bg-white text-indigo-600 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
              >
                {id === "all" ? "All Jobs" : `Last ${id}`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* SEARCH + TOGGLE */}
      <div className="flex flex-wrap items-center gap-4 p-4 mb-6 bg-white rounded-xl ring-1 ring-gray-200 shadow-sm">
        <div className="min-w-[240px] flex-1 flex items-end gap-3 h-fit">
          <div className="flex-1">
            <label className="caps-label mb-2 block px-1 text-gray-400 uppercase tracking-widest text-[10px] font-black">
              Job Title Search
            </label>
            <input
              placeholder="e.g. Software Engineer"
              className="input-standard !bg-gray-50 border-transparent focus:!bg-white h-11 w-full"
              value={titleSearch}
              onChange={(e) => setTitleSearch(e.target.value)}
            />
          </div>

          <button
            onClick={() => setIsFilterExpanded(!isFilterExpanded)}
            className={`h-11 w-11 flex items-center justify-center rounded-xl border transition-all ${isFilterExpanded ? "bg-indigo-50 border-indigo-200 text-indigo-600 shadow-inner" : "bg-white border-gray-200 text-gray-400 hover:bg-gray-50"}`}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="size-5 transition-transform duration-300">
              <path d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 0 1 .628.74v2.288a2.25 2.25 0 0 1-.659 1.59l-4.682 4.683a2.25 2.25 0 0 0-.659 1.59v3.037c0 .684-.31 1.33-.844 1.757l-1.937 1.55A.75.75 0 0 1 8 18.25v-5.757a2.25 2.25 0 0 0-.659-1.591L2.659 6.22A2.25 2.25 0 0 1 2 4.629V2.34a.75.75 0 0 1 .628-.74Z" />
            </svg>
          </button>
        </div>

        <div className="pt-6">
          <button
            onClick={() => {
              setTitleSearch("");
              setStateFilter("");
              setTimeframe("1h");
              setSelectedKeys([]);
            }}
            className="text-xs font-bold text-gray-400 hover:text-indigo-600 px-2"
          >
            Reset All
          </button>
        </div>
      </div>

      {/* FILTER PANEL */}
      <AnimatePresence>
        {isFilterExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden mb-8"
          >
            <div className="space-y-8 py-4 px-1">
              {/* State */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 px-1">
                  <label className="caps-label text-gray-400 uppercase tracking-widest text-[10px] font-black">
                    Filter by State
                  </label>
                  <span className="bg-gray-100 text-gray-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                    {US_STATES.length}
                  </span>
                </div>

                <div className="flex w-full overflow-hidden">
                  <div className="inline-flex p-1 bg-gray-50 rounded-xl overflow-x-auto no-scrollbar scroll-smooth gap-1">
                    <button
                      onClick={() => setStateFilter("")}
                      className={`px-5 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${stateFilter === "" ? "bg-white text-indigo-600 shadow-sm ring-1 ring-gray-200" : "text-gray-500 hover:text-gray-700"}`}
                    >
                      All States
                    </button>
                    {US_STATES.map((s) => (
                      <button
                        key={s.code}
                        onClick={() => setStateFilter(s.code)}
                        className={`px-5 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${stateFilter === s.code ? "bg-indigo-600 text-white shadow-md shadow-indigo-100" : "bg-white text-gray-500 ring-1 ring-inset ring-gray-200 hover:bg-gray-50"}`}
                      >
                        {s.code} - {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Company */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 px-1">
                  <label className="caps-label text-gray-400 uppercase tracking-widest text-[10px] font-black">
                    Filter by Company
                  </label>
                  <span className="bg-gray-100 text-gray-500 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                    {companies.length}
                  </span>
                </div>

                <div className="flex w-full overflow-hidden">
                  <div className="inline-flex p-1 bg-gray-50 rounded-xl overflow-x-auto no-scrollbar scroll-smooth gap-1">
                    <button
                      onClick={() => setSelectedKeys([])}
                      className={`px-5 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${selectedKeys.length === 0 ? "bg-white text-indigo-600 shadow-sm ring-1 ring-gray-200" : "text-gray-500 hover:text-gray-700"}`}
                    >
                      All Companies
                    </button>

                    {companies.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => toggleCompany(c.id)}
                        className={`px-5 py-2.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${selectedKeys.includes(c.id) ? "bg-indigo-600 text-white shadow-md shadow-indigo-100" : "bg-white text-gray-500 ring-1 ring-inset ring-gray-200 hover:bg-gray-50"}`}
                      >
                        {c.companyName || c.id}
                      </button>
                    ))}
                  </div>
                </div>

                {selectedKeys.length > 10 && (
                  <div className="px-2 text-xs text-amber-600 font-semibold">
                    Firestore "in" filter supports max 10 companies at a time. Only first 10 are applied.
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* LIST */}
      <div className="bg-white shadow-sm ring-1 ring-gray-200 rounded-2xl overflow-hidden flex flex-col min-h-[500px] transition-all">
        {(loading || isProcessing) && jobs.length === 0 ? (
          <div className="flex-grow divide-y divide-gray-100">
            {Array.from({ length: 6 }).map((_, i) => (
              <React.Fragment key={i}>{renderSkeleton()}</React.Fragment>
            ))}
          </div>
        ) : filteredJobs.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center py-32 text-center bg-gray-50/10">
            <p className="text-sm font-semibold text-gray-900 tracking-tight">No positions found</p>
            <p className="text-xs text-gray-400 mt-1 max-w-[200px] leading-relaxed">Adjust filters to see more roles.</p>
          </div>
        ) : (
          <div className="flex-grow">
            {bookmarkedJobs.length > 0 && (
              <div className="bg-amber-50/30">
                <div className="px-6 py-3 border-b border-amber-100/50 flex items-center gap-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-amber-700">📌 Pinned for Review</span>
                </div>
                <ul className="divide-y divide-gray-100">{bookmarkedJobs.map((job) => renderJobItem(job))}</ul>
                <div className="relative py-4 bg-white flex items-center px-6">
                  <div className="flex-grow border-t border-dashed border-gray-200" />
                  <span className="flex-shrink mx-4 text-[10px] font-black text-gray-300 uppercase tracking-widest">Recent Postings</span>
                  <div className="flex-grow border-t border-dashed border-gray-200" />
                </div>
              </div>
            )}
            <ul className="divide-y divide-gray-100">{regularJobs.map((job) => renderJobItem(job))}</ul>
          </div>
        )}

        {/* Sentinel */}
        <div ref={lastElementRef} className="h-20 flex items-center justify-center border-t border-gray-50">
          {(loading || isProcessing) && jobs.length > 0 ? (
            <div className="flex gap-1.5">
              <div className="w-1.5 h-1.5 bg-indigo-600 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <div className="w-1.5 h-1.5 bg-indigo-600 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <div className="w-1.5 h-1.5 bg-indigo-600 rounded-full animate-bounce" />
            </div>
          ) : !hasMore && jobs.length > 0 ? (
            <span className="text-[10px] font-black text-gray-200 uppercase tracking-widest">End of Feed</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
