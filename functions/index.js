/* eslint-disable max-len */
/**
 * functions/index.js (Node 20, Firebase Functions Gen2)
 *
 * - Polls Greenhouse feeds stored per-user: users/{uid}/feeds/{feedId} -> { company/name, url, active:true }
 * - Saves jobs: users/{uid}/jobs/{companyKey}__{jobId}
 * - Writes fetch history: users/{uid}/fetchRuns/{runId}
 * - Writes companies list for UI: users/{uid}/companies/{companyKey}
 *
 * Writes:
 * - updatedAtTs (Timestamp)  <-- required for proper sorting + timeframe query
 * - stateCodes (array)       <-- required for multi-state filtering
 * - perFeedSummary (array)   <-- for FetchHistory UI
 *
 * IMPORTANT UPDATE IN THIS VERSION:
 * - Scheduled poll now ALWAYS writes a fetchRuns doc per user with status:
 *   - "enqueued" (task enqueued successfully)
 *   - "enqueue_failed" (enqueue failed)
 *   - then task updates that SAME run doc to "running" and later "done"/"done_with_errors"
 *
 * This means you will see fetchRuns even if the task never executes.
 */

const admin = require("firebase-admin");
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
const FEED_CONCURRENCY = 8;       // safe for ~350 feeds
const JOB_WRITE_CONCURRENCY = 25; // safe for job upserts

// If you want strict 30-minute cadence anchored to the clock, use cron:
const SCHEDULE = "*/30 * * * *";
const TIME_ZONE = "America/Los_Angeles";

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

  // include bullets and dashes and pipes
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

  // Always keep explicit US-Remote
  if (s.includes("us-remote") || s.includes("remote us") || s.includes("remote - us")) return true;

  // Exclude obvious non-US-only remote (optional)
  for (const bad of REMOTE_EXCLUDE_SUBSTRINGS) {
    if (s.includes(bad)) return false;
  }

  return true;
}

function shouldKeepJobByLocation(locationName) {
  return isUSLocation(locationName) || isRemoteLocation(locationName);
}

// ---------- State extraction for server-side multi-state filtering ----------
function extractStateCodes(locationText) {
  if (!locationText) return [];
  const text = String(locationText).toUpperCase();

  const codes = new Set();

  // DC special cases
  if (
    text.includes("WASHINGTON, D.C") ||
    text.includes("WASHINGTON D.C") ||
    text.includes("WASHINGTON DC")
  ) {
    codes.add("DC");
  }

  // Two-letter tokens
  const tokens = text.match(/\b[A-Z]{2}\b/g) || [];
  for (const t of tokens) {
    if (US_STATE_CODES.includes(t)) codes.add(t);
  }

  return Array.from(codes);
}

function parseUpdatedAtIso(jobRaw) {
  const iso = jobRaw.updated_at || jobRaw.first_published || null;
  if (!iso) return new Date().toISOString();
  return iso;
}

function isoToTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Timestamp.now();
  return Timestamp.fromDate(d);
}

// ------------------------ HTTP / FETCH ------------------------
async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent": "greenhouse-jobs-scraper/1.0",
      "accept": "application/json",
    },
  });
  if (!res.ok) {
    const body = await safeReadText(res);
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${body?.slice(0, 300) || ""}`);
  }
  return res.json();
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
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

function stripTags(html) {
  if (!html) return "";
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeTracking(html) {
  if (!html) return "";
  let s = String(html);

  // Remove all img tags (pixels + images)
  s = s.replace(/<img\b[^>]*>/gi, " ");

  // Remove tracker link anchors but keep anchor text
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

/**
 * Extract sections using headings in HTML (h1-h4).
 * Returns: [{ title, text }]
 */
function extractSectionsFromHtml(htmlDecoded) {
  if (!htmlDecoded) return [];
  const html = String(htmlDecoded);

  const headingRe = /<(h1|h2|h3|h4)[^>]*>([\s\S]*?)<\/\1>/gi;
  const matches = [];
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    matches.push({ idx: m.index, titleHtml: m[2] });
  }
  if (!matches.length) return [];

  const sections = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : html.length;
    const chunk = html.slice(start, end);

    const title = stripTags(matches[i].titleHtml);

    // remove first heading in chunk
    let removedFirst = false;
    const bodyHtml = chunk.replace(headingRe, (full) => {
      if (removedFirst) return full;
      removedFirst = true;
      return "";
    });

    const bodyText = stripTags(bodyHtml);
    if (title && bodyText.trim()) sections.push({ title, text: bodyText });
  }

  return sections;
}

function normalizeContent(rawContent) {
  const decoded = decodeHtmlEntities(rawContent || "");
  const noTrack = removeTracking(decoded);
  const sections = extractSectionsFromHtml(noTrack);
  const plain = stripTags(noTrack);

  return {
    contentHtmlClean: noTrack,
    contentPlain: plain,
    contentSections: sections,
  };
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
      normalizedValue = {
        unit,
        amount: Number.isFinite(amountNum) ? amountNum : amountStr,
      };
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

// Key derived from Greenhouse URL: /v1/boards/{slug}/jobs
function feedCompanyKey(feed) {
  try {
    const u = new URL(feed.url);
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("boards");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1].toLowerCase();
  } catch {}
  return feed.id;
}

// Helper: best-effort company name from (1) feed.name (2) job payload (3) fallback
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
  const content = normalizeContent(jobRaw.content || "");

  const isRemote = isRemoteLocation(locationName) || (!locationName && true);
  const stateCodes = extractStateCodes(locationName);

  const companyKey = feedCompanyKey(feed);

  return {
    uid,

    // IMPORTANT: use stable slug key instead of firestore feed doc id
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

    contentPlain: content.contentPlain,
    contentSections: content.contentSections,
    contentHtmlClean: content.contentHtmlClean,

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

      // IMPORTANT: your feed docs use "company" (client), not "name"
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

async function processOneFeed(uid, feed) {
  const json = await fetchJson(feed.url);
  const jobs = Array.isArray(json.jobs) ? json.jobs : [];

  const inferredCompanyName = (jobs.find((j) => (j?.company_name || "").trim())?.company_name || "").trim();

  // Filter to US/Remote
  const kept = [];
  for (const j of jobs) {
    const loc = j?.location?.name || "";
    if (shouldKeepJobByLocation(loc)) kept.push(j);
  }

  const companyKey = feedCompanyKey(feed);
  const jobsCol = db.collection("users").doc(uid).collection("jobs");
  const limitWrite = pLimit(JOB_WRITE_CONCURRENCY);

  let newCount = 0;

  await Promise.all(
    kept.map((jobRaw) =>
      limitWrite(async () => {
        const docId = jobDocId(companyKey, jobRaw.id);
        const ref = jobsCol.doc(docId);

        const normalized = normalizeJob(uid, feed, jobRaw);

        const snap = await ref.get();
        if (!snap.exists) {
          newCount += 1;
          await ref.set(
            {
              ...normalized,
              createdAt: FieldValue.serverTimestamp(),
              firstSeenAt: FieldValue.serverTimestamp(),
              saved: false,
            },
            { merge: false }
          );
        } else {
          const prev = snap.data() || {};
          await ref.set(
            {
              ...normalized,
              createdAt: prev.createdAt || FieldValue.serverTimestamp(),
              firstSeenAt: prev.firstSeenAt || FieldValue.serverTimestamp(),
              saved: prev.saved === true,
            },
            { merge: true }
          );
        }
      })
    )
  );

  await upsertCompanyDoc(uid, feed, inferredCompanyName);

  return {
    feedId: companyKey, // IMPORTANT: store stable key in history
    companyName: (feed.name || inferredCompanyName || companyKey),
    fetchedCount: jobs.length,
    keptCount: kept.length,
    newCount,
    url: feed.url,
  };
}

// ------------------------ FETCH RUN HELPERS ------------------------
function fetchRunRef(uid, runId) {
  return db.collection("users").doc(uid).collection("fetchRuns").doc(runId);
}

/**
 * Creates a run doc and returns { runId, ref }.
 * This is used by the scheduler so you always see fetchRuns even if tasks never execute.
 */
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

/**
 * processUserFeeds now supports reusing an existing runId doc.
 * - If runId provided, it updates that run doc to "running" and proceeds.
 * - If no runId, it creates a new run doc (manual calls).
 */
async function processUserFeeds(uid, runType, runId = null) {
  const startedAtMs = Date.now();

  const feeds = await loadUserFeeds(uid);

  let runRef;
  if (runId) {
    runRef = fetchRunRef(uid, runId);
    // Mark as running (even if it was "enqueued")
    await runRef.set(
      {
        runType,
        status: "running",
        startedAt: FieldValue.serverTimestamp(),
        feedsCount: feeds.length,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    runRef = db.collection("users").doc(uid).collection("fetchRuns").doc();
    await runRef.set({
      runType,
      status: "running",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      startedAt: FieldValue.serverTimestamp(),
      feedsCount: feeds.length,
    });
    runId = runRef.id;
  }

  const limitFeed = pLimit(FEED_CONCURRENCY);

  const perFeedSummary = [];
  const errorSamples = [];
  let processedTotal = 0;
  let newTotal = 0;

  await Promise.all(
    feeds.map((feed) =>
      limitFeed(async () => {
        try {
          const summary = await processOneFeed(uid, feed);
          processedTotal += summary.keptCount;
          newTotal += summary.newCount;

          perFeedSummary.push({
            feedId: summary.feedId,
            companyName: summary.companyName,
            url: summary.url,
            fetched: summary.fetchedCount,
            kept: summary.keptCount,
            newCount: summary.newCount,
            ok: true,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errorSamples.push({ url: feed.url, message: msg });

          perFeedSummary.push({
            feedId: feedCompanyKey(feed),
            companyName: feed.name || feedCompanyKey(feed),
            url: feed.url,
            fetched: 0,
            kept: 0,
            newCount: 0,
            ok: false,
            error: msg,
          });
        }
      })
    )
  );

  const durationMs = Date.now() - startedAtMs;

  await runRef.set(
    {
      status: errorSamples.length ? "done_with_errors" : "done",
      finishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      durationMs,
      processed: processedTotal,
      newCount: newTotal,
      errorsCount: errorSamples.length,
      errorSamples: errorSamples.slice(0, 10),
      perFeedSummary: perFeedSummary.sort((a, b) => (b.kept || 0) - (a.kept || 0)),
    },
    { merge: true }
  );

  return {
    runId,
    feedsCount: feeds.length,
    processed: processedTotal,
    newCount: newTotal,
    durationMs,
    errorsCount: errorSamples.length,
  };
}

// ------------------------ FUNCTIONS ------------------------

exports.pollNowV2 = onCall({ region: REGION }, async (req) => {
  if (!req.auth?.uid) throw new HttpsError("unauthenticated", "You must be signed in.");

  try {
    const result = await processUserFeeds(req.auth.uid, "manual");
    return { ok: true, ...result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpsError("internal", msg);
  }
});

/**
 * Scheduled poll: creates a fetchRuns doc per user (status=enqueued or enqueue_failed),
 * then enqueues a task that will update the SAME run doc to running/done.
 */
exports.pollGreenhouseFeedsV2 = onSchedule(
  { region: REGION, schedule: SCHEDULE, timeZone: TIME_ZONE },
  async () => {
    const usersSnap = await db.collection("users").get();
    logger.info("scheduler tick", { users: usersSnap.size, schedule: SCHEDULE, tz: TIME_ZONE });

    const queue = admin.app().functions().taskQueue("pollUserTaskV2");
    const limitEnq = pLimit(50);

    await Promise.all(
      usersSnap.docs.map((u) =>
        limitEnq(async () => {
          const uid = u.id;

          // Write fetchRuns immediately so UI shows scheduled activity even if task never runs.
          const { runId, ref } = await createFetchRun(uid, "scheduled", "enqueued", {
            enqueuedAt: FieldValue.serverTimestamp(),
          });

          try {
            await queue.enqueue({ uid, runType: "scheduled", runId });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            // Mark enqueue failure on the run doc
            await ref.set(
              {
                status: "enqueue_failed",
                updatedAt: FieldValue.serverTimestamp(),
                enqueueError: msg,
              },
              { merge: true }
            );

            logger.error("enqueue failed", { uid, runId, error: msg });
          }
        })
      )
    );

    return null;
  }
);

/**
 * Task handler: polls feeds for a single user
 * - Expects { uid, runType, runId }
 */
exports.pollUserTaskV2 = onTaskDispatched(
  {
    region: REGION,
    rateLimits: { maxConcurrentDispatches: 10 },
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 },
  },
  async (req) => {
    const { uid, runType, runId } = req.data || {};
    if (!uid) return;

    logger.info("task start", { uid, runType, runId });

    try {
      await processUserFeeds(uid, runType || "scheduled", runId || null);
      logger.info("task done", { uid, runType, runId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // If we have a runId, mark it as failed so it shows in the UI
      if (runId) {
        await fetchRunRef(uid, runId).set(
          {
            status: "failed",
            updatedAt: FieldValue.serverTimestamp(),
            finishedAt: FieldValue.serverTimestamp(),
            error: msg,
          },
          { merge: true }
        );
      }

      logger.error("task failed", { uid, runType, runId, error: msg });

      // Re-throw so Cloud Tasks retryConfig actually retries
      throw err;
    }
  }
);
