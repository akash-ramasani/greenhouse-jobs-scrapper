/* eslint-disable max-len */
/**
 * functions/index.js (Node 20, Firebase Functions Gen2)
 *
 * ✅ What this version does (per your request)
 * - NO perFeedSummary
 * - NO errorSamples
 * - fetchRuns will still track:
 *   - runType (manual/scheduled)
 *   - status (enqueued/enqueue_failed/running/done/done_with_errors/failed)
 *   - feedsCount
 *   - processed
 *   - newCount
 *   - durationMs
 *   - createdAt / enqueuedAt / startedAt / finishedAt / updatedAt
 *   - errorsCount (number only)
 *   - error (string only on fatal task failure)
 *
 * ✅ Scale fixes
 * - Removes per-job Firestore reads (no doc.get) => reads won't explode
 * - Uses Firestore BulkWriter for fast writes
 * - Retries + longer timeouts for slow Greenhouse boards
 * - Manual and Scheduled BOTH enqueue a task and BOTH create fetchRuns docs
 *
 * ✅ Content fields
 * - Removes contentPlain, contentSections
 * - Keeps ONLY contentHtmlClean
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

function shouldKeepJobByLocation(locationName) {
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

// ------------------------ TIME ------------------------
function parseUpdatedAtIso(jobRaw) {
  const iso = jobRaw?.updated_at || jobRaw?.first_published || null;
  if (!iso) return new Date().toISOString();
  return iso;
}

function isoToTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Timestamp.now();
  return Timestamp.fromDate(d);
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
          "user-agent": "greenhouse-jobs-scraper/3.2",
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

// ------------------------ JOB KEY / NORMALIZATION ------------------------
function jobDocId(companyKey, jobId) {
  return `${companyKey}__${jobId}`;
}

function feedCompanyKey(feed) {
  try {
    const u = new URL(feed.url);
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("boards");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1].toLowerCase();
  } catch {}
  return feed.id;
}

function resolveCompanyName(feed, jobRaw) {
  const fromFeed = (feed?.name || "").trim();
  if (fromFeed) return fromFeed;

  const fromJob = (jobRaw?.company_name || "").trim();
  if (fromJob) return fromJob;

  return feedCompanyKey(feed) || "Unknown";
}

function normalizeJob(uid, feed, jobRaw) {
  const locationName = jobRaw?.location?.name || "";
  const updatedAtIso = parseUpdatedAtIso(jobRaw);
  const updatedAtTs = isoToTimestamp(updatedAtIso);

  const { metadataKV, metadataList } = normalizeMetadata(jobRaw.metadata);
  const contentHtmlClean = normalizeContentHtmlClean(jobRaw.content || "");

  const isRemote = isRemoteLocation(locationName) || (!locationName && true);
  const stateCodes = extractStateCodes(locationName);

  const companyKey = feedCompanyKey(feed);

  return {
    uid,
    companyKey,
    companyName: resolveCompanyName(feed, jobRaw),

    locationName: locationName || "Remote",
    absolute_url: jobRaw.absolute_url || null,
    title: jobRaw.title || null,

    updatedAtIso,
    updatedAtTs,

    stateCodes,
    isRemote,

    jobId: jobRaw.id,
    internalJobId: jobRaw.internal_job_id ?? jobRaw.internalJobId ?? null,
    requisitionId: jobRaw.requisition_id ?? null,
    language: jobRaw.language || null,
    firstPublishedIso: jobRaw.first_published || null,

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

async function processOneFeed(uid, feed, bulkWriter) {
  const json = await fetchJson(feed.url);
  const jobs = Array.isArray(json.jobs) ? json.jobs : [];

  const inferredCompanyName = (jobs.find((j) => (j?.company_name || "").trim())?.company_name || "").trim();

  const kept = [];
  for (const j of jobs) {
    const loc = j?.location?.name;
    if (!loc || shouldKeepJobByLocation(loc)) kept.push(j);
  }

  const companyKey = feedCompanyKey(feed);
  const jobsCol = db.collection("users").doc(uid).collection("jobs");
  const limitWrite = pLimit(JOB_WRITE_CONCURRENCY);

  const createdFlags = await Promise.all(
    kept.map((jobRaw) =>
      limitWrite(async () => {
        const normalized = normalizeJob(uid, feed, jobRaw);
        const docId = jobDocId(companyKey, jobRaw.id);
        return await upsertJobNoRead(bulkWriter, jobsCol, docId, normalized);
      })
    )
  );

  const newCount = createdFlags.reduce((a, b) => a + b, 0);

  await upsertCompanyDoc(uid, feed, inferredCompanyName);

  return {
    processed: kept.length,
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

  // Heartbeat: keeps UI updated while running
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
    // Manual now also uses task queue so it ALWAYS writes fetchRuns and behaves like scheduled.
    return await enqueueUserRun(req.auth.uid, "manual");
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
