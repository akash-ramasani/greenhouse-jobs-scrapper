/* eslint-disable max-len */
/**
 * functions/index.js (Node 20, Firebase Functions Gen2)
 *
 * ✅ Greenhouse + AshbyHQ feeds
 * ✅ Only writes jobs whose FEED timestamp is within last 1 hour
 * ✅ Upsert without per-job reads: create() else set(merge)
 * ✅ Greenhouse timestamp rule: max(updated_at, first_published)
 * ✅ Ashby timestamp rule: publishedAt
 *
 * ✅ Fixes “RUNNING forever”:
 *   - heartbeat + leaseExpiresAt updated every 10s
 *   - per-user run lock prevents overlapping runs
 *   - cleanup scheduler marks stale runs failed_stale
 */

const admin = require("firebase-admin");
const { getFunctions } = require("firebase-admin/functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const logger = require("firebase-functions/logger");
const pLimit = require("p-limit").default;

admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

// ------------------------ CONFIG ------------------------
const REGION = "us-central1";

// Concurrency
const FEED_CONCURRENCY = 10; // increase so 300+ feeds finish within task timeout
const JOB_WRITE_CONCURRENCY = 25;

// Schedule
const SCHEDULE = "*/30 * * * *";
const TIME_ZONE = "America/Los_Angeles";

// Fetch reliability (keep tight to avoid slow/hanging feeds)
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_RETRIES = 1;
const FETCH_RETRY_BASE_DELAY_MS = 600;

// Progress heartbeat / lease
const HEARTBEAT_EVERY_MS = 10_000;
const LEASE_EXTENSION_MS = 2 * 60 * 1000; // extend lease 2 minutes each heartbeat
const STALE_GRACE_MS = 2 * 60 * 1000; // extra grace before cleanup marks stale

// Only ingest jobs updated/published in last 1 hour
const UPDATE_WINDOW_MS = 60 * 60 * 1000;

// Error samples for UI
const MAX_ERROR_SAMPLES = 15;

// Firestore doc safety
const MAX_HTML_CHARS = 120_000;

// ------------------------ LOCATION FILTERING (your existing lists) ------------------------
const REMOTE_EXCLUDE_SUBSTRINGS = [
  // (same list as you had)
  "albania","andorra","austria","belgium","bosnia and herzegovina","bulgaria","croatia",
  "cyprus","czech republic","denmark","estonia","finland","france","germany","greece",
  "hungary","iceland","ireland","italy","latvia","liechtenstein","lithuania","luxembourg",
  "malta","monaco","montenegro","netherlands","north macedonia","norway","poland",
  "portugal","romania","san marino","serbia","slovakia","slovenia","spain","sweden",
  "switzerland","ukraine","united kingdom","vatican city",
  "afghanistan","armenia","azerbaijan","bahrain","bangladesh","bhutan","brunei",
  "cambodia","china","georgia","india","indonesia","iran","iraq","israel","japan",
  "jordan","kazakhstan","kuwait","kyrgyzstan","laos","lebanon","malaysia","maldives",
  "mongolia","myanmar","nepal","north korea","oman","pakistan","philippines","qatar",
  "saudi arabia","singapore","south korea","sri lanka","syria","tajikistan","thailand",
  "timor-leste","turkey","turkmenistan","united arab emirates","uzbekistan","vietnam","yemen",
  "algeria","angola","benin","botswana","burkina faso","burundi","cabo verde",
  "cameroon","central african republic","chad","comoros","congo","costa d'ivoire",
  "djibouti","egypt","equatorial guinea","eritrea","eswatini","ethiopia","gabon",
  "gambia","ghana","guinea","guinea-bissau","kenya","lesotho","liberia","libya",
  "madagascar","malawi","mali","mauritania","mauritius","morocco","mozambique",
  "namibia","niger","nigeria","rwanda","sao tome and principe","senegal","seychelles",
  "sierra leone","somalia","south africa","south sudan","sudan","tanzania","togo",
  "tunisia","uganda","zambia","zimbabwe",
  "argentina","bolivia","brazil","chile","colombia","ecuador","guyana","paraguay",
  "peru","suriname","uruguay","venezuela",
  "antigua and barbuda","bahamas","barbados","belize","cuba","dominica",
  "dominican republic","el salvador","grenada","guatemala","haiti","honduras",
  "jamaica","nicaragua","panama","saint kitts and nevis","saint lucia",
  "saint vincent and the grenadines","trinidad and tobago",
  "canada","mexico",
  "australia","fiji","kiribati","marshall islands","micronesia","nauru",
  "new zealand","palau","papua new guinea","samoa","solomon islands","tonga",
  "tuvalu","vanuatu"
];

const US_STATE_CODES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK",
  "OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
];

const US_KEYWORDS = [
  "REMOTE",
  "UNITED STATES",
  "USA",
  "AMER - US",
  "USCA",
  "US-REMOTE",
  "US REMOTE",
  "REMOTE US",
  "REMOTE - US",
  "US-NATIONAL",
  "ANYWHERE IN THE UNITED STATES",
  "U.S.",
];

const MAJOR_US_CITIES = [
  "SAN FRANCISCO","NYC","NEW YORK CITY","LOS ANGELES","CHICAGO","HOUSTON","PHOENIX","PHILADELPHIA",
  "SAN ANTONIO","SAN DIEGO","DALLAS","SAN JOSE","AUSTIN","JACKSONVILLE","FORT WORTH","COLUMBUS",
  "CHARLOTTE","INDIANAPOLIS","SEATTLE","DENVER","BOSTON","EL PASO","NASHVILLE","DETROIT",
  "OKLAHOMA CITY","PORTLAND","LAS VEGAS","MEMPHIS","LOUISVILLE","BALTIMORE","MILWAUKEE",
  "ALBUQUERQUE","TUCSON","FRESNO","SACRAMENTO","MESA","KANSAS CITY","ATLANTA","OMAHA",
  "COLORADO SPRINGS","RALEIGH","LONG BEACH","VIRGINIA BEACH","MIAMI","OAKLAND","MINNEAPOLIS",
  "TULSA","BAKERSFIELD","WICHITA","ARLINGTON",
];

function isUSLocation(locationText) {
  if (!locationText) return false;
  const text = String(locationText).toUpperCase();

  if (US_KEYWORDS.some((kw) => text.includes(kw))) return true;
  if (MAJOR_US_CITIES.some((city) => new RegExp(`(?:^|[,\\s\\/•\\-|\\|])${city}(?:[\\s,;\\/•\\-|\\|]|$)`).test(text))) return true;

  return (
    US_STATE_CODES.some((code) => new RegExp(`(?:^|[,\\s\\/•\\-|\\|])${code}(?:[\\s,;\\/•\\-|\\|]|$)`).test(text)) ||
    /\bUS\b/.test(text) ||
    text.includes("U.S.")
  );
}

function isRemoteLocation(locationText) {
  if (!locationText) return false;
  const s = String(locationText).trim().toLowerCase();
  if (!s.includes("remote")) return false;

  if (s.includes("us-remote") || s.includes("remote us") || s.includes("remote - us")) return true;

  for (const bad of REMOTE_EXCLUDE_SUBSTRINGS) {
    if (s.includes(bad)) return false;
  }
  return true;
}

function shouldKeepJobByLocation(locationName, jobRaw) {
  if (jobRaw && jobRaw.isRemote === true) return true;
  return isUSLocation(locationName) || isRemoteLocation(locationName);
}

function extractStateCodes(locationText) {
  if (!locationText) return [];
  const text = String(locationText).toUpperCase();
  const codes = new Set();

  if (text.includes("WASHINGTON, D.C") || text.includes("WASHINGTON D.C") || text.includes("WASHINGTON DC")) codes.add("DC");

  const tokens = text.match(/\b[A-Z]{2}\b/g) || [];
  for (const t of tokens) {
    if (US_STATE_CODES.includes(t)) codes.add(t);
  }
  return Array.from(codes);
}

// ------------------------ FEED TYPE ------------------------
function detectFeedSource(feedUrl) {
  const u = String(feedUrl || "").toLowerCase();
  if (u.includes("boards-api.greenhouse.io")) return "greenhouse";
  if (u.includes("api.ashbyhq.com/posting-api/job-board")) return "ashby";
  return "unknown";
}

// ------------------------ TIME RULES ------------------------
function parseIsoToMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Greenhouse effective timestamp = max(updated_at, first_published)
function greenhouseEffectiveTime(jobRaw) {
  const updIso = jobRaw?.updated_at || null;
  const fpIso = jobRaw?.first_published || null;
  const updMs = parseIsoToMs(updIso);
  const fpMs = parseIsoToMs(fpIso);

  if (updMs == null && fpMs == null) return null;
  if (updMs != null && fpMs == null) return { ms: updMs, iso: updIso, sourceField: "updated_at" };
  if (updMs == null && fpMs != null) return { ms: fpMs, iso: fpIso, sourceField: "first_published" };

  if (updMs >= fpMs) return { ms: updMs, iso: updIso, sourceField: "updated_at" };
  return { ms: fpMs, iso: fpIso, sourceField: "first_published" };
}

// Ashby effective timestamp = publishedAt
function ashbyEffectiveTime(jobRaw) {
  const iso = jobRaw?.publishedAt || null;
  const ms = parseIsoToMs(iso);
  if (ms == null) return null;
  return { ms, iso, sourceField: "publishedAt" };
}

function isJobWithinUpdateWindow(source, jobRaw, nowMs) {
  const cutoff = nowMs - UPDATE_WINDOW_MS;
  if (source === "greenhouse") {
    const eff = greenhouseEffectiveTime(jobRaw);
    return !!eff && eff.ms >= cutoff;
  }
  if (source === "ashby") {
    const eff = ashbyEffectiveTime(jobRaw);
    return !!eff && eff.ms >= cutoff;
  }
  return false;
}

function isoToTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Timestamp.now();
  return Timestamp.fromDate(d);
}

function computeUpdatedAtForStorage(source, jobRawGreenhouseLike, jobRawOriginalForRule) {
  if (source === "greenhouse") {
    const eff = greenhouseEffectiveTime(jobRawOriginalForRule || jobRawGreenhouseLike);
    if (eff?.iso) return { updatedAtIso: eff.iso, updatedAtTs: isoToTimestamp(eff.iso), updatedAtSource: eff.sourceField };
  }
  if (source === "ashby") {
    const eff = ashbyEffectiveTime(jobRawOriginalForRule || jobRawGreenhouseLike);
    if (eff?.iso) return { updatedAtIso: eff.iso, updatedAtTs: isoToTimestamp(eff.iso), updatedAtSource: eff.sourceField };
  }
  const fallbackIso = new Date().toISOString();
  return { updatedAtIso: fallbackIso, updatedAtTs: Timestamp.now(), updatedAtSource: "fallback" };
}

// ------------------------ FETCH ------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function safeReadText(res) {
  try { return await res.text(); } catch { return ""; }
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function fetchJson(url) {
  let attempt = 0;
  while (attempt <= FETCH_RETRIES) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "user-agent": "jobs-aggregator/8.0", accept: "application/json" },
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await safeReadText(res);
        const msg = `HTTP ${res.status} ${res.statusText} for ${url} :: ${(body || "").slice(0, 300)}`;

        if (isRetryableHttpStatus(res.status) && attempt < FETCH_RETRIES) {
          const delay = FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 150);
          logger.warn("retryable http error", { url, status: res.status, attempt, delay });
          await sleep(delay);
          attempt += 1;
          continue;
        }
        throw new Error(msg);
      }

      return await res.json();
    } catch (err) {
      const isAbort = err?.name === "AbortError";
      const retryable = isAbort || /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(String(err?.message || err));

      if (attempt < FETCH_RETRIES && retryable) {
        const delay = FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 150);
        logger.warn("retryable network error", { url, attempt, delay, error: String(err?.message || err) });
        await sleep(delay);
        attempt += 1;
        continue;
      }

      if (isAbort) throw new Error(`Timeout after ${FETCH_TIMEOUT_MS}ms for ${url}`);
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  throw new Error(`Fetch failed after retries for ${url}`);
}

// ------------------------ CONTENT CLEANING ------------------------
function decodeHtmlEntities(s) {
  if (!s) return "";
  return String(s)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeTracking(html) {
  if (!html) return "";
  let s = String(html);

  s = s.replace(/<img\b[^>]*>/gi, " ");

  const trackerDomains = [
    "click.appcast.io",
    "track.jobadx.com",
    "jobadx.com",
    "appcast.io",
    "doubleclick.net",
    "googlesyndication.com",
  ];
  for (const d of trackerDomains) {
    const re = new RegExp(`<a\\b[^>]*href=["'][^"']*${escapeRegex(d)}[^"']*["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
    s = s.replace(re, "$1");
  }
  return s;
}

function capStr(s, n) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, n);
}

function normalizeContentHtmlClean(rawContent) {
  const decoded = decodeHtmlEntities(rawContent || "");
  const noTrack = removeTracking(decoded);
  return capStr(noTrack, MAX_HTML_CHARS);
}

// ------------------------ METADATA NORMALIZATION ------------------------
function normalizeMetadata(metadataArr) {
  if (!Array.isArray(metadataArr)) return { metadataKV: {}, metadataList: [] };

  const kv = {};
  const list = [];

  for (const item of metadataArr) {
    if (!item || !item.name) continue;
    const name = String(item.name).trim();
    let value = item.value;

    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;

    let normalizedValue = value;

    if (item.value_type === "currency" && value && typeof value === "object" && !Array.isArray(value)) {
      const unit = value.unit || "USD";
      const amountStr = value.amount;
      const amountNum = amountStr != null ? Number(amountStr) : null;
      normalizedValue = { unit, amount: Number.isFinite(amountNum) ? amountNum : amountStr };
    } else if (Array.isArray(value)) {
      normalizedValue = value.map((v) => (typeof v === "string" ? v.trim() : v)).filter(Boolean);
    } else if (typeof value === "object") {
      normalizedValue = value;
    } else if (typeof value === "string") {
      normalizedValue = value.trim();
    }

    if (kv[name] === undefined) {
      kv[name] = normalizedValue;
      list.push({ name, value: normalizedValue });
    }
  }

  return { metadataKV: kv, metadataList: list };
}

// ------------------------ ASHBY -> GH-LIKE ------------------------
function toGreenhouseLikeJob(source, jobRaw) {
  if (source === "greenhouse") return jobRaw;
  return {
    id: jobRaw?.id,
    title: jobRaw?.title || null,
    absolute_url: jobRaw?.jobUrl || null,
    apply_url: jobRaw?.applyUrl || null,
    updated_at: jobRaw?.publishedAt || null,
    first_published: jobRaw?.publishedAt || null,
    company_name: null,
    requisition_id: null,
    language: null,
    internal_job_id: null,
    location: { name: jobRaw?.location || "" },
    metadata: [
      ...(jobRaw?.department ? [{ name: "Department", value: jobRaw.department, value_type: "short_text" }] : []),
      ...(jobRaw?.team ? [{ name: "Team", value: jobRaw.team, value_type: "short_text" }] : []),
      ...(jobRaw?.employmentType ? [{ name: "Employment Type", value: jobRaw.employmentType, value_type: "short_text" }] : []),
    ],
    content: jobRaw?.descriptionHtml || "",
    _ashby: { isRemote: jobRaw?.isRemote ?? null },
    isRemote: jobRaw?.isRemote === true,
  };
}

function extractJobsFromFeedJson(source, json) {
  if (source === "greenhouse") return Array.isArray(json?.jobs) ? json.jobs : [];
  if (source === "ashby") {
    if (Array.isArray(json?.jobs)) return json.jobs;
    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.jobBoard?.jobs)) return json.jobBoard.jobs;
    return [];
  }
  if (Array.isArray(json?.jobs)) return json.jobs;
  if (Array.isArray(json)) return json;
  return [];
}

// ------------------------ IDs / COMPANY KEY ------------------------
function jobDocId(companyKey, jobId) {
  return `${companyKey}__${jobId}`;
}

function inferAshbyCompanyKeyFromUrl(feedUrl) {
  try {
    const u = new URL(feedUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("job-board");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1].toLowerCase();
  } catch {}
  return null;
}

function inferGreenhouseCompanyKeyFromUrl(feedUrl) {
  try {
    const u = new URL(feedUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("boards");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1].toLowerCase();
  } catch {}
  return null;
}

function feedCompanyKey(feed) {
  const source = detectFeedSource(feed.url);
  if (source === "greenhouse") return inferGreenhouseCompanyKeyFromUrl(feed.url) || feed.id;
  if (source === "ashby") return inferAshbyCompanyKeyFromUrl(feed.url) || feed.id;

  try {
    const u = new URL(feed.url);
    const host = u.hostname.replaceAll(".", "_");
    return `${host}_${feed.id}`.toLowerCase();
  } catch {
    return feed.id;
  }
}

function resolveCompanyName(feed, jobRaw, source) {
  const fromFeed = (feed?.name || "").trim();
  if (fromFeed) return fromFeed;

  const fromJob = (jobRaw?.company_name || "").trim();
  if (fromJob) return fromJob;

  if (source === "ashby") {
    const key = inferAshbyCompanyKeyFromUrl(feed?.url) || feedCompanyKey(feed);
    if (key) return key.charAt(0).toUpperCase() + key.slice(1);
  }

  return feedCompanyKey(feed) || "Unknown";
}

// ------------------------ NORMALIZE JOB ------------------------
function normalizeJob(uid, feed, jobRawGreenhouseLike, source, jobRawOriginalForRule) {
  const locationName = jobRawGreenhouseLike?.location?.name || "";

  const { updatedAtIso, updatedAtTs, updatedAtSource } = computeUpdatedAtForStorage(
    source,
    jobRawGreenhouseLike,
    jobRawOriginalForRule
  );

  const { metadataKV, metadataList } = normalizeMetadata(jobRawGreenhouseLike.metadata);
  const contentHtmlClean = normalizeContentHtmlClean(jobRawGreenhouseLike.content || "");

  const explicitRemote = jobRawGreenhouseLike?.isRemote === true || jobRawGreenhouseLike?._ashby?.isRemote === true;
  const computedRemote = isRemoteLocation(locationName) || (!locationName && true);
  const isRemote = explicitRemote || computedRemote;

  const stateCodes = extractStateCodes(locationName);
  const companyKey = feedCompanyKey(feed);

  return {
    uid,
    source,
    companyKey,
    companyName: resolveCompanyName(feed, jobRawGreenhouseLike, source),

    locationName: locationName || "Remote",
    absolute_url: jobRawGreenhouseLike.absolute_url || null,
    applyUrl: jobRawGreenhouseLike.apply_url || jobRawGreenhouseLike?._ashby?.applyUrl || null,
    title: jobRawGreenhouseLike.title || null,

    updatedAtIso,
    updatedAtTs,
    updatedAtSource,

    stateCodes,
    isRemote,

    jobId: jobRawGreenhouseLike.id,
    internalJobId: jobRawGreenhouseLike.internal_job_id ?? null,
    requisitionId: jobRawGreenhouseLike.requisition_id ?? null,
    language: jobRawGreenhouseLike.language || null,
    firstPublishedIso: jobRawGreenhouseLike.first_published || null,

    metadataKV,
    metadataList,

    contentHtmlClean,

    saved: false,

    lastSeenAt: FieldValue.serverTimestamp(),
    lastIngestedAt: FieldValue.serverTimestamp(),
  };
}

// ------------------------ FIRESTORE LOADS ------------------------
async function loadUserFeeds(uid) {
  const snap = await db.collection("users").doc(uid).collection("feeds").get();
  const feeds = [];
  snap.forEach((d) => {
    const data = d.data() || {};
    feeds.push({
      id: d.id,
      name: data.company || data.name || null,
      url: data.url || null,
      active: data.active !== false,
      source: data.source || null,
    });
  });
  return feeds.filter((f) => f.url && f.active);
}

async function upsertCompanyDoc(uid, feed) {
  const companyKey = feedCompanyKey(feed);
  const ref = db.collection("users").doc(uid).collection("companies").doc(companyKey);
  const name = (feed?.name || "").trim() || companyKey;

  await ref.set(
    {
      companyKey,
      companyName: name,
      lastSeenAt: FieldValue.serverTimestamp(),
      url: feed.url || null,
      source: detectFeedSource(feed.url),
    },
    { merge: true }
  );
}

// ------------------------ UPSERT WITHOUT READS ------------------------
function isAlreadyExistsError(e) {
  const code = e?.code;
  if (code === 6) return true;
  const msg = String(e?.message || "");
  return msg.includes("ALREADY_EXISTS") || msg.includes("already exists");
}

async function upsertJobNoRead(bulkWriter, jobsColRef, docId, normalized) {
  const ref = jobsColRef.doc(docId);
  try {
    await bulkWriter.create(ref, {
      ...normalized,
      createdAt: FieldValue.serverTimestamp(),
      firstSeenAt: FieldValue.serverTimestamp(),
    });
    return { created: 1, updated: 0 };
  } catch (e) {
    if (!isAlreadyExistsError(e)) throw e;
    await bulkWriter.set(ref, normalized, { merge: true });
    return { created: 0, updated: 1 };
  }
}

// ------------------------ PROCESS ONE FEED ------------------------
async function processOneFeed(uid, feed, bulkWriter) {
  const source = feed.source || detectFeedSource(feed.url);
  const json = await fetchJson(feed.url);
  const jobsRaw = extractJobsFromFeedJson(source, json);

  const nowMs = Date.now();
  const keptRaw = [];

  for (const j of jobsRaw) {
    if (!isJobWithinUpdateWindow(source, j, nowMs)) continue;

    const loc = source === "greenhouse" ? j?.location?.name : j?.location;
    if (!loc || shouldKeepJobByLocation(loc, j)) keptRaw.push(j);
  }

  const companyKey = feedCompanyKey(feed);
  const jobsCol = db.collection("users").doc(uid).collection("jobs");
  const limitWrite = pLimit(JOB_WRITE_CONCURRENCY);

  let createdCount = 0;
  let updatedCount = 0;

  await Promise.all(
    keptRaw.map((jobRaw) =>
      limitWrite(async () => {
        const ghLike = toGreenhouseLikeJob(source, jobRaw);
        const normalized = normalizeJob(uid, feed, ghLike, source, jobRaw);
        const docId = jobDocId(companyKey, ghLike.id);
        const res = await upsertJobNoRead(bulkWriter, jobsCol, docId, normalized);
        createdCount += res.created;
        updatedCount += res.updated;
      })
    )
  );

  if (keptRaw.length > 0) await upsertCompanyDoc(uid, feed);

  return { processed: keptRaw.length, createdCount, updatedCount };
}

// ------------------------ FETCH RUN HELPERS ------------------------
function fetchRunRef(uid, runId) {
  return db.collection("users").doc(uid).collection("fetchRuns").doc(runId);
}

async function createFetchRun(uid, runType, initialStatus, extra = {}) {
  const ref = db.collection("users").doc(uid).collection("fetchRuns").doc();
  await ref.set({
    runType,
    status: initialStatus,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...extra,
  });
  return { runId: ref.id, ref };
}

// ------------------------ RUN LOCK (prevents overlapping runs) ------------------------
async function acquireRunLock(uid, runId) {
  const userRef = db.collection("users").doc(uid);

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.data() || {};
    const lock = data.pollLock || null;
    const now = Date.now();

    if (lock?.active === true && lock?.expiresAtMs && lock.expiresAtMs > now) {
      return { ok: false, reason: "lock_active", lock };
    }

    tx.set(
      userRef,
      {
        pollLock: {
          active: true,
          runId,
          acquiredAtMs: now,
          expiresAtMs: now + 12 * 60 * 1000, // 12 minutes lock window
        },
      },
      { merge: true }
    );

    return { ok: true };
  });
}

async function releaseRunLock(uid, runId) {
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.data() || {};
    const lock = data.pollLock || null;

    if (lock?.runId !== runId) return;

    tx.set(
      userRef,
      { pollLock: { active: false, runId: null, releasedAtMs: Date.now(), expiresAtMs: 0 } },
      { merge: true }
    );
  });
}

// ------------------------ TASK URI ------------------------
function getProjectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || process.env.PROJECT_ID || null;
}

function taskFunctionUri(functionName) {
  const projectId = getProjectId();
  if (!projectId) throw new Error("Missing project ID env var (GCLOUD_PROJECT/GCP_PROJECT/PROJECT_ID).");
  return `https://${REGION}-${projectId}.cloudfunctions.net/${functionName}`;
}

// ------------------------ ENQUEUE ------------------------
async function enqueueUserRun(uid, runType) {
  const { runId, ref } = await createFetchRun(uid, runType, "enqueued", { enqueuedAt: FieldValue.serverTimestamp() });

  // acquire lock BEFORE enqueue
  const lockRes = await acquireRunLock(uid, runId);
  if (!lockRes.ok) {
    await ref.set(
      {
        status: "skipped_lock_active",
        updatedAt: FieldValue.serverTimestamp(),
        skipReason: "Another run is still active. Skipping enqueue.",
        lock: lockRes.lock || null,
      },
      { merge: true }
    );
    return { ok: false, runId, status: "skipped_lock_active" };
  }

  const queue = getFunctions().taskQueue("pollUserTaskV2");
  const targetUri = taskFunctionUri("pollUserTaskV2");

  try {
    await queue.enqueue({ uid, runType, runId }, { uri: targetUri });
    return { ok: true, runId, status: "enqueued" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    await ref.set(
      { status: "enqueue_failed", updatedAt: FieldValue.serverTimestamp(), enqueueError: msg },
      { merge: true }
    );

    await releaseRunLock(uid, runId);
    throw err;
  }
}

// ------------------------ MAIN PROCESS ------------------------
async function processUserFeeds(uid, runType, runId) {
  const startedAtMs = Date.now();
  const feeds = await loadUserFeeds(uid);
  const runRef = fetchRunRef(uid, runId);

  let processedTotal = 0;
  let createdTotal = 0;
  let updatedTotal = 0;
  let errorsCount = 0;
  const errorSamples = [];

  // set running + initial lease
  await runRef.set(
    {
      runType,
      status: "running",
      startedAt: FieldValue.serverTimestamp(),
      feedsCount: feeds.length,
      updatedAt: FieldValue.serverTimestamp(),
      processed: 0,
      createdCount: 0,
      updatedCount: 0,
      errorsCount: 0,
      errorSamples: [],
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + LEASE_EXTENSION_MS),
    },
    { merge: true }
  );

  // heartbeat keeps UI fresh + extends lease so cleanup won’t mark stale
  const writeHeartbeat = async () => {
    await runRef.set(
      {
        updatedAt: FieldValue.serverTimestamp(),
        processed: processedTotal,
        createdCount: createdTotal,
        updatedCount: updatedTotal,
        errorsCount,
        errorSamples,
        leaseExpiresAt: Timestamp.fromMillis(Date.now() + LEASE_EXTENSION_MS),
      },
      { merge: true }
    );
  };

  const heartbeatTimer = setInterval(() => {
    writeHeartbeat().catch((e) => logger.warn("heartbeat failed", { runId, error: String(e?.message || e) }));
  }, HEARTBEAT_EVERY_MS);

  const bulkWriter = db.bulkWriter();
  bulkWriter.onWriteError((error) => {
    const code = error?.code;
    const retryable = code === 4 || code === 8 || code === 10 || code === 13 || code === 14;
    if (retryable && error.failedAttempts < 3) return true;
    logger.error("BulkWriter write failed", { error: String(error) });
    return false;
  });

  const limitFeed = pLimit(FEED_CONCURRENCY);

  try {
    await Promise.all(
      feeds.map((feed) =>
        limitFeed(async () => {
          try {
            const summary = await processOneFeed(uid, feed, bulkWriter);
            processedTotal += summary.processed;
            createdTotal += summary.createdCount;
            updatedTotal += summary.updatedCount;
          } catch (err) {
            errorsCount += 1;
            const msg = String(err?.message || err);
            logger.warn("feed failed", { uid, url: feed.url, error: msg });

            if (errorSamples.length < MAX_ERROR_SAMPLES) errorSamples.push({ url: feed.url, error: msg });
          }
        })
      )
    );

    await bulkWriter.close();

    const durationMs = Date.now() - startedAtMs;

    await runRef.set(
      {
        status: errorsCount ? "done_with_errors" : "done",
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        durationMs,
        processed: processedTotal,
        createdCount: createdTotal,
        updatedCount: updatedTotal,
        errorsCount,
        errorSamples,
        leaseExpiresAt: Timestamp.fromMillis(Date.now() + LEASE_EXTENSION_MS),
      },
      { merge: true }
    );
  } finally {
    clearInterval(heartbeatTimer);
    await releaseRunLock(uid, runId).catch(() => {});
  }
}

// ------------------------ CLEANUP: MARK STALE RUNS ------------------------
exports.cleanupStaleFetchRunsV2 = onSchedule(
  { region: REGION, schedule: "*/10 * * * *", timeZone: TIME_ZONE },
  async () => {
    // This scans ONLY recent-ish stuck runs. Keep limits small.
    // Query all users is expensive; instead, scan collection group fetchRuns.
    const now = Date.now();
    const cutoff = Timestamp.fromMillis(now - 6 * 60 * 60 * 1000); // last 6h only

    const snap = await db
      .collectionGroup("fetchRuns")
      .where("createdAt", ">=", cutoff)
      .where("status", "in", ["running", "enqueued"])
      .limit(200)
      .get();

    if (snap.empty) return null;

    const bw = db.bulkWriter();

    let marked = 0;

    snap.docs.forEach((d) => {
      const r = d.data() || {};
      const lease = r.leaseExpiresAt?.toMillis ? r.leaseExpiresAt.toMillis() : 0;

      // if lease expired + grace, mark stale
      if (lease && lease + STALE_GRACE_MS < now) {
        bw.set(
          d.ref,
          {
            status: "failed_stale",
            finishedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            error: "Run lease expired (function likely timed out/crashed). Marked stale by cleanup job.",
          },
          { merge: true }
        );
        marked += 1;
      }
    });

    await bw.close();
    logger.info("cleanupStaleFetchRunsV2", { candidates: snap.size, marked });
    return null;
  }
);

// ------------------------ CLOUD FUNCTIONS ------------------------
exports.pollNowV2 = onCall({ region: REGION }, async (req) => {
  if (!req.auth?.uid) throw new HttpsError("unauthenticated", "You must be signed in.");
  try {
    return await enqueueUserRun(req.auth.uid, "manual");
  } catch (err) {
    throw new HttpsError("internal", err instanceof Error ? err.message : String(err));
  }
});

exports.pollGreenhouseFeedsV2 = onSchedule(
  { region: REGION, schedule: SCHEDULE, timeZone: TIME_ZONE },
  async () => {
    const usersSnap = await db.collection("users").get();
    logger.info("scheduler tick", { users: usersSnap.size, schedule: SCHEDULE, tz: TIME_ZONE });

    const limitEnq = pLimit(50);

    await Promise.all(
      usersSnap.docs.map((u) =>
        limitEnq(async () => {
          try {
            await enqueueUserRun(u.id, "scheduled");
          } catch (err) {
            logger.error("scheduled enqueue failed", { uid: u.id, error: String(err?.message || err) });
          }
        })
      )
    );

    return null;
  }
);

exports.pollUserTaskV2 = onTaskDispatched(
  {
    region: REGION,
    timeoutSeconds: 540,
    memory: "1GiB",
    rateLimits: { maxConcurrentDispatches: 10 },
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 },
  },
  async (req) => {
    const { uid, runType, runId } = req.data || {};
    if (!uid || !runId) return;

    logger.info("task start", { uid, runType, runId });

    try {
      await processUserFeeds(uid, runType || "scheduled", runId);
      logger.info("task done", { uid, runType, runId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // best-effort mark failed (if we still have time)
      await fetchRunRef(uid, runId).set(
        {
          status: "failed",
          updatedAt: FieldValue.serverTimestamp(),
          finishedAt: FieldValue.serverTimestamp(),
          error: msg,
        },
        { merge: true }
      ).catch(() => {});

      await releaseRunLock(uid, runId).catch(() => {});

      logger.error("task failed", { uid, runType, runId, error: msg });
      throw err;
    }
  }
);
