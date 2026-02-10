/* eslint-disable max-len */
/**
 * functions/index.js (Node 20, Firebase Functions Gen2)
 *
 * ✅ Supports BOTH Greenhouse + AshbyHQ feeds
 * - Greenhouse (boards-api): https://boards-api.greenhouse.io/v1/boards/<company>/jobs
 * - AshbyHQ (posting-api):   https://api.ashbyhq.com/posting-api/job-board/<company>
 *
 * ✅ Ingests ONLY jobs from last 21 days (rolling window):
 * - Greenhouse: uses updated_at, BUT edge-case fallback:
 *    If updated_at is older than 21 days AND first_published is within 21 days => KEEP
 * - AshbyHQ: uses publishedAt
 *
 * ✅ Cleanup pipeline (delete jobs older than 21 days) based on updatedAtTs:
 * - callable: purgeOldJobsNowV2
 * - task:     purgeUserOldJobsTaskV2
 * - optional scheduled cleanup (daily)
 *
 * ✅ Still NO perFeedSummary / NO errorSamples
 * ✅ fetchRuns still tracks
 * ✅ Scale fixes remain (no per-job reads, BulkWriter, retries/timeouts, task queue)
 * ✅ Content fields: keeps ONLY contentHtmlClean
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

// Per-user concurrency (tune if you see throttling/timeouts)
const FEED_CONCURRENCY = 6;
const JOB_WRITE_CONCURRENCY = 25;

// Schedule
const SCHEDULE = "*/30 * * * *";
const TIME_ZONE = "America/Los_Angeles";

// Fetch reliability
const FETCH_TIMEOUT_MS = 90_000;
const FETCH_RETRIES = 3;
const FETCH_RETRY_BASE_DELAY_MS = 800;

// Progress heartbeat (updates fetchRuns while running)
const HEARTBEAT_EVERY_MS = 10_000;

// Firestore doc safety
const MAX_HTML_CHARS = 120_000;

// ✅ Rolling retention window (last 1 hour)
const LAST_N_HOURS = 1;
const LAST_WINDOW_MS = LAST_N_HOURS * 60 * 60 * 1000;

// Cleanup batching
const CLEANUP_BATCH_SIZE = 400;
const CLEANUP_QUERY_LIMIT = 400;

// If you want "remote anywhere worldwide", set this to [].
const REMOTE_EXCLUDE_SUBSTRINGS = [
  // Europe
  "albania","andorra","austria","belgium","bosnia and herzegovina","bulgaria","croatia",
  "cyprus","czech republic","denmark","estonia","finland","france","germany","greece",
  "hungary","iceland","ireland","italy","latvia","liechtenstein","lithuania","luxembourg",
  "malta","monaco","montenegro","netherlands","north macedonia","norway","poland",
  "portugal","romania","san marino","serbia","slovakia","slovenia","spain","sweden",
  "switzerland","ukraine","united kingdom","vatican city",

  // Asia
  "afghanistan","armenia","azerbaijan","bahrain","bangladesh","bhutan","brunei",
  "cambodia","china","georgia","india","indonesia","iran","iraq","israel","japan",
  "jordan","kazakhstan","kuwait","kyrgyzstan","laos","lebanon","malaysia","maldives",
  "mongolia","myanmar","nepal","north korea","oman","pakistan","philippines","qatar",
  "saudi arabia","singapore","south korea","sri lanka","syria","tajikistan","thailand",
  "timor-leste","turkey","turkmenistan","united arab emirates","uzbekistan","vietnam","yemen",

  // Africa
  "algeria","angola","benin","botswana","burkina faso","burundi","cabo verde",
  "cameroon","central african republic","chad","comoros","congo","costa d'ivoire",
  "djibouti","egypt","equatorial guinea","eritrea","eswatini","ethiopia","gabon",
  "gambia","ghana","guinea","guinea-bissau","kenya","lesotho","liberia","libya",
  "madagascar","malawi","mali","mauritania","mauritius","morocco","mozambique",
  "namibia","niger","nigeria","rwanda","sao tome and principe","senegal","seychelles",
  "sierra leone","somalia","south africa","south sudan","sudan","tanzania","togo",
  "tunisia","uganda","zambia","zimbabwe",

  // South America
  "argentina","bolivia","brazil","chile","colombia","ecuador","guyana","paraguay",
  "peru","suriname","uruguay","venezuela",

  // Central America & Caribbean
  "antigua and barbuda","bahamas","barbados","belize","cuba","dominica",
  "dominican republic","el salvador","grenada","guatemala","haiti","honduras",
  "jamaica","nicaragua","panama","saint kitts and nevis","saint lucia",
  "saint vincent and the grenadines","trinidad and tobago",

  // North America (explicitly included, excluding USA)
  "canada","mexico",

  // Oceania
  "australia","fiji","kiribati","marshall islands","micronesia","nauru",
  "new zealand","palau","papua new guinea","samoa","solomon islands","tonga",
  "tuvalu","vanuatu"
];

// ---------------- US Location Filtering ----------------
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

  if (MAJOR_US_CITIES.some((city) => new RegExp(`(?:^|[,\\s\\/•\\-|\\|])${city}(?:[\\s,;\\/•\\-|\\|]|$)`).test(text))) {
    return true;
  }

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

  if (
    text.includes("WASHINGTON, D.C") ||
    text.includes("WASHINGTON D.C") ||
    text.includes("WASHINGTON DC")
  ) {
    codes.add("DC");
  }

  const tokens = text.match(/\b[A-Z]{2}\b/g) || [];
  for (const t of tokens) {
    if (US_STATE_CODES.includes(t)) codes.add(t);
  }

  return Array.from(codes);
}

// ------------------------ FEED TYPE DETECTION ------------------------
function detectFeedSource(feedUrl) {
  const u = String(feedUrl || "").toLowerCase();
  if (u.includes("boards-api.greenhouse.io")) return "greenhouse";
  if (u.includes("api.ashbyhq.com/posting-api/job-board")) return "ashby";
  return "unknown";
}

// ------------------------ TIME ------------------------
function parseUpdatedAtIso(jobRaw) {
  if (jobRaw?.updated_at) return jobRaw.updated_at;
  if (jobRaw?.first_published) return jobRaw.first_published;
  if (jobRaw?.publishedAt) return jobRaw.publishedAt;
  return new Date().toISOString();
}

function isoToTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Timestamp.now();
  return Timestamp.fromDate(d);
}

function parseIsoToMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * ✅ NEW behavior:
 * - Greenhouse: keep if (updated_at within 21d) OR (first_published within 21d)
 *   This addresses your edge-case request.
 * - Ashby: keep if publishedAt within 21d
 */
function isJobWithinLastWindow(source, jobRaw, nowMs = Date.now()) {
  const cutoffMs = nowMs - LAST_WINDOW_MS;

  // ✅ Greenhouse: keep if updated_at within 1 hour OR first_published within 1 hour (edge-case fallback)
  if (source === "greenhouse") {
    const updatedMs = parseIsoToMs(jobRaw?.updated_at);
    if (updatedMs != null && updatedMs >= cutoffMs) return true;

    const firstPubMs = parseIsoToMs(jobRaw?.first_published);
    if (firstPubMs != null && firstPubMs >= cutoffMs) return true;

    return false;
  }

  // ✅ Ashby: keep if publishedAt within 1 hour
  if (source === "ashby") {
    const pubMs = parseIsoToMs(jobRaw?.publishedAt);
    if (pubMs == null) return false;
    return pubMs >= cutoffMs;
  }

  return false;
}

function cutoffTimestampNow() {
  const cutoffMs = Date.now() - LAST_WINDOW_MS;
  return Timestamp.fromDate(new Date(cutoffMs));
}

// ------------------------ HTTP / FETCH ------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
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
        headers: {
          "user-agent": "jobs-aggregator/4.0",
          accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await safeReadText(res);
        const msg = `HTTP ${res.status} ${res.statusText} for ${url} :: ${(body || "").slice(0, 300)}`;

        if (isRetryableHttpStatus(res.status) && attempt < FETCH_RETRIES) {
          const delay = FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
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
        const delay = FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
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

// ------------------------ CONTENT CLEANING (ONLY contentHtmlClean) ------------------------
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

  // remove img pixels
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

// ------------------------ ASHBY -> GH-LIKE SHIM ------------------------
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
    _ashby: {
      isRemote: jobRaw?.isRemote ?? null,
      jobUrl: jobRaw?.jobUrl ?? null,
      applyUrl: jobRaw?.applyUrl ?? null,
      address: jobRaw?.address ?? null,
      isListed: jobRaw?.isListed ?? null,
    },
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

// ------------------------ JOB KEY / NORMALIZATION ------------------------
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

function detectFeedSourceFromFeed(feed) {
  return feed.source || detectFeedSource(feed.url);
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

function normalizeJob(uid, feed, jobRawGreenhouseLike, source) {
  const locationName = jobRawGreenhouseLike?.location?.name || "";
  const updatedAtIso = parseUpdatedAtIso(jobRawGreenhouseLike);
  const updatedAtTs = isoToTimestamp(updatedAtIso);

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

    stateCodes,
    isRemote,

    jobId: jobRawGreenhouseLike.id,
    internalJobId: jobRawGreenhouseLike.internal_job_id ?? jobRawGreenhouseLike.internalJobId ?? null,
    requisitionId: jobRawGreenhouseLike.requisition_id ?? null,
    language: jobRawGreenhouseLike.language || null,
    firstPublishedIso: jobRawGreenhouseLike.first_published || null,

    metadataKV,
    metadataList,

    contentHtmlClean,

    lastSeenAt: FieldValue.serverTimestamp(),
    lastIngestedAt: FieldValue.serverTimestamp(),
  };
}

// ------------------------ FEED PROCESSING ------------------------
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

async function upsertCompanyDoc(uid, feed, inferredCompanyName) {
  const companyKey = feedCompanyKey(feed);
  const ref = db.collection("users").doc(uid).collection("companies").doc(companyKey);

  const name =
    (feed?.name || "").trim() ||
    (inferredCompanyName || "").trim() ||
    companyKey;

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

function isAlreadyExistsError(e) {
  const code = e?.code;
  if (code === 6) return true; // ALREADY_EXISTS
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
      saved: false,
    });
    return 1;
  } catch (e) {
    if (!isAlreadyExistsError(e)) throw e;
    await bulkWriter.set(ref, normalized, { merge: true });
    return 0;
  }
}

function inferCompanyNameFromFeed(feed, source, jobsRaw) {
  if (source === "greenhouse") {
    const inferred = (jobsRaw.find((j) => (j?.company_name || "").trim())?.company_name || "").trim();
    return inferred || null;
  }

  if (source === "ashby") {
    if ((feed?.name || "").trim()) return (feed.name || "").trim();
    const key = inferAshbyCompanyKeyFromUrl(feed?.url);
    if (key) return key.charAt(0).toUpperCase() + key.slice(1);
    return null;
  }

  return null;
}

async function processOneFeed(uid, feed, bulkWriter) {
  const source = detectFeedSourceFromFeed(feed);
  const json = await fetchJson(feed.url);

  const jobsRaw = extractJobsFromFeedJson(source, json);
  const inferredCompanyName = inferCompanyNameFromFeed(feed, source, jobsRaw);

  // ✅ filter by recency (21 days) + location rules
  const keptRaw = [];
  const nowMs = Date.now();

  for (const j of jobsRaw) {
    // 1) Recency gate (Greenhouse updated_at OR first_published; Ashby publishedAt)
    if (!isJobWithinLastWindow(source, j, nowMs)) continue;


    // 2) Location gate
    const loc = source === "greenhouse" ? j?.location?.name : j?.location;
    if (!loc || shouldKeepJobByLocation(loc, j)) keptRaw.push(j);
  }

  const companyKey = feedCompanyKey(feed);
  const jobsCol = db.collection("users").doc(uid).collection("jobs");
  const limitWrite = pLimit(JOB_WRITE_CONCURRENCY);

  const createdFlags = await Promise.all(
    keptRaw.map((jobRaw) =>
      limitWrite(async () => {
        const ghLike = toGreenhouseLikeJob(source, jobRaw);
        const normalized = normalizeJob(uid, feed, ghLike, source);
        const docId = jobDocId(companyKey, ghLike.id);
        return await upsertJobNoRead(bulkWriter, jobsCol, docId, normalized);
      })
    )
  );

  const newCount = createdFlags.reduce((a, b) => a + b, 0);

  await upsertCompanyDoc(uid, feed, inferredCompanyName);

  return {
    processed: keptRaw.length,
    newCount,
  };
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

// ------------------------ TASK URI HELPERS ------------------------
function getProjectId() {
  return process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || process.env.PROJECT_ID || null;
}

function taskFunctionUri(functionName) {
  const projectId = getProjectId();
  if (!projectId) throw new Error("Missing project ID env var (GCLOUD_PROJECT/GCP_PROJECT/PROJECT_ID). Cannot build task URI.");
  return `https://${REGION}-${projectId}.cloudfunctions.net/${functionName}`;
}

// ------------------------ ENQUEUE (used by BOTH manual + scheduled) ------------------------
async function enqueueUserRun(uid, runType) {
  const { runId, ref } = await createFetchRun(uid, runType, "enqueued", {
    enqueuedAt: FieldValue.serverTimestamp(),
  });

  const queue = getFunctions().taskQueue("pollUserTaskV2");
  const targetUri = taskFunctionUri("pollUserTaskV2");

  try {
    await queue.enqueue({ uid, runType, runId }, { uri: targetUri });
    return { ok: true, runId, status: "enqueued" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ref.set(
      {
        status: "enqueue_failed",
        updatedAt: FieldValue.serverTimestamp(),
        enqueueError: msg,
      },
      { merge: true }
    );
    throw err;
  }
}

// ------------------------ CLEANUP (DELETE old jobs) ------------------------
async function enqueueUserCleanup(uid, runType = "cleanup") {
  const { runId, ref } = await createFetchRun(uid, runType, "enqueued", {
    enqueuedAt: FieldValue.serverTimestamp(),
  });

  const queue = getFunctions().taskQueue("purgeUserOldJobsTaskV2");
  const targetUri = taskFunctionUri("purgeUserOldJobsTaskV2");

  try {
    await queue.enqueue({ uid, runType, runId }, { uri: targetUri });
    return { ok: true, runId, status: "enqueued" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ref.set(
      {
        status: "enqueue_failed",
        updatedAt: FieldValue.serverTimestamp(),
        enqueueError: msg,
      },
      { merge: true }
    );
    throw err;
  }
}

async function purgeOldJobsForUser(uid, runType, runId) {
  const startedAtMs = Date.now();
  const runRef = fetchRunRef(uid, runId);

  const cutoffTs = cutoffTimestampNow();
  let deleted = 0;

  await runRef.set(
    {
      runType,
      status: "running",
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      cutoffUpdatedAtTs: cutoffTs,
      deleted: 0,
    },
    { merge: true }
  );

  const jobsCol = db.collection("users").doc(uid).collection("jobs");

  const bulkWriter = db.bulkWriter();
  bulkWriter.onWriteError((error) => {
    const code = error?.code;
    const retryable =
      code === 4 ||  // DEADLINE_EXCEEDED
      code === 8 ||  // RESOURCE_EXHAUSTED
      code === 10 || // ABORTED
      code === 13 || // INTERNAL
      code === 14;   // UNAVAILABLE

    if (retryable && error.failedAttempts < 3) return true;

    logger.error("BulkWriter delete failed", { error: String(error) });
    return false;
  });

  try {
    while (true) {
      const snap = await jobsCol
        .where("updatedAtTs", "<", cutoffTs)
        .orderBy("updatedAtTs", "asc")
        .limit(CLEANUP_QUERY_LIMIT)
        .get();

      if (snap.empty) break;

      for (const docSnap of snap.docs) {
        bulkWriter.delete(docSnap.ref);
      }

      deleted += snap.size;

      await runRef.set(
        {
          updatedAt: FieldValue.serverTimestamp(),
          deleted,
        },
        { merge: true }
      );

      if (snap.size < CLEANUP_QUERY_LIMIT) break;
    }

    await bulkWriter.close();

    const durationMs = Date.now() - startedAtMs;

    await runRef.set(
      {
        status: "done",
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        durationMs,
        deleted,
      },
      { merge: true }
    );

    return { runId, deleted, durationMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await runRef.set(
      {
        status: "failed",
        finishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        error: msg,
      },
      { merge: true }
    );
    throw err;
  }
}

// ------------------------ TASK BODY (NO perFeedSummary / NO errorSamples) ------------------------
async function processUserFeeds(uid, runType, runId) {
  const startedAtMs = Date.now();
  const feeds = await loadUserFeeds(uid);
  const runRef = fetchRunRef(uid, runId);

  let processedTotal = 0;
  let newTotal = 0;
  let errorsCount = 0;

  await runRef.set(
    {
      runType,
      status: "running",
      startedAt: FieldValue.serverTimestamp(),
      feedsCount: feeds.length,
      updatedAt: FieldValue.serverTimestamp(),
      processed: 0,
      newCount: 0,
      errorsCount: 0,
    },
    { merge: true }
  );

  let heartbeatTimer = null;
  const writeHeartbeat = async () => {
    await runRef.set(
      {
        updatedAt: FieldValue.serverTimestamp(),
        processed: processedTotal,
        newCount: newTotal,
        errorsCount,
      },
      { merge: true }
    );
  };

  heartbeatTimer = setInterval(() => {
    writeHeartbeat().catch((e) => logger.warn("heartbeat write failed", { runId, error: String(e?.message || e) }));
  }, HEARTBEAT_EVERY_MS);

  const bulkWriter = db.bulkWriter();
  bulkWriter.onWriteError((error) => {
    const code = error?.code;
    const retryable =
      code === 4 ||  // DEADLINE_EXCEEDED
      code === 8 ||  // RESOURCE_EXHAUSTED
      code === 10 || // ABORTED
      code === 13 || // INTERNAL
      code === 14;   // UNAVAILABLE

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
            newTotal += summary.newCount;
          } catch (err) {
            errorsCount += 1;
            logger.warn("feed failed", { uid, url: feed.url, error: String(err?.message || err) });
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
        newCount: newTotal,
        errorsCount,
      },
      { merge: true }
    );

    return {
      runId,
      feedsCount: feeds.length,
      processed: processedTotal,
      newCount: newTotal,
      durationMs,
      errorsCount,
    };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

// ------------------------ CLOUD FUNCTIONS ------------------------

exports.pollNowV2 = onCall({ region: REGION }, async (req) => {
  if (!req.auth?.uid) throw new HttpsError("unauthenticated", "You must be signed in.");

  try {
    return await enqueueUserRun(req.auth.uid, "manual");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpsError("internal", msg);
  }
});

exports.purgeOldJobsNowV2 = onCall({ region: REGION }, async (req) => {
  if (!req.auth?.uid) throw new HttpsError("unauthenticated", "You must be signed in.");

  try {
    return await enqueueUserCleanup(req.auth.uid, "cleanup");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpsError("internal", msg);
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
          const uid = u.id;
          try {
            await enqueueUserRun(uid, "scheduled");
          } catch (err) {
            logger.error("scheduled enqueue failed", { uid, error: String(err?.message || err) });
          }
        })
      )
    );

    return null;
  }
);

// Optional: daily cleanup for all users (03:15am LA)
exports.purgeOldJobsDailyV2 = onSchedule(
  { region: REGION, schedule: "15 3 * * *", timeZone: TIME_ZONE },
  async () => {
    const usersSnap = await db.collection("users").get();
    logger.info("cleanup scheduler tick", { users: usersSnap.size, schedule: "15 3 * * *", tz: TIME_ZONE });

    const limitEnq = pLimit(50);

    await Promise.all(
      usersSnap.docs.map((u) =>
        limitEnq(async () => {
          const uid = u.id;
          try {
            await enqueueUserCleanup(uid, "cleanup_scheduled");
          } catch (err) {
            logger.error("scheduled cleanup enqueue failed", { uid, error: String(err?.message || err) });
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

      await fetchRunRef(uid, runId).set(
        {
          status: "failed",
          updatedAt: FieldValue.serverTimestamp(),
          finishedAt: FieldValue.serverTimestamp(),
          error: msg,
        },
        { merge: true }
      );

      logger.error("task failed", { uid, runType, runId, error: msg });
      throw err;
    }
  }
);

exports.purgeUserOldJobsTaskV2 = onTaskDispatched(
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

    logger.info("cleanup task start", { uid, runType, runId });

    try {
      await purgeOldJobsForUser(uid, runType || "cleanup", runId);
      logger.info("cleanup task done", { uid, runType, runId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      await fetchRunRef(uid, runId).set(
        {
          status: "failed",
          updatedAt: FieldValue.serverTimestamp(),
          finishedAt: FieldValue.serverTimestamp(),
          error: msg,
        },
        { merge: true }
      );

      logger.error("cleanup task failed", { uid, runType, runId, error: msg });
      throw err;
    }
  }
);
