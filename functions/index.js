/**
 * functions/index.js
 * Node runtime: 20
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// ---------- helpers ----------
function normalizeJobsFromFeedJson(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.jobs)) return json.jobs;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}

function safeJobKey(sourceUrl, job) {
  if (job && (job.id || job._id)) return String(job.id || job._id);
  const base = `${sourceUrl}::${job?.absolute_url || ""}::${job?.title || ""}`;
  return Buffer.from(base).toString("base64").replace(/=+$/g, "");
}

function safeCompanyKey(companyName, fallbackUrl) {
  const raw = (companyName || "").trim();
  if (raw) {
    const slug = raw
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return slug || Buffer.from(raw).toString("base64").replace(/=+$/g, "");
  }

  const u = String(fallbackUrl || "").toLowerCase();
  const m = u.match(/\/v1\/boards\/([^/]+)\//);
  if (m?.[1]) return m[1].replace(/[^a-z0-9\-]+/g, "-").slice(0, 80);
  return Buffer.from(u).toString("base64").replace(/=+$/g, "").slice(0, 80);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: { "user-agent": "job-watch-bot/1.0" },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.json();
}

/**
 * Poll feeds for a user and write new jobs to:
 * users/{uid}/companies/{companyKey}/jobs/{jobKey}
 *
 * - Only adds new jobs (never updates existing job docs)
 * - Skips archived feeds (feeds with archivedAt)
 * - Logs each run in users/{uid}/fetchRuns/{runId}
 */
async function pollForUser(uid, runType = "scheduled") {
  const userRef = db.collection("users").doc(uid);

  // run log
  const runRef = userRef.collection("fetchRuns").doc();
  const startedAtMs = Date.now();

  await runRef.set(
    {
      runType,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      finishedAt: null,
      durationMs: null,
      feedsCount: 0,
      newCount: 0,
      errorsCount: 0,
      errorSamples: [],
    },
    { merge: true }
  );

  const feedsSnap = await userRef.collection("feeds").get();
  const feeds = feedsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const activeFeeds = feeds.filter((f) => !f.archivedAt);

  if (!activeFeeds.length) {
    await userRef.set({ lastFetchAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    await runRef.set(
      {
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
        durationMs: Date.now() - startedAtMs,
        feedsCount: 0,
        newCount: 0,
        errorsCount: 0,
        errorSamples: [],
      },
      { merge: true }
    );

    return { newCount: 0, feeds: 0 };
  }

  let totalNewCount = 0;
  let errorsCount = 0;
  const errorSamples = [];

  const concurrency = 3;
  let i = 0;

  const workers = new Array(Math.min(concurrency, activeFeeds.length)).fill(0).map(async () => {
    while (i < activeFeeds.length) {
      const idx = i++;
      const feed = activeFeeds[idx];

      const url = feed.url;
      const feedRef = userRef.collection("feeds").doc(feed.id);

      try {
        const json = await fetchJson(url);
        const jobs = normalizeJobsFromFeedJson(json);

        let batch = db.batch();
        let ops = 0;
        let newCount = 0;

        for (const job of jobs) {
          const companyName = (job.company_name || feed.company || "").trim() || "Unknown";
          const companyKey = safeCompanyKey(companyName, url);

          const companyRef = userRef.collection("companies").doc(companyKey);
          const jobsCol = companyRef.collection("jobs");

          const jobKey = safeJobKey(url, job);
          const jobRef = jobsCol.doc(jobKey);

          const existing = await jobRef.get();
          if (existing.exists) continue; // ✅ only add new

          batch.set(
            companyRef,
            {
              companyName,
              companyKey,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          ops++;

          batch.set(jobRef, {
            title: job.title || job.name || job.position || null,
            absolute_url: job.absolute_url || job.url || job.apply_url || null,
            locationName: job?.location?.name || job.location_name || null,

            source: url,
            raw: job,

            companyName,
            companyKey,
            updatedAtIso: job.updated_at || null,

            firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          ops++;
          newCount++;

          if (ops >= 400) {
            await batch.commit();
            batch = db.batch();
            ops = 0;
          }
        }

        if (ops > 0) await batch.commit();

        totalNewCount += newCount;

        await feedRef.set(
          {
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastNewCount: newCount,
            lastError: null,
          },
          { merge: true }
        );
      } catch (err) {
        errorsCount++;
        const msg = String(err?.message || err);

        if (errorSamples.length < 5) {
          errorSamples.push({ feedId: feed.id, url, message: msg });
        }

        console.error("Feed error", uid, url, msg);

        await feedRef.set(
          {
            lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastError: msg,
          },
          { merge: true }
        );
      }
    }
  });

  await Promise.all(workers);

  await userRef.set({ lastFetchAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  await runRef.set(
    {
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      durationMs: Date.now() - startedAtMs,
      feedsCount: activeFeeds.length,
      newCount: totalNewCount,
      errorsCount,
      errorSamples,
    },
    { merge: true }
  );

  return { newCount: totalNewCount, feeds: activeFeeds.length };
}

// ----------------- scheduled -----------------
exports.pollGreenhouseFeeds = functions.pubsub
  .schedule("every 30 minutes")
  .timeZone("Etc/UTC")
  .onRun(async () => {
    const usersSnap = await db.collection("users").get();
    if (usersSnap.empty) return null;

    const userDocs = usersSnap.docs;
    const concurrency = 5;
    let i = 0;

    const workers = new Array(Math.min(concurrency, userDocs.length)).fill(0).map(async () => {
      while (i < userDocs.length) {
        const idx = i++;
        const userDoc = userDocs[idx];
        try {
          await pollForUser(userDoc.id, "scheduled");
        } catch (err) {
          console.error("User poll error", userDoc.id, err?.message || err);
        }
      }
    });

    await Promise.all(workers);
    return null;
  });

// ----------------- manual onCall -----------------
exports.pollNow = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated to poll now.");
  }

  const uid = context.auth.uid;

  try {
    const result = await pollForUser(uid, "manual");
    return { ok: true, newCount: result.newCount, feeds: result.feeds };
  } catch (err) {
    console.error("Manual poll error", uid, err?.message || err);
    throw new functions.https.HttpsError("internal", "Polling failed: " + String(err?.message || err));
  }
});

// ----------------- MIGRATION (old users/{uid}/jobs -> companies/{company}/jobs) -----------------
exports.migrateLegacyJobsToCompanies = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "User must be authenticated.");
  }

  const uid = context.auth.uid;
  const userRef = db.collection("users").doc(uid);

  // read legacy jobs
  const legacySnap = await userRef.collection("jobs").get();
  if (legacySnap.empty) {
    return { ok: true, migrated: 0, note: "No legacy jobs found at users/{uid}/jobs" };
  }

  let migrated = 0;

  // batch in chunks
  let batch = db.batch();
  let ops = 0;

  for (const docSnap of legacySnap.docs) {
    const legacy = docSnap.data() || {};
    const raw = legacy.raw || {};
    const source = legacy.source || "";
    const companyName = (legacy.companyName || raw.company_name || "Unknown").trim();
    const companyKey = safeCompanyKey(companyName, source);

    const companyRef = userRef.collection("companies").doc(companyKey);
    const jobRef = companyRef.collection("jobs").doc(docSnap.id);

    // if already migrated, skip
    const exists = await jobRef.get();
    if (exists.exists) continue;

    batch.set(
      companyRef,
      {
        companyName,
        companyKey,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    ops++;

    batch.set(
      jobRef,
      {
        ...legacy,
        companyName,
        companyKey,
        updatedAtIso: legacy.updatedAtIso || raw.updated_at || null,
      },
      { merge: true }
    );
    ops++;

    migrated++;

    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) await batch.commit();

  return { ok: true, migrated };
});
