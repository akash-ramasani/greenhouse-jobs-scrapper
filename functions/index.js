/* eslint-disable max-len */
/**
 * functions/index.js (Node 20, Firebase Functions Gen2)
 *
 * ✅ Greenhouse + AshbyHQ feeds
 * ✅ Writes ONLY jobs from last 1 hour (based on feed JSON timestamps)
 * ✅ Counts "createdCount" = jobs actually added (doc created)
 * ✅ Stores "errorSamples" (urls + messages) in fetchRuns for UI
 * ✅ No Firestore reads per job
 * ✅ 21-day retention cleanup (daily)
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

const FEED_CONCURRENCY = 3;
const JOB_WRITE_CONCURRENCY = 25;

const SCHEDULE = "*/30 * * * *";
const TIME_ZONE = "America/Los_Angeles";

const FETCH_TIMEOUT_MS = 60_000;
const FETCH_RETRIES = 2;
const FETCH_RETRY_BASE_DELAY_MS = 800;

const MAX_HTML_CHARS = 120_000;

const UPDATE_WINDOW_MS = 60 * 60 * 1000; // ✅ last 1 hour
const RETENTION_WINDOW_MS = 21 * 24 * 60 * 60 * 1000; // ✅ keep 21 days

const CLEANUP_QUERY_LIMIT = 400;

// Save only a few error samples for UI
const MAX_ERROR_SAMPLES = 10;

// If you want "remote anywhere worldwide", set this to [].
const REMOTE_EXCLUDE_SUBSTRINGS = [/* ... keep your existing array ... */];

// ---------------- US Location Filtering ----------------
const US_STATE_CODES = [/* ... keep your existing array ... */];
const US_KEYWORDS = [/* ... keep your existing array ... */];
const MAJOR_US_CITIES = [/* ... keep your existing array ... */];

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
function parseIsoToMs(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function isJobWithinUpdateWindow(source, jobRaw, nowMs = Date.now()) {
  const cutoffMs = nowMs - UPDATE_WINDOW_MS;

  if (source === "greenhouse") {
    const updatedMs = parseIsoToMs(jobRaw?.updated_at);
    if (updatedMs != null) return updatedMs >= cutoffMs;

    // Optional fallback (if updated_at missing)
    const firstPubMs = parseIsoToMs(jobRaw?.first_published);
    return firstPubMs != null && firstPubMs >= cutoffMs;
  }

  if (source === "ashby") {
    const pubMs = parseIsoToMs(jobRaw?.publishedAt);
    return pubMs != null && pubMs >= cutoffMs;
  }

  return false;
}

function isoToTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Timestamp.now();
  return Timestamp.fromDate(d);
}

function cutoffTimestampRetentionNow() {
  const cutoffMs = Date.now() - RETENTION_WINDOW_MS;
  return Timestamp.fromDate(new Date(cutoffMs));
}

function parseUpdatedAtIso(jobRaw) {
  if (jobRaw?.updated_at) return jobRaw.updated_at;
  if (jobRaw?.first_published) return jobRaw.first_published;
  if (jobRaw?.publishedAt) return jobRaw.publishedAt;
  return new Date().toISOString();
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
          "user-agent": "jobs-aggregator/6.0",
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

function isAlreadyExistsError(e) {
  const code = e?.code;
  if (code === 6) return true; // ALREADY_EXISTS
  const msg = String(e?.message || "");
  return msg.includes("ALREADY_EXISTS") || msg.includes("already exists");
}

/**
 * ✅ Create-only write:
 * - If create succeeds => counts as "added to database"
 * - If already exists => ignore (no update), counts 0
 * - NO reads
 */
async function createJobIfNew(bulkWriter, jobsColRef, docId, normalized) {
  const ref = jobsColRef.doc(docId);
  try {
    await bulkWriter.create(ref, {
      ...normalized,
      createdAt: FieldValue.serverTimestamp(),
      firstSeenAt: FieldValue.serverTimestamp(),
    });
    return 1;
  } catch (e) {
    if (isAlreadyExistsError(e)) return 0;
    throw e;
  }
}

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

  const createdFlags = await Promise.all(
    keptRaw.map((jobRaw) =>
      limitWrite(async () => {
        const ghLike = toGreenhouseLikeJob(source, jobRaw);
        const normalized = normalizeJob(uid, feed, ghLike, source);
        const docId = jobDocId(companyKey, ghLike.id);
        return await createJobIfNew(bulkWriter, jobsCol, docId, normalized);
      })
    )
  );

  const createdCount = createdFlags.reduce((a, b) => a + b, 0);

  // optional: only update company doc if this feed produced relevant jobs
  if (keptRaw.length > 0) {
    await upsertCompanyDoc(uid, feed);
  }

  return {
    processed: keptRaw.length,
    createdCount,
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
  if (!projectId) throw new Error("Missing project ID env var (GCLOUD_PROJECT/GCP_PROJECT/PROJECT_ID).");
  return `https://${REGION}-${projectId}.cloudfunctions.net/${functionName}`;
}

// ------------------------ ENQUEUE ------------------------
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

async function enqueueUserCleanup(uid, runType) {
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

// ------------------------ MAIN USER TASK ------------------------
async function processUserFeeds(uid, runType, runId) {
  const startedAtMs = Date.now();
  const feeds = await loadUserFeeds(uid);
  const runRef = fetchRunRef(uid, runId);

  let processedTotal = 0;
  let createdTotal = 0;
  let errorsCount = 0;
  const errorSamples = [];

  await runRef.set(
    {
      runType,
      status: "running",
      startedAt: FieldValue.serverTimestamp(),
      feedsCount: feeds.length,
      updatedAt: FieldValue.serverTimestamp(),
      processed: 0,
      createdCount: 0,
      errorsCount: 0,
    },
    { merge: true }
  );

  const bulkWriter = db.bulkWriter();
  bulkWriter.onWriteError((error) => {
    const code = error?.code;
    const retryable =
      code === 4 || code === 8 || code === 10 || code === 13 || code === 14;

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
          } catch (err) {
            errorsCount += 1;
            const msg = String(err?.message || err);
            logger.warn("feed failed", { uid, url: feed.url, error: msg });

            if (errorSamples.length < MAX_ERROR_SAMPLES) {
              errorSamples.push({ url: feed.url, error: msg });
            }
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
        errorsCount,
        errorSamples,
      },
      { merge: true }
    );

    return { processedTotal, createdTotal, errorsCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    await runRef.set(
      {
        status: "failed",
        updatedAt: FieldValue.serverTimestamp(),
        finishedAt: FieldValue.serverTimestamp(),
        error: msg,
        errorSamples,
      },
      { merge: true }
    );

    throw err;
  }
}

// ------------------------ CLEANUP TASK ------------------------
async function purgeOldJobsForUser(uid, runType, runId) {
  const startedAtMs = Date.now();
  const runRef = fetchRunRef(uid, runId);

  const cutoffTs = cutoffTimestampRetentionNow();
  let deleted = 0;

  await runRef.set(
    {
      runType,
      status: "running",
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      cutoffUpdatedAtTs: cutoffTs,
      deleted: 0,
      errorsCount: 0,
    },
    { merge: true }
  );

  const jobsCol = db.collection("users").doc(uid).collection("jobs");

  const bulkWriter = db.bulkWriter();
  bulkWriter.onWriteError((error) => {
    const code = error?.code;
    const retryable =
      code === 4 || code === 8 || code === 10 || code === 13 || code === 14;

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

    return { deleted, durationMs };
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

// ------------------------ CLOUD FUNCTIONS ------------------------
exports.pollNowV2 = onCall({ region: REGION }, async (req) => {
  if (!req.auth?.uid) throw new HttpsError("unauthenticated", "You must be signed in.");
  try {
    return await enqueueUserRun(req.auth.uid, "manual");
  } catch (err) {
    throw new HttpsError("internal", err instanceof Error ? err.message : String(err));
  }
});

exports.purgeOldJobsNowV2 = onCall({ region: REGION }, async (req) => {
  if (!req.auth?.uid) throw new HttpsError("unauthenticated", "You must be signed in.");
  try {
    return await enqueueUserCleanup(req.auth.uid, "cleanup_manual");
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

exports.purgeOldJobsDailyV2 = onSchedule(
  { region: REGION, schedule: "15 3 * * *", timeZone: TIME_ZONE },
  async () => {
    const usersSnap = await db.collection("users").get();
    logger.info("cleanup scheduler tick", { users: usersSnap.size });

    const limitEnq = pLimit(50);

    await Promise.all(
      usersSnap.docs.map((u) =>
        limitEnq(async () => {
          try {
            await enqueueUserCleanup(u.id, "cleanup_scheduled");
          } catch (err) {
            logger.error("scheduled cleanup enqueue failed", { uid: u.id, error: String(err?.message || err) });
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
