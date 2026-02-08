/**
 * functions/index.js
 * Node runtime: 20
 * Fixed: Robust History Logging + US Filter + Scheduler Logic
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// --- Robust US Location Filtering ---
const US_STATE_CODES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"];
const US_KEYWORDS = ["UNITED STATES", "USA", "AMER - US", "USCA", "US-REMOTE", "US REMOTE", "REMOTE US", "REMOTE - US", "NYC", "SAN FRANCISCO", "SF-HQ", "US-NATIONAL", "WASHINGTON DC", "ANYWHERE IN THE UNITED STATES"];
const MAJOR_US_CITIES = ["SAN FRANCISCO", "NYC", "NEW YORK CITY", "LOS ANGELES", "CHICAGO", "HOUSTON", "PHOENIX", "PHILADELPHIA", "SAN ANTONIO", "SAN DIEGO", "DALLAS", "SAN JOSE", "AUSTIN", "JACKSONVILLE", "FORT WORTH", "COLUMBUS", "CHARLOTTE", "INDIANAPOLIS", "SEATTLE", "DENVER", "BOSTON", "EL PASO", "NASHVILLE", "DETROIT", "OKLAHOMA CITY", "PORTLAND", "LAS VEGAS", "MEMPHIS", "LOUISVILLE", "BALTIMORE", "MILWAUKEE", "ALBUQUERQUE", "TUCSON", "FRESNO", "SACRAMENTO", "MESA", "KANSAS CITY", "ATLANTA", "OMAHA", "COLORADO SPRINGS", "RALEIGH", "LONG BEACH", "VIRGINIA BEACH", "MIAMI", "OAKLAND", "MINNEAPOLIS", "TULSA", "BAKERSFIELD", "WICHITA", "ARLINGTON"];

function isUSLocation(locationText) {
  if (!locationText) return false;
  const text = locationText.toUpperCase();
  if (US_KEYWORDS.some(kw => text.includes(kw))) return true;
  if (MAJOR_US_CITIES.some(city => new RegExp(`(?:^|[,\\s\\/])${city}(?:[\\s,;\\/]|$)`).test(text))) return true;
  return US_STATE_CODES.some(code => new RegExp(`(?:^|[,\\s\\/])${code}(?:[\\s,;\\/]|$)`).test(text)) || /\bUS\b/.test(text) || text.includes("U.S.");
}

// ---------- Helpers ----------
function normalizeJobsFromFeedJson(json) {
  if (Array.isArray(json)) return json;
  if (json?.jobs && Array.isArray(json.jobs)) return json.jobs;
  if (json?.data && Array.isArray(json.data)) return json.data;
  return [];
}

function safeJobKey(sourceUrl, job) {
  if (job?.id || job?._id) return String(job.id || job._id);
  return Buffer.from(`${sourceUrl}::${job?.absolute_url || ""}::${job?.title || ""}`).toString("base64").replace(/=+$/g, "");
}

function safeCompanyKey(companyName, fallbackUrl) {
  const raw = (companyName || "").trim();
  if (raw) {
    return raw.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || Buffer.from(raw).toString("base64").replace(/=+$/g, "");
  }
  const m = String(fallbackUrl).match(/\/v1\/boards\/([^/]+)\//);
  return m?.[1] ? m[1].replace(/[^a-z0-9\-]+/g, "-").slice(0, 80) : Buffer.from(fallbackUrl).toString("base64").replace(/=+$/g, "").slice(0, 80);
}

async function fetchJson(url) {
  const res = await fetch(url, { method: "GET", headers: { "user-agent": "job-watch-bot/1.0" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.json();
}

async function pollForUser(uid, runType = "scheduled") {
  const userRef = db.collection("users").doc(uid);
  
  // 1. Check if scheduler is enabled before doing anything
  if (runType === "scheduled") {
    const userSnap = await userRef.get();
    if (userSnap.exists && userSnap.data()?.schedulerEnabled === false) {
      return { skipped: true };
    }
  }

  // 2. Initialize Run Log document immediately
  const runRef = userRef.collection("fetchRuns").doc();
  const startedAtMs = Date.now();
  
  await runRef.set({ 
    runType, 
    startedAt: admin.firestore.FieldValue.serverTimestamp(), 
    finishedAt: null, 
    durationMs: null, 
    feedsCount: 0, 
    newCount: 0, 
    errorsCount: 0, 
    errorSamples: [] 
  });

  const feedsSnap = await userRef.collection("feeds").get();
  const activeFeeds = feedsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(f => !f.archivedAt);

  let totalNewCount = 0;
  let errorsCount = 0;
  const errorSamples = [];

  // 3. Main processing loop
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
          const jobKey = safeJobKey(feed.url, job);
          const jobRef = userRef.collection("companies").doc(companyKey).collection("jobs").doc(jobKey);

          // Check if job exists to avoid duplicates
          const jobSnap = await jobRef.get();
          if (jobSnap.exists) continue;

          // Set Company metadata
          batch.set(userRef.collection("companies").doc(companyKey), { 
            companyName, 
            companyKey, 
            lastSeenAt: admin.firestore.FieldValue.serverTimestamp() 
          }, { merge: true });

          // Set Job data
          batch.set(jobRef, { 
            uid, 
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

          if (ops >= 400) { 
            await batch.commit(); 
            batch = db.batch(); 
            ops = 0; 
          }
        }

        if (ops > 0) await batch.commit();
        totalNewCount += feedNewCount;

        // Update feed status
        await userRef.collection("feeds").doc(feed.id).set({ 
          lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(), 
          lastNewCount: feedNewCount,
          lastError: null 
        }, { merge: true });

      } catch (err) {
        errorsCount++;
        if (errorSamples.length < 5) errorSamples.push({ url: feed.url, message: err.message });
        
        await userRef.collection("feeds").doc(feed.id).set({ 
          lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(), 
          lastError: err.message 
        }, { merge: true });
      }
    }
  } finally {
    // 4. Always close the run log with final stats
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

exports.pollGreenhouseFeeds = functions.pubsub.schedule("every 30 minutes").onRun(async () => {
  const usersSnap = await db.collection("users").get();
  for (const doc of usersSnap.docs) { 
    try {
      await pollForUser(doc.id, "scheduled"); 
    } catch (e) {
      console.error(`Scheduled poll failed for user ${doc.id}:`, e);
    }
  }
});

exports.pollNow = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Auth required.");
  return await pollForUser(context.auth.uid, "manual");
});