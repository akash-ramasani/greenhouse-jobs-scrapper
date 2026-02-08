/**
 * functions/index.js  (Node 20)
 *
 * FINAL SCALABLE ARCHITECTURE (no user feed limit):
 * 1) Scheduler enqueues ONE task per user (fan-out).
 * 2) Worker task processes ONE user per invocation.
 * 3) Worker processes feeds in PAGES (chunking) so a user with 10k feeds still works:
 *    - process up to FEEDS_PER_TASK feeds per task
 *    - if more feeds remain, enqueue the next page task
 * 4) No per-job Firestore reads: use BulkWriter + create() for dedupe.
 *
 * KNOBS are clearly marked below.
 */

const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");

// IMPORTANT: enqueue task queues via Admin SDK (NOT firebase-functions/v2)
const { getFunctions } = require("firebase-admin/functions");

const pLimit = require("p-limit");

// -------------------- KNOB 1: Set your deployment region (keep SAME for all functions) --------------------
// What to do: set this to the same region where your Firestore + Functions should run (commonly "us-central1").
// Why: reduces latency + avoids cross-region cost.
const REGION = "us-central1";

// -------------------- KNOB 2: Feed page size per task (hard scaling control) --------------------
// What to do: if a user has many feeds, process them in chunks so you never time out.
// Start with 100. If tasks finish very quickly, you can increase (200–300). If tasks time out, reduce.
const FEEDS_PER_TASK = 100;

// -------------------- KNOB 3: Parallel feeds processed inside ONE task --------------------
// What to do: controls how many feeds are fetched/processed at the same time per user-task.
// Start 10. If you hit remote rate limits, reduce to 5. If everything is fast and stable, increase to 15–20.
const FEED_CONCURRENCY = 10;

// -------------------- KNOB 4: HTTP fetch timeout per feed --------------------
// What to do: how long to wait for a single feed URL before treating it as failed.
// Start 15000ms. If feeds are often slow but valid, increase to 25000ms. If you want faster failover, reduce.
const FETCH_TIMEOUT_MS = 15000;

// -------------------- KNOB 5: Task worker resources --------------------
// What to do: if tasks are timing out or OOM, increase memory and/or timeoutSeconds.
// If costs are too high and tasks finish quickly, you can reduce.
const WORKER_TIMEOUT_SECONDS = 540; // 9 minutes
const WORKER_MEMORY = "1GiB";

// -------------------- KNOB 6: Global max concurrent user tasks --------------------
// What to do: limits how many user-tasks run at once for your whole project.
// Start 20–50 depending on your project size. Too high can cause rate limits and Firestore pressure.
const MAX_CONCURRENT_USER_TASKS = 50;
// =================================================

// ---------------- US Location Filtering ----------------
const US_STATE_CODES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];
const US_KEYWORDS = ["UNITED STATES","USA","AMER - US","USCA","US-REMOTE","US REMOTE","REMOTE US","REMOTE - US","NYC","SAN FRANCISCO","SF-HQ","US-NATIONAL","WASHINGTON DC","ANYWHERE IN THE UNITED STATES"];
const MAJOR_US_CITIES = ["SAN FRANCISCO","NYC","NEW YORK CITY","LOS ANGELES","CHICAGO","HOUSTON","PHOENIX","PHILADELPHIA","SAN ANTONIO","SAN DIEGO","DALLAS","SAN JOSE","AUSTIN","JACKSONVILLE","FORT WORTH","COLUMBUS","CHARLOTTE","INDIANAPOLIS","SEATTLE","DENVER","BOSTON","EL PASO","NASHVILLE","DETROIT","OKLAHOMA CITY","PORTLAND","LAS VEGAS","MEMPHIS","LOUISVILLE","BALTIMORE","MILWAUKEE","ALBUQUERQUE","TUCSON","FRESNO","SACRAMENTO","MESA","KANSAS CITY","ATLANTA","OMAHA","COLORADO SPRINGS","RALEIGH","LONG BEACH","VIRGINIA BEACH","MIAMI","OAKLAND","MINNEAPOLIS","TULSA","BAKERSFIELD","WICHITA","ARLINGTON"];

function isUSLocation(locationText) {
  if (!locationText) return false;
  const text = String(locationText).toUpperCase();
  if (US_KEYWORDS.some((kw) => text.includes(kw))) return true;
  if (MAJOR_US_CITIES.some((city) => new RegExp(`(?:^|[,\\s\\/])${city}(?:[\\s,;\\/]|$)`).test(text))) return true;
  return (
    US_STATE_CODES.some((code) => new RegExp(`(?:^|[,\\s\\/])${code}(?:[\\s,;\\/]|$)`).test(text)) ||
    /\bUS\b/.test(text) ||
    text.includes("U.S.")
  );
}

// ---------------- Helpers ----------------
function normalizeJobsFromFeedJson(json) {
  if (Array.isArray(json)) return json;
  if (json?.jobs && Array.isArray(json.jobs)) return json.jobs;
  if (json?.data && Array.isArray(json.data)) return json.data;
  return [];
}

function safeJobKey(sourceUrl, job) {
  if (job?.id || job?._id) return String(job.id || job._id);
  return Buffer.from(`${sourceUrl}::${job?.absolute_url || ""}::${job?.title || ""}`)
    .toString("base64")
    .replace(/=+$/g, "");
}

function safeCompanyKey(companyName, fallbackUrl) {
  const raw = (companyName || "").trim();
  if (raw) {
    return (
      raw
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) ||
      Buffer.from(raw).toString("base64").replace(/=+$/g, "")
    );
  }
  const m = String(fallbackUrl).match(/\/v1\/boards\/([^/]+)\//);
  return m?.[1]
    ? m[1].replace(/[^a-z0-9\-]+/g, "-").slice(0, 80)
    : Buffer.from(fallbackUrl).toString("base64").replace(/=+$/g, "").slice(0, 80);
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "user-agent": "job-watch-bot/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function isAlreadyExistsError(err) {
  return err?.code === 6 || /already exists/i.test(err?.message || "");
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isoToTimestampOrNull(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(d);
}

// ---------------- Task queue enqueue helper ----------------
// IMPORTANT: use explicit target URI (most reliable across regions/projects)
function enqueueUserPollTask(data) {
  const target = `locations/${REGION}/functions/pollUserTaskV2`;
  return getFunctions().taskQueue(target).enqueue(data);
}

// ---------------- Task worker: one user page ----------------
exports.pollUserTaskV2 = onTaskDispatched(
  {
    region: REGION,
    timeoutSeconds: WORKER_TIMEOUT_SECONDS,
    memory: WORKER_MEMORY,
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 10 },
    rateLimits: { maxConcurrentDispatches: MAX_CONCURRENT_USER_TASKS },
  },
  async (req) => {
    const { uid, runType = "scheduled", pageIndex = 0, runId = null } = req.data || {};
    if (!uid) throw new Error("Missing uid");

    const userRef = db.collection("users").doc(uid);

    if (runType === "scheduled") {
      const userSnap = await userRef.get();
      if (userSnap.exists && userSnap.data()?.schedulerEnabled === false) {
        return { skipped: true };
      }
    }

    const startedAtMs = Date.now();

    const feedsSnap = await userRef.collection("feeds").get();
    const activeFeedsAll = feedsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((f) => !f.archivedAt);

    const feedPages = chunkArray(activeFeedsAll, FEEDS_PER_TASK);
    const totalPages = feedPages.length || 1;
    const pageFeeds = feedPages[pageIndex] || [];

    const runRef = runId
      ? userRef.collection("fetchRuns").doc(runId)
      : userRef.collection("fetchRuns").doc();

    const effectiveRunId = runRef.id;

    if (!runId) {
      await runRef.set({
        runType,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        finishedAt: null,
        durationMs: null,
        feedsCount: activeFeedsAll.length,
        feedsProcessed: 0,
        newCount: 0,
        errorsCount: 0,
        errorSamples: [],
        pagesTotal: totalPages,
        pagesDone: 0,
      });
    }

    let totalNewCount = 0;
    let errorsCount = 0;
    const errorSamples = [];

    const runSnap = await runRef.get();
    if (runSnap.exists) {
      const d = runSnap.data() || {};
      totalNewCount = d.newCount || 0;
      errorsCount = d.errorsCount || 0;
      if (Array.isArray(d.errorSamples)) errorSamples.push(...d.errorSamples);
    }

    const writer = db.bulkWriter();
    writer.onWriteError((err) => {
      if (isAlreadyExistsError(err)) return true;
      if (err?.failedAttempts < 3) return true;
      return false;
    });

    const limit = pLimit(FEED_CONCURRENCY);

    let pageFeedsProcessed = 0;
    let pageNewCount = 0;

    try {
      await Promise.all(
        pageFeeds.map((feed) =>
          limit(async () => {
            try {
              const json = await fetchJson(feed.url, FETCH_TIMEOUT_MS);
              const jobs = normalizeJobsFromFeedJson(json);

              let feedNewCount = 0;

              for (const job of jobs) {
                const locName = job?.location?.name || job.location_name || "";
                if (!isUSLocation(locName)) continue;

                const companyName = (job.company_name || feed.company || "Unknown").trim();
                const companyKey = safeCompanyKey(companyName, feed.url);
                const jobKey = safeJobKey(feed.url, job);

                const companyRef = userRef.collection("companies").doc(companyKey);
                const jobRef = companyRef.collection("jobs").doc(jobKey);

                writer.set(
                  companyRef,
                  {
                    companyName,
                    companyKey,
                    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
                  },
                  { merge: true }
                );

                const updatedAtIso = job.updated_at || null;
                const updatedAtTs = isoToTimestampOrNull(updatedAtIso);

                try {
                  await writer.create(jobRef, {
                    uid,
                    title: job.title || job.name || null,
                    absolute_url: job.absolute_url || job.url || null,
                    locationName: locName,
                    companyName,
                    companyKey,
                    updatedAtIso,
                    updatedAtTs,
                    firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
                    firstSeenAtTs: admin.firestore.FieldValue.serverTimestamp(),
                    saved: false,
                  });
                  feedNewCount++;
                } catch (e) {
                  if (!isAlreadyExistsError(e)) throw e;
                }
              }

              pageNewCount += feedNewCount;

              await userRef.collection("feeds").doc(feed.id).set(
                {
                  lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                  lastNewCount: feedNewCount,
                  lastError: null,
                },
                { merge: true }
              );
            } catch (err) {
              errorsCount++;
              if (errorSamples.length < 5) errorSamples.push({ url: feed.url, message: err.message });

              await userRef.collection("feeds").doc(feed.id).set(
                {
                  lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                  lastError: err.message,
                },
                { merge: true }
              );
            } finally {
              pageFeedsProcessed++;
              if (pageFeedsProcessed % 20 === 0) {
                await runRef.update({
                  newCount: totalNewCount + pageNewCount,
                  errorsCount,
                  errorSamples: errorSamples.slice(0, 5),
                });
              }
            }
          })
        )
      );

      await writer.close();

      const nowSnap = await runRef.get();
      const nowData = nowSnap.exists ? nowSnap.data() : {};
      const prevFeedsProcessed = nowData?.feedsProcessed || 0;
      const prevPagesDone = nowData?.pagesDone || 0;

      await runRef.update({
        feedsProcessed: prevFeedsProcessed + pageFeedsProcessed,
        newCount: (nowData?.newCount || 0) + pageNewCount,
        errorsCount,
        errorSamples: errorSamples.slice(0, 5),
        pagesDone: prevPagesDone + 1,
      });
    } finally {
      if (pageIndex >= totalPages - 1) {
        await runRef.update({
          finishedAt: admin.firestore.FieldValue.serverTimestamp(),
          durationMs: Date.now() - startedAtMs,
        });
      }
    }

    // enqueue next page if needed (FIXED)
    if (pageIndex < totalPages - 1) {
      await enqueueUserPollTask({
        uid,
        runType,
        pageIndex: pageIndex + 1,
        runId: effectiveRunId,
      });
    }

    return {
      uid,
      runId: effectiveRunId,
      pageIndex,
      totalPages,
      pageFeeds: pageFeeds.length,
      pageNewCount,
      errorsCount,
    };
  }
);

// ---------------- Scheduler fan-out ----------------
exports.pollGreenhouseFeedsV2 = onSchedule(
  {
    region: REGION,
    schedule: "every 30 minutes",
    timeZone: "America/Los_Angeles",
  },
  async () => {
    const usersSnap = await db
      .collection("users")
      .where("schedulerEnabled", "!=", false)
      .get();

    await Promise.all(
      usersSnap.docs.map((d) =>
        enqueueUserPollTask({ uid: d.id, runType: "scheduled", pageIndex: 0 })
      )
    );

    return null;
  }
);

// ---------------- Manual trigger ----------------
exports.pollNowV2 = onCall({ region: REGION }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Auth required.");

  await enqueueUserPollTask({
    uid: request.auth.uid,
    runType: "manual",
    pageIndex: 0,
  });

  return { enqueued: true };
});
