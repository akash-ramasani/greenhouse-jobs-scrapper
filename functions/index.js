/**
 * functions/index.js
 * Node runtime: 20
 * Optimized: US-Filter + Guaranteed History Logging
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// --- Robust US Location Filtering ---
const US_STATE_CODES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"];
const US_KEYWORDS = ["UNITED STATES", "USA", "AMER - US", "USCA", "US-REMOTE", "US REMOTE", "REMOTE US", "REMOTE - US", "NYC", "SAN FRANCISCO", "SF-HQ", "US-NATIONAL", "WASHINGTON DC", "ANYWHERE IN THE UNITED STATES"];

function isUSLocation(locationText) {
  if (!locationText) return false;
  const text = locationText.toUpperCase();
  if (US_KEYWORDS.some(kw => text.includes(kw))) return true;
  const stateMatch = US_STATE_CODES.some(code => {
    const regex = new RegExp(`(?:^|[,\\s\\/])${code}(?:[\\s,;\\/]|$)`);
    return regex.test(text);
  });
  return stateMatch || /\bUS\b/.test(text) || text.includes("U.S.");
}

// ---------- Helpers (Verified Logic) ----------
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
    const slug = raw.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    return slug || Buffer.from(raw).toString("base64").replace(/=+$/g, "");
  }
  const u = String(fallbackUrl || "").toLowerCase();
  const m = u.match(/\/v1\/boards\/([^/]+)\//);
  return m?.[1] ? m[1].replace(/[^a-z0-9\-]+/g, "-").slice(0, 80) : Buffer.from(u).toString("base64").replace(/=+$/g, "").slice(0, 80);
}

async function fetchJson(url) {
  const res = await fetch(url, { method: "GET", headers: { "user-agent": "job-watch-bot/1.0" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.json();
}

async function pollForUser(uid, runType = "scheduled") {
  const userRef = db.collection("users").doc(uid);
  const runRef = userRef.collection("fetchRuns").doc();
  const startedAtMs = Date.now();

  // 1. Create the document immediately so it's visible in History
  await runRef.set({
    runType,
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
    finishedAt: null,
    durationMs: null,
    feedsCount: 0,
    newCount: 0,
    errorsCount: 0,
    errorSamples: [],
  });

  const feedsSnap = await userRef.collection("feeds").get();
  const activeFeeds = feedsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => !f.archivedAt);

  let totalNewCount = 0;
  let errorsCount = 0;
  const errorSamples = [];

  try {
    for (const feed of activeFeeds) {
      try {
        const json = await fetchJson(feed.url);
        const jobs = normalizeJobsFromFeedJson(json);
        let batch = db.batch();
        let ops = 0;
        let feedNewCount = 0;

        for (const job of jobs) {
          const locName = job?.location?.name || job.location_name || "";
          if (!isUSLocation(locName)) continue; 

          const companyName = (job.company_name || feed.company || "Unknown").trim();
          const companyKey = safeCompanyKey(companyName, feed.url);
          const companyRef = userRef.collection("companies").doc(companyKey);
          const jobKey = safeJobKey(feed.url, job);
          const jobRef = companyRef.collection("jobs").doc(jobKey);

          const existing = await jobRef.get();
          if (existing.exists) continue;

          batch.set(companyRef, { companyName, companyKey, lastSeenAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          batch.set(jobRef, {
            uid: uid,
            title: job.title || job.name || null,
            absolute_url: job.absolute_url || job.url || null,
            locationName: locName,
            companyName,
            companyKey,
            updatedAtIso: job.updated_at || null,
            firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
            saved: false
          });
          
          ops += 2;
          feedNewCount++;
          if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
        }
        
        if (ops > 0) await batch.commit();
        totalNewCount += feedNewCount;
        await userRef.collection("feeds").doc(feed.id).set({ lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(), lastError: null }, { merge: true });
      } catch (err) {
        errorsCount++;
        if (errorSamples.length < 5) errorSamples.push({ url: feed.url, message: err.message });
      }
    }
  } finally {
    // 2. GUARANTEED UPDATE: This ensures history is updated even if zero jobs are found
    await runRef.update({
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      durationMs: Date.now() - startedAtMs,
      feedsCount: activeFeeds.length,
      newCount: totalNewCount,
      errorsCount,
      errorSamples
    });
  }
  return { newCount: totalNewCount, feeds: activeFeeds.length };
}

// ----------------- Exports -----------------
exports.pollGreenhouseFeeds = functions.pubsub.schedule("every 30 minutes").onRun(async () => {
  const usersSnap = await db.collection("users").get();
  for (const doc of usersSnap.docs) { await pollForUser(doc.id, "scheduled"); }
});

exports.pollNow = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Auth required.");
  return await pollForUser(context.auth.uid, "manual");
});