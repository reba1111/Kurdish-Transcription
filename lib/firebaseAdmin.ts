// Server-side Firestore access via the Firebase Admin SDK, used for caching hadith
// search results across users. Separate from src/firebase.ts, which is the browser
// client SDK used for per-user auth and history.
//
// Requires FIREBASE_SERVICE_ACCOUNT_KEY (the full service account JSON, as a single-line
// string) in the environment. Get one from Firebase Console -> Project Settings ->
// Service Accounts -> Generate New Private Key.

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let dbInstance: Firestore | null = null;
let initAttempted = false;

/** Returns a Firestore instance for server-side use, or null if FIREBASE_SERVICE_ACCOUNT_KEY
 * isn't configured or is invalid. Callers should treat a null return as "caching unavailable"
 * and fall through to non-cached behavior rather than throwing. */
export function getAdminFirestore(): Firestore | null {
  if (dbInstance) return dbInstance;
  if (initAttempted) return null;
  initAttempted = true;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;

  try {
    const serviceAccount = JSON.parse(raw);
    const app = getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
    dbInstance = getFirestore(app, "kurdishtranscription");
    return dbInstance;
  } catch (e) {
    console.warn("[firebaseAdmin] Failed to initialize from FIREBASE_SERVICE_ACCOUNT_KEY:", e);
    return null;
  }
}
