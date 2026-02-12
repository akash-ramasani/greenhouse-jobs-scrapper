/**
 * functions/index.js (Firebase Cloud Functions Gen2, Node 20)
 *
 * ✅ Hourly scheduler:
 * - Runs every 60 minutes
 * - Reads active feeds
 * - Fetches jobs
 * - Filters by locations (US cities/states + Remote-US strings)
 * - ONLY writes jobs updated within last 65 minutes
 * - Sets TTL field: expireAt = sourceUpdatedTs + 3 days
 *
 * ✅ Manual HTTP trigger:
 * - runSyncNow?userId=... forces a run and returns summary
 *
 * ✅ Run summary saved to Firestore:
 * - users/{uid}/syncRuns/{runId}
 *
 * ⚠️ Firestore TTL must be enabled on field "expireAt" for collection group "jobs"
 */

/* eslint-disable max-len */
/* eslint-disable require-jsdoc */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

// ✅ p-limit CommonJS import fix
const pLimitPkg = require("p-limit");
const pLimit = pLimitPkg.default ?? pLimitPkg;

// ✅ Admin init
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

/**
 * ----------------------------
 * CONFIG
 * ----------------------------
 */
const REGION = "us-central1";
const FEED_CONCURRENCY = 15;

const RECENT_WINDOW_MINUTES = 65; // only write jobs updated within last 65 mins
const TTL_DAYS = 3;               // TTL expiration window (3 days)

const ONLY_USER_ID = process.env.ONLY_USER_ID || "";


/**
 * ----------------------------
 * LOCATION FILTER CONSTANTS
 * ----------------------------
 */

// 1) US States (full names)
const US_STATES = [
  "Alabama","Arizona","Arkansas","California","Colorado","Connecticut","District of Columbia","Florida","Georgia",
  "Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maryland","Massachusetts","Michigan","Minnesota",
  "Missouri","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","Oklahoma",
  "Pennsylvania","Rhode Island","Tennessee","Texas","Utah","Virginia","Washington","Wisconsin",
];

// 2) US State abbreviations
const US_STATE_ABBREVIATIONS = [
  "AL","AZ","AR","CA","CO","CT","DC","FL","GA","ID","IL","IN","IA","KS","KY","LA",
  "MD","MA","MI","MN","MO","NE","NV","NH","NJ","NM","NY","NC","OK","PA","RI","TN",
  "TX","UT","VA","WA","WI",
];

// 3) US Cities
const US_CITIES = [
  "Albuquerque","Anaheim","Ann Arbor","Arlington","Atlanta","Austin","Bakersfield","Baltimore","Baton Rouge","Bellevue",
  "Birmingham","Boise","Boston","Boulder","Brooklyn","Buffalo","Burbank","Cambridge","Charlotte","Chicago","Cincinnati",
  "Cleveland","Colorado Springs","Columbus","Dallas","Dayton","Denver","Des Moines","Detroit","Durham","El Paso",
  "Fort Collins","Fort Lauderdale","Fort Myers","Fort Worth","Fresno","Grand Rapids","Greensboro","Greenville",
  "Hartford","Henderson","Hoboken","Houston","Huntsville","Indianapolis","Irvine","Jacksonville","Jersey City",
  "Kansas City","Las Vegas","Lincoln","Little Rock","Long Beach","Los Angeles","Louisville","Madison","Memphis","Mesa",
  "Miami","Milwaukee","Minneapolis","Mountain View","Nashville","Naples","New Haven","New Orleans","New York","Newark",
  "Norfolk","Oakland","Oklahoma City","Omaha","Orlando","Palo Alto","Panama City","Pensacola","Philadelphia","Phoenix",
  "Pittsburgh","Plano","Portland","Providence","Provo","Raleigh","Redmond","Reston","Richmond","Riverside","Rochester",
  "Round Rock","Sacramento","Salt Lake City","San Antonio","San Diego","San Francisco","San Jose","San Mateo","Santa Ana",
  "Santa Clara","Santa Fe","Sarasota","Scottsdale","Seattle","Silver Spring","Spokane","St. Louis","St. Paul",
  "St. Petersburg","Sugar Land","Sunnyvale","Syracuse","Tallahassee","Tampa","Tempe","The Woodlands","Tucson","Tulsa",
  "Tysons","Virginia Beach","Washington","West Palm Beach","Wichita",
];

// 4) Remote-only (USA-specific) strings
const REMOTE_US_ONLY = [
  "US-Remote","US Remote","US (Remote)","United States - Remote","Remote US","Remote USA","Remote-USA",
  "Remote in United States","Remote in the US","Remote - USA","Remote - US: All locations","Remote - US: Select locations",
  "Anywhere in the United States",
];

const NORM = {
  states: new Set(US_STATES.map((s) => normalizeText(s))),
  cities: new Set(US_CITIES.map((s) => normalizeText(s))),
  remote: new Set(REMOTE_US_ONLY.map((s) => normalizeText(s))),
  abbr: new Set(US_STATE_ABBREVIATIONS.map((s) => s.toUpperCase())),
};

const LOCATION_SPLIT_REGEX = /[;|/]+|(?:\s*,\s*)/g;

/**
 * =====================================================================================
 * 1) SCHEDULED: Every 1 hour sync
 * =====================================================================================
 */
exports.syncRecentJobsHourly = onSchedule(
  {
    region: REGION,
    schedule: "every 60 minutes",
    timeZone: "America/Los_Angeles",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const recentCutoff = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - RECENT_WINDOW_MINUTES * 60 * 1000)
    );

    logger.info(`syncRecentJobsHourly start recentCutoff=${recentCutoff.toDate().toISOString()}`);

    const userIds = await listUserIdsToProcess();
    logger.info(`Users to process: ${userIds.length}`);

    for (const userId of userIds) {
      try {
        const summary = await syncUserRecentJobs({ userId, now, recentCutoff });
        await writeRunSummary({
          userId,
          source: "syncRecentJobsHourly",
          now,
          recentCutoff,
          summary,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`User sync failed userId=${userId}: ${msg}`);

        // still write a run summary for visibility
        await writeRunSummary({
          userId,
          source: "syncRecentJobsHourly",
          now,
          recentCutoff,
          summary: {
            ok: false,
            error: msg,
            feedsProcessed: 0,
            failedFeeds: 0,
            jobsFetched: 0,
            jobsKeptRecent: 0,
            jobsWritten: 0,
          },
        });
      }
    }

    logger.info("syncRecentJobsHourly done.");
  }
);

/**
 * =====================================================================================
 * 2) MANUAL HTTP: Run sync now for one user (debug endpoint)
 * =====================================================================================
 *
 * Trigger:
 * https://us-central1-<PROJECT_ID>.cloudfunctions.net/runSyncNow?userId=<UID>
 */
exports.runSyncNow = onRequest(
  { region: REGION, timeoutSeconds: 540, memory: "1GiB", cors: true },
  async (req, res) => {
    try {
      const userId = String(req.query.userId || "").trim();
      if (!userId) return res.status(400).json({ error: "Missing userId query param." });

      const now = admin.firestore.Timestamp.now();
      const recentCutoff = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() - RECENT_WINDOW_MINUTES * 60 * 1000)
      );

      const summary = await syncUserRecentJobs({ userId, now, recentCutoff });

      await writeRunSummary({
        userId,
        source: "runSyncNow",
        now,
        recentCutoff,
        summary,
      });

      // Return the style you requested (plus extra helpful fields)
      return res.json({
        ok: true,
        userId,
        dryRun: false,
        scanned: summary.jobsFetched,          // closest equivalent to your example
        updated: summary.jobsWritten,          // closest equivalent to your example
        ...summary,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("runSyncNow failed:", e);
      return res.status(500).json({ error: msg });
    }
  }
);

/**
 * ----------------------------
 * USER SYNC CORE
 * ----------------------------
 */
async function syncUserRecentJobs({ userId, now, recentCutoff }) {
  const feedsSnap = await db
    .collection("users")
    .doc(userId)
    .collection("feeds")
    .where("archivedAt", "==", null)
    .get();

  const feeds = feedsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (feeds.length === 0) {
    return {
      ok: true,
      feedsProcessed: 0,
      failedFeeds: 0,
      jobsFetched: 0,
      jobsKeptRecent: 0,
      jobsWritten: 0,
    };
  }

  const limiter = pLimit(FEED_CONCURRENCY);
  const bw = db.bulkWriter();

  // bulk writer error handling
  bw.onWriteError((err) => {
    logger.error("BulkWriter error:", err);
    return false;
  });

  let feedsProcessed = 0;
  let failedFeeds = 0;

  let jobsFetched = 0;
  let jobsKeptRecent = 0;
  let jobsWritten = 0;

  const tasks = feeds.map((feed) =>
    limiter(async () => {
      const feedId = feed.id;
      const feedRef = db.collection("users").doc(userId).collection("feeds").doc(feedId);

      try {
        const url = String(feed.url || "").trim();
        if (!url) throw new Error("Feed missing url");

        const source = String(feed.source || "").toLowerCase();
        const companyName = String(feed.companyName || feed.company || "Unknown");

        feedsProcessed += 1;

        // Upsert companies doc (for UI filter)
        const companyRef = db.collection("users").doc(userId).collection("companies").doc(feedId);
        bw.set(
          companyRef,
          {
            companyName,
            source,
            isActive: true,
            lastSeenAt: now,
            lastJobSyncAt: now,
          },
          { merge: true }
        );

        const rawJobs = await fetchJobsFromFeed(url, source);
        jobsFetched += rawJobs.length;

        const normalized = rawJobs
          .map((j) => normalizeJobMinimal(j, { source, companyName, companyKey: feedId, now }))
          .filter(Boolean);

        const locationFiltered = normalized.filter(jobMatchesLocationFilter);

        const recentOnly = locationFiltered.filter(
          (j) => j.sourceUpdatedTs && j.sourceUpdatedTs.toMillis() >= recentCutoff.toMillis()
        );

        jobsKeptRecent += recentOnly.length;

        for (const job of recentOnly) {
          const jobRef = db.collection("users").doc(userId).collection("jobs").doc(job.jobDocId);

          const baseTs = job.sourceUpdatedTs || now;
          const expireAt = addDaysTs(baseTs, TTL_DAYS);

          bw.set(
            jobRef,
            {
              ...job,
              fetchedAt: now,
              expireAt,
            },
            { merge: true }
          );

          jobsWritten += 1;
        }

        await feedRef.set(
          {
            lastCheckedAt: now,
            lastError: null,
            lastJobCount: recentOnly.length,
          },
          { merge: true }
        );
      } catch (e) {
        failedFeeds += 1;
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`Feed failed userId=${userId} feedId=${feed.id}: ${msg}`);

        await feedRef.set(
          {
            lastCheckedAt: now,
            lastError: msg,
          },
          { merge: true }
        );
      }
    })
  );

  await Promise.all(tasks);
  await bw.close();

  logger.info(
    `User synced userId=${userId} feedsProcessed=${feedsProcessed} failedFeeds=${failedFeeds} jobsFetched=${jobsFetched} keptRecent=${jobsKeptRecent} jobsWritten=${jobsWritten}`
  );

  return {
    ok: true,
    feedsProcessed,
    failedFeeds,
    jobsFetched,
    jobsKeptRecent,
    jobsWritten,
  };
}

/**
 * ----------------------------
 * WRITE RUN SUMMARY DOC
 * ----------------------------
 */
async function writeRunSummary({ userId, source, now, recentCutoff, summary }) {
  try {
    const runId = String(now.toMillis());
    const ref = db.collection("users").doc(userId).collection("syncRuns").doc(runId);

    const doc = {
      ok: Boolean(summary?.ok),
      userId,
      source,
      ranAt: now,
      recentCutoffIso: recentCutoff.toDate().toISOString(),

      // keep your preferred keys (meaningful mapping)
      dryRun: false,
      scanned: Number(summary?.jobsFetched || 0),
      updated: Number(summary?.jobsWritten || 0),

      // extra useful breakdown
      feedsProcessed: Number(summary?.feedsProcessed || 0),
      failedFeeds: Number(summary?.failedFeeds || 0),
      jobsFetched: Number(summary?.jobsFetched || 0),
      jobsKeptRecent: Number(summary?.jobsKeptRecent || 0),
      jobsWritten: Number(summary?.jobsWritten || 0),

      // optional error
      error: summary?.error || null,
    };

    await ref.set(doc, { merge: true });
  } catch (e) {
    logger.error(`writeRunSummary failed userId=${userId}:`, e);
  }
}

/**
 * ----------------------------
 * LIST USERS TO PROCESS
 * ----------------------------
 */
async function listUserIdsToProcess() {
  if (ONLY_USER_ID) return [ONLY_USER_ID];

  const users = [];
  let last = null;

  while (true) {
    let q = db.collection("users").orderBy(admin.firestore.FieldPath.documentId()).limit(500);
    if (last) q = q.startAfter(last);

    const snap = await q.get();
    if (snap.empty) break;

    for (const d of snap.docs) users.push(d.id);
    last = snap.docs[snap.docs.length - 1].id;
  }

  return users;
}

/**
 * ----------------------------
 * FETCHING
 * ----------------------------
 */
async function fetchJobsFromFeed(url, source) {
  const json = await fetchJson(url);

  if (source.includes("greenhouse")) {
    return Array.isArray(json?.jobs) ? json.jobs : [];
  }

  if (source.includes("ashby")) {
    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.jobs)) return json.jobs;
    if (Array.isArray(json?.results)) return json.results;
    if (Array.isArray(json?.data?.jobs)) return json.data.jobs;
    if (Array.isArray(json?.postings)) return json.postings;
    return [];
  }

  if (Array.isArray(json?.jobs)) return json.jobs;
  if (Array.isArray(json)) return json;
  return [];
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json,text/plain,*/*",
      "user-agent": "firebase-functions-job-sync/5.0",
    },
  });

  if (!resp.ok) {
    const body = await safeReadText(resp);
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}. Body: ${(body || "").slice(0, 400)}`);
  }

  return await resp.json();
}

async function safeReadText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/**
 * ----------------------------
 * NORMALIZATION (MINIMAL)
 * - contentHtml, isRemote, applyUrl removed
 * ----------------------------
 */
function normalizeJobMinimal(rawJob, ctx) {
  const { source, companyName, companyKey, now } = ctx;
  if (!rawJob || typeof rawJob !== "object") return null;

  if (source.includes("greenhouse")) {
    const externalId =
      rawJob.id != null ? String(rawJob.id)
        : (rawJob.internal_job_id != null ? String(rawJob.internal_job_id) : null);

    const jobUrl = rawJob.absolute_url ? String(rawJob.absolute_url) : null;
    if (!externalId && !jobUrl) return null;

    const title = rawJob.title ? String(rawJob.title) : null;
    const locationName = rawJob?.location?.name ? String(rawJob.location.name) : null;

    const sourceUpdatedIso = rawJob.updated_at ? String(rawJob.updated_at) : null;
    const sourceUpdatedTs = toTimestampOrNull(sourceUpdatedIso) || now;

    const locationTokens = extractLocationTokens(locationName || "");
    const stateCodes = extractStateCodes(locationTokens);

    const meta = simplifyMetadataArray(rawJob.metadata);

    const jobDocId = makeJobDocId({
      source: "greenhouse",
      companyKey,
      externalId: externalId || jobUrl,
    });

    return {
      jobDocId,
      source: "greenhouse",
      companyKey,
      companyName,
      externalId,
      title,
      jobUrl,
      locationName,
      locationTokens,
      stateCodes,
      sourceUpdatedTs,
      sourceUpdatedIso,
      meta,
    };
  }

  if (source.includes("ashby")) {
    const externalId =
      rawJob.id != null ? String(rawJob.id)
        : (rawJob.jobId != null ? String(rawJob.jobId) : null);

    const jobUrl = rawJob.jobUrl ? String(rawJob.jobUrl) : (rawJob.url ? String(rawJob.url) : null);
    if (!externalId && !jobUrl) return null;

    const title = rawJob.title ? String(rawJob.title) : null;

    const primaryLoc = rawJob.location ? String(rawJob.location) : null;
    const secondary = Array.isArray(rawJob.secondaryLocations)
      ? rawJob.secondaryLocations.filter(Boolean).map(String)
      : [];
    const combinedLocation = [primaryLoc, ...secondary].filter(Boolean).join("; ");

    const sourceUpdatedIso = rawJob.publishedAt ? String(rawJob.publishedAt) : null;
    const sourceUpdatedTs = toTimestampOrNull(sourceUpdatedIso) || now;

    const locationTokens = extractLocationTokens(combinedLocation || "");
    const stateCodes = extractStateCodes(locationTokens);

    const meta = {};
    if (rawJob.employmentType != null) meta["Employment Type"] = rawJob.employmentType;
    if (rawJob.department != null) meta["Department"] = rawJob.department;
    if (rawJob.team != null) meta["Team"] = rawJob.team;

    const jobDocId = makeJobDocId({
      source: "ashbyhq",
      companyKey,
      externalId: externalId || jobUrl,
    });

    return {
      jobDocId,
      source: "ashbyhq",
      companyKey,
      companyName,
      externalId,
      title,
      jobUrl,
      locationName: combinedLocation || primaryLoc || null,
      locationTokens,
      stateCodes,
      sourceUpdatedTs,
      sourceUpdatedIso,
      meta,
    };
  }

  return null;
}

function simplifyMetadataArray(metadata) {
  if (!Array.isArray(metadata)) return {};
  const out = {};
  for (const m of metadata) {
    if (!m || typeof m !== "object") continue;
    const name = m.name != null ? String(m.name) : null;
    if (!name) continue;
    out[name] = m.value ?? null;
  }
  return out;
}

/**
 * ----------------------------
 * LOCATION FILTERING
 * ----------------------------
 */
function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[().]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLocationTokens(locationString) {
  const raw = String(locationString || "").trim();
  if (!raw) return [];
  const pieces = raw
    .split(LOCATION_SPLIT_REGEX)
    .map((p) => p.trim())
    .filter(Boolean);

  const tokens = new Set([raw, ...pieces]);
  return Array.from(tokens);
}

function extractStateCodes(tokens) {
  const found = new Set();
  for (const t of tokens || []) {
    const upper = String(t).toUpperCase();
    const matches = upper.match(/\b[A-Z]{2}\b/g) || [];
    for (const code of matches) {
      if (NORM.abbr.has(code)) found.add(code);
    }
  }
  return Array.from(found);
}

function jobMatchesLocationFilter(job) {
  const tokens = Array.isArray(job.locationTokens) ? job.locationTokens : [];
  if (tokens.length === 0) return false;
  for (const t of tokens) {
    if (locationTokenMatches(t)) return true;
  }
  return false;
}

function locationTokenMatches(token) {
  const raw = String(token || "");
  if (!raw) return false;
  const n = normalizeText(raw);

  if (NORM.remote.has(n)) return true;

  for (const city of NORM.cities) {
    if (n.includes(city)) return true;
  }

  for (const st of NORM.states) {
    if (n.includes(st)) return true;
  }

  const abbrMatches = raw.toUpperCase().match(/\b[A-Z]{2}\b/g) || [];
  for (const abbr of abbrMatches) {
    if (NORM.abbr.has(abbr)) return true;
  }

  return false;
}

/**
 * ----------------------------
 * TIME + IDS + TTL
 * ----------------------------
 */
function toTimestampOrNull(isoOrDateString) {
  if (!isoOrDateString) return null;
  try {
    const d = new Date(isoOrDateString);
    if (Number.isNaN(d.getTime())) return null;
    return admin.firestore.Timestamp.fromDate(d);
  } catch {
    return null;
  }
}

function addDaysTs(ts, days) {
  const d = ts.toDate ? ts.toDate() : new Date();
  return admin.firestore.Timestamp.fromDate(new Date(d.getTime() + days * 24 * 60 * 60 * 1000));
}

function makeJobDocId({ source, companyKey, externalId }) {
  const base = `${String(source)}|${String(companyKey)}|${String(externalId)}`;
  return sanitizeId(base);
}

function sanitizeId(s) {
  const clean = s
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^\w|.-]+/g, "_")
    .replace(/\|+/g, "|")
    .slice(0, 150);

  const checksum = simpleChecksum(s);
  return `${clean}_${checksum}`;
}

function simpleChecksum(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}
