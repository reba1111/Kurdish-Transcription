// Semantic Hadith search: the user describes a hadith's meaning in Kurdish, Gemini
// identifies the hadith it recognizes and proposes an Arabic search phrase, and that
// phrase is verified against hadithapi.com (https://hadithapi.com — free, covers Sahih
// Bukhari, Sahih Muslim, Jami' al-Tirmidhi, Sunan Abu Dawood, Sunan Ibn Majah, Sunan
// an-Nasa'i, Mishkat al-Masabih, Musnad Ahmad, Al-Silsila al-Sahiha) before being shown.
// Same fail-open, verify-before-trust pattern as lib/islamicTextVerifier.ts.
//
// hadithapi.com's exact JSON response field names aren't documented publicly, so the
// response parsing below reads several plausible field-name variants defensively and
// falls back to "unverified" on a shape mismatch rather than throwing.

import type { GoogleGenAI } from "@google/genai";
import { ISLAMIC_TEXT_SYSTEM_INSTRUCTION } from "./islamicTextVerifier";
import { getAdminFirestore } from "./firebaseAdmin";

const HADITH_API_BASE = "https://hadithapi.com/api/hadiths/";
const CACHE_COLLECTION = "hadithSearchCache";

/** Normalizes a Kurdish query into a stable cache key — collapses whitespace and
 * lowercases so near-identical phrasings of the same question share a cache entry. */
function cacheKeyFor(kurdishQuery: string): string {
  return kurdishQuery.trim().toLowerCase().replace(/\s+/g, " ");
}

async function getCachedResult(kurdishQuery: string): Promise<HadithSearchResult[] | null> {
  const db = getAdminFirestore();
  if (!db) return null;
  try {
    const doc = await db.collection(CACHE_COLLECTION).doc(cacheKeyFor(kurdishQuery)).get();
    if (!doc.exists) return null;
    const data = doc.data();
    return Array.isArray(data?.results) ? data!.results : null;
  } catch (e) {
    console.warn("[hadithSearch] Cache read failed:", e);
    return null;
  }
}

async function setCachedResult(kurdishQuery: string, results: HadithSearchResult[]): Promise<void> {
  const db = getAdminFirestore();
  if (!db) return;
  try {
    await db.collection(CACHE_COLLECTION).doc(cacheKeyFor(kurdishQuery)).set({
      query: kurdishQuery.trim(),
      results,
      cachedAt: Date.now(),
    });
  } catch (e) {
    console.warn("[hadithSearch] Cache write failed:", e);
  }
}

export interface HadithSearchResult {
  arabicText: string;
  narrator: string;
  book: string;
  chapter?: string;
  grading?: string;
  verified: boolean;
}

interface GeminiGuess {
  arabicPhrase: string;
  bookGuess?: string;
}

async function getGeminiGuesses(ai: GoogleGenAI, kurdishQuery: string): Promise<GeminiGuess[]> {
  const prompt = `A user described a Hadith in Kurdish (Sorani): "${kurdishQuery.trim().slice(0, 500)}"

Identify the Hadith(s) you recognize that best match this description. For each, give a short distinctive Arabic phrase (5-10 words) from the actual hadith text that would work well as a search query, and your best guess at which book/collection it's from (e.g. "Sahih Bukhari", "Sahih Muslim").

Return ONLY a JSON array, no markdown, up to 3 results, most likely first:
[{"arabicPhrase": "...", "bookGuess": "..."}]

If you don't recognize any matching hadith, return an empty array [].`;

  try {
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
      contents: prompt,
    });
    const raw = (result.text || "").replace(/```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const match = raw.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((g): g is GeminiGuess => typeof g?.arabicPhrase === "string" && g.arabicPhrase.trim().length > 0)
      .slice(0, 3);
  } catch {
    return [];
  }
}

// hadithapi.com book slugs, keyed by lowercase fragments that might appear in Gemini's
// free-text book guess (e.g. "Sahih Bukhari" -> "sahih-bukhari").
const BOOK_SLUGS: Record<string, string> = {
  bukhari: "sahih-bukhari",
  muslim: "sahih-muslim",
  tirmidhi: "al-tirmidhi",
  "abu dawood": "abu-dawood",
  "abu dawud": "abu-dawood",
  majah: "ibn-e-majah",
  nasai: "sunan-nasai",
  "nasa'i": "sunan-nasai",
  mishkat: "mishkat",
  ahmad: "musnad-ahmad",
  silsila: "al-silsila-sahiha",
};

function resolveBookSlug(bookGuess: string | undefined): string | null {
  if (!bookGuess) return null;
  const lower = bookGuess.toLowerCase();
  for (const [fragment, slug] of Object.entries(BOOK_SLUGS)) {
    if (lower.includes(fragment)) return slug;
  }
  return null;
}

/** Reads the first plausible field among several candidate names — defensive against
 * hadithapi.com's undocumented response shape. */
function pickField(obj: any, ...candidates: string[]): string | undefined {
  for (const key of candidates) {
    const value = obj?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function queryHadithApi(apiKey: string, arabicPhrase: string, bookSlug: string | null): Promise<HadithSearchResult | null> {
  const params = new URLSearchParams({ apiKey, hadithArabic: arabicPhrase });
  if (bookSlug) params.set("book", bookSlug);

  try {
    const res = await fetch(`${HADITH_API_BASE}?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();

    // hadithapi.com wraps results in a paginated object; try the common shapes.
    const list: any[] =
      data?.hadiths?.data ?? data?.hadiths ?? data?.data ?? (Array.isArray(data) ? data : []);
    const first = Array.isArray(list) ? list[0] : null;
    if (!first) return null;

    const arabicText = pickField(first, "hadithArabic", "arabic", "hadith_arabic");
    if (!arabicText) return null;

    const narrator = pickField(first, "hadithNarrator", "narrator", "rawi", "hadith_narrator") || "نەزانراو";
    const book =
      pickField(first.book, "bookName", "name") ||
      pickField(first, "bookName", "book") ||
      bookSlug ||
      "نەزانراو";
    const chapter = pickField(first.chapter, "chapterEnglish", "chapterArabic", "title") || pickField(first, "chapterTitle");
    const grading = pickField(first, "status", "grading", "hadithGrading");

    return { arabicText, narrator, book, chapter, grading, verified: true };
  } catch {
    return null;
  }
}

/**
 * Searches for a Hadith matching a Kurdish description of its meaning. Checks the
 * Firestore cache first (keyed by normalized query text) so repeat questions skip
 * Gemini and hadithapi.com entirely. On a cache miss, asks Gemini for up to 3
 * candidate Arabic phrases, then verifies each against hadithapi.com in order and
 * returns the first confirmed match — which is then cached for future identical
 * queries. If hadithapi.com can't confirm any candidate (no API key, network error,
 * no match), falls back to returning Gemini's top guess marked unverified rather
 * than an empty result; unverified guesses are never cached, since they're low
 * confidence and shouldn't be served to other users as if settled.
 */
export async function searchHadithByMeaning(ai: GoogleGenAI, kurdishQuery: string, apiKey: string | undefined): Promise<HadithSearchResult[]> {
  const cached = await getCachedResult(kurdishQuery);
  if (cached) return cached;

  const guesses = await getGeminiGuesses(ai, kurdishQuery);
  if (guesses.length === 0) return [];

  if (apiKey) {
    for (const guess of guesses) {
      const bookSlug = resolveBookSlug(guess.bookGuess);
      const verified = await queryHadithApi(apiKey, guess.arabicPhrase, bookSlug);
      if (verified) {
        await setCachedResult(kurdishQuery, [verified]);
        return [verified];
      }
      if (bookSlug) {
        // Retry without the book filter in case Gemini's book guess was wrong.
        const verifiedNoBook = await queryHadithApi(apiKey, guess.arabicPhrase, null);
        if (verifiedNoBook) {
          await setCachedResult(kurdishQuery, [verifiedNoBook]);
          return [verifiedNoBook];
        }
      }
    }
  }

  // No confirmed match (or no API key configured) — return Gemini's best guess, unverified.
  // Not cached: a low-confidence guess shouldn't be served to other users as settled.
  const top = guesses[0];
  return [{
    arabicText: top.arabicPhrase,
    narrator: "نەزانراو",
    book: top.bookGuess || "نەزانراو",
    verified: false,
  }];
}
