// Detects <quran surah="..." ayah="...">...</quran> tags the model emits when it
// recognizes a recited ayah, and replaces their contents with the authoritative
// fully-diacritized text + confirmed citation from the free AlQuran Cloud API
// (https://alquran.cloud/api, no auth required).
//
// <hadith narrator="...">...</hadith> tags have no equivalent free structured API,
// so they're instead checked with Gemini's Google Search Grounding tool — the model
// searches the live web for the quoted phrase and reports back the narrator/collection
// it actually finds, rather than trusting its own (possibly hallucinated) guess.
//
// The model is asked to name the surah in English (e.g. "Al-Faatiha") since that's
// far more reliably spelled by an LLM than a transliterated Arabic surah name, and
// the AlQuran Cloud surah list exposes a matching englishName field to resolve it
// against. The recited Arabic phrase alone is NOT enough to disambiguate — phrases
// like the basmala open ~113 of 114 surahs, so a same-text search without a surah
// hint can confidently return the wrong ayah.

import type { GoogleGenAI } from "@google/genai";

const QURAN_TAG_RE = /<quran\s+surah="([^"]*)"\s+ayah="([^"]*)">([\s\S]*?)<\/quran>/g;
const HADITH_TAG_RE = /<hadith\s+narrator="([^"]*)">([\s\S]*?)<\/hadith>/g;

/** System instruction (config.systemInstruction) establishing the model's persona for any
 * Kurdish transcription that may contain religious content — kept separate from the
 * task-specific transcription rules in the user prompt, per Gemini's system/user split. */
export const ISLAMIC_TEXT_SYSTEM_INSTRUCTION =
  "تۆ شارەزایەکی زمانی کوردی و زانستە ئایینییەکانیت. کاتێک دەنگێکی ئایینی وەردەگێڕیت بۆ نووسین، وشە و زاراوە عەرەبییەکان بە ڕێنووسی دروستی عەرەبی بنووسە، نەک بە دەنگنووسی کوردی.";

/** Prompt addition shared by every Kurdish-transcription prompt so the model emits a
 * consistent tag format that this module's verifier and the client renderer both parse. */
export const ISLAMIC_TEXT_DETECTION_RULE = `

If the speaker recites a Quran ayah or quotes a Hadith, do NOT transcribe it phonetically into Kurdish-adjacent script. Instead:
- For a Quran ayah: wrap it as <quran surah="EnglishSurahName" ayah="N">the recited Arabic text with your best-effort diacritics</quran> — use the surah's English name (e.g. "Al-Faatiha", "Al-Baqara", "Al-Ikhlaas") and your best guess at the ayah number.
- For a Hadith: wrap it as <hadith narrator="Name in Arabic or English">the recited Arabic text</hadith> — use the narrator or collection name if mentioned (e.g. "البخاري", "مسلم"), or "نامشخص" if unclear.
- CRITICAL — completeness: if the speaker recites MULTIPLE consecutive ayahs or a multi-sentence Hadith, you MUST capture the ENTIRE recitation inside the tag, word for word, from its first to its very last spoken syllable. Never tag only part of what was recited and leave the rest untagged or omitted — listen to the full recitation before closing the tag. When a recitation spans more than one ayah, either include the full span inside one <quran> tag (use the starting ayah's number) or emit one consecutive <quran> tag per ayah — never drop or truncate any spoken ayah in between.
- Only tag actual Quran/Hadith recitation, not ordinary Arabic words or phrases used in everyday Kurdish speech.
- Everything else stays as normal Kurdish transcription, untouched — do not lose any spoken content, religious or otherwise.`;

/**
 * Runs a cheap, text-only Gemini pass over an already-transcribed Kurdish transcript
 * to detect and tag any Quran/Hadith recitation with <quran>/<hadith> markup, for
 * transcription paths that couldn't apply ISLAMIC_TEXT_DETECTION_RULE during the
 * original audio call itself (e.g. ElevenLabs Scribe's plain ASR output, or a
 * word-timestamp transcription pass that intentionally skips citation tagging to
 * keep its own output format simple). Returns the input unchanged on any failure —
 * tagging is a nice-to-have annotation, never a reason to lose the transcript.
 */
export async function tagIslamicCitations(ai: GoogleGenAI, text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return text;
  // Only worth the extra call when the text actually contains a meaningful chunk of
  // Arabic script — plain Kurdish-only speech has nothing to tag.
  const arabicCharCount = (trimmed.match(/[؀-ۿ]/g) || []).length;
  if (arabicCharCount <= 10) return text;

  try {
    const tagPrompt = `The following is a Kurdish (Sorani) speech transcript. If any part of it is a recited Quran ayah or Hadith quotation, mark it using the rules below. Return the FULL text unchanged otherwise — do not translate, summarize, or alter any other wording.${ISLAMIC_TEXT_DETECTION_RULE}

Transcript:
${trimmed}`;
    const tagRes = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
      contents: tagPrompt,
    });
    const tagged = (tagRes.text || "").trim();
    return tagged || text;
  } catch (e) {
    console.warn("[islamicTextVerifier] Citation tagging pass failed, keeping untagged text:", e);
    return text;
  }
}

const ALQURAN_BASE = "https://api.alquran.cloud/v1";

interface SurahMeta {
  number: number;
  name: string;
  englishName: string;
}

let surahListCache: SurahMeta[] | null = null;

async function getSurahList(): Promise<SurahMeta[]> {
  if (surahListCache) return surahListCache;
  try {
    const res = await fetch(`${ALQURAN_BASE}/surah`);
    if (!res.ok) return [];
    const data = await res.json();
    surahListCache = data?.data ?? [];
    return surahListCache!;
  } catch {
    return [];
  }
}

function resolveSurahNumber(list: SurahMeta[], hint: string): number | null {
  const normalized = hint.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!normalized) return null;
  const exact = list.find(s => s.englishName.toLowerCase().replace(/[^a-z]/g, "") === normalized);
  if (exact) return exact.number;
  const partial = list.find(s =>
    s.englishName.toLowerCase().replace(/[^a-z]/g, "").includes(normalized) ||
    normalized.includes(s.englishName.toLowerCase().replace(/[^a-z]/g, ""))
  );
  return partial ? partial.number : null;
}

interface AyahResult {
  text: string;
  surahNameArabic: string;
  surahNameEnglish: string;
  ayahNumber: number;
}

async function fetchAyah(surahNumber: number, ayahNumber: number): Promise<AyahResult | null> {
  try {
    const res = await fetch(`${ALQURAN_BASE}/ayah/${surahNumber}:${ayahNumber}/quran-uthmani`);
    if (!res.ok) return null;
    const data = await res.json();
    const rawText: string | undefined = data?.data?.text;
    const rawSurahNameArabic: string | undefined = data?.data?.surah?.name;
    const surahNameEnglish: string | undefined = data?.data?.surah?.englishName;
    if (!rawText || !rawSurahNameArabic || !surahNameEnglish) return null;
    const text = rawText.replace(/﻿/g, ""); // API includes a stray BOM on some ayahs
    // API returns e.g. "سُورَةُ ٱلْفَاتِحَةِ" — strip the "سورة" prefix since callers prepend their own.
    const surahNameArabic = rawSurahNameArabic.replace(/^سُورَةُ\s*/, "").trim();
    return { text, surahNameArabic, surahNameEnglish, ayahNumber };
  } catch {
    return null;
  }
}

// Arabic combining diacritics block (U+064B-U+065F), small high marks (U+0670, U+06D6-U+06ED),
// and the UTF-8 BOM (U+FEFF) that the AlQuran Cloud API includes before some ayah text.
const DIACRITICS_AND_BOM_RE = /[ً-ٰٟۖ-ۭ﻿]/g;
const ALEF_VARIANTS_RE = /[آأإٱ]/g; // آ أ إ ٱ -> ا
const NON_ARABIC_LETTER_RE = /[^ء-ي]/g;

/** Strips diacritics/BOM and normalizes alef variants so recited (often plain) text can be compared to the authoritative (diacritized) text. */
function stripForComparison(s: string): string {
  return s
    .replace(DIACRITICS_AND_BOM_RE, "")
    .replace(ALEF_VARIANTS_RE, "ا")
    .replace(NON_ARABIC_LETTER_RE, "");
}

/** Sanity check: does the model's recited snippet share enough of the authoritative ayah to trust the match? */
function looksLikeMatch(recited: string, authoritative: string): boolean {
  const a = stripForComparison(recited);
  const b = stripForComparison(authoritative);
  if (a.length < 4) return false;
  return b.includes(a) || a.includes(b) || (a.length > 8 && b.includes(a.slice(0, Math.floor(a.length * 0.6))));
}

async function searchByText(arabicText: string): Promise<{ surahNumber: number; ayahNumber: number } | null> {
  const query = arabicText.trim().slice(0, 200);
  if (!query) return null;
  try {
    const res = await fetch(`${ALQURAN_BASE}/search/${encodeURIComponent(query)}/all/ar`);
    if (!res.ok) return null;
    const data = await res.json();
    const match = data?.data?.matches?.[0];
    if (!match) return null;
    return { surahNumber: match.surah.number, ayahNumber: match.numberInSurah };
  } catch {
    return null;
  }
}

async function resolveAyah(surahHint: string, ayahHint: string, recitedText: string): Promise<AyahResult | null> {
  const ayahNumber = parseInt(ayahHint, 10);
  const list = await getSurahList();
  const surahNumber = list.length > 0 ? resolveSurahNumber(list, surahHint) : null;

  if (surahNumber && Number.isInteger(ayahNumber) && ayahNumber > 0) {
    const direct = await fetchAyah(surahNumber, ayahNumber);
    if (direct && looksLikeMatch(recitedText, direct.text)) return direct;
  }

  const searched = await searchByText(recitedText);
  if (searched) {
    const result = await fetchAyah(searched.surahNumber, searched.ayahNumber);
    if (result && looksLikeMatch(recitedText, result.text)) return result;
  }

  return null;
}

interface HadithLookupResult {
  narrator: string;
  confident: boolean;
}

/**
 * Uses Gemini's Google Search Grounding tool to look up the real narrator/collection
 * for a quoted hadith phrase, instead of trusting the model's own unaided guess.
 * Returns null on any failure (no key, network error, low-confidence result, etc).
 */
async function lookupHadithViaSearch(ai: GoogleGenAI, arabicText: string): Promise<HadithLookupResult | null> {
  try {
    const prompt = `A speaker quoted this Hadith in Arabic: "${arabicText.trim().slice(0, 300)}". Use Google Search to find its authoritative source. Reply with ONLY a JSON object, no markdown: {"narrator": "the hadith collection and/or narrator names ONLY, in Arabic, without the word رواه — e.g. البخاري ومسلم عن عمر بن الخطاب", "confident": true or false}`;
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      config: { temperature: 0, tools: [{ googleSearch: {} }] },
      contents: prompt,
    });
    const raw = (result.text || "").replace(/```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    if (!parsed?.narrator || typeof parsed.confident !== "boolean") return null;
    // Defensively strip a leading "رواه" in case the model adds it despite instructions —
    // the caller (UI bracket formatter) always prepends its own "رواه".
    const narrator = String(parsed.narrator).replace(/^\s*رواه\s+/, "").trim();
    return { narrator, confident: parsed.confident };
  } catch {
    return null;
  }
}

/**
 * Rewrites every <quran> tag with the verified, fully-diacritized ayah text and
 * citation (marking verified="true"), and — when a GoogleGenAI client is
 * provided — every <hadith> tag with a search-grounded narrator/collection (same
 * verified attribute). Without an ai client, <hadith> tags pass through unverified.
 * A <quran> tag that can't be matched against AlQuran Cloud usually means the model
 * only captured a fragment of the ayah (or mis-cited the surah/number), so it's
 * unwrapped back to plain recited text instead of being shown as an unconfirmed
 * citation. Network/API failures fail open (tag left as-is, unverified).
 */
export async function verifyAndAnnotate(text: string, ai?: GoogleGenAI): Promise<string> {
  let result = text;

  // Each citation's verification is an independent network round-trip (AlQuran Cloud
  // / Google Search) — run them concurrently instead of one-at-a-time, then apply the
  // string replacements sequentially afterward (cheap/synchronous, and preserves
  // correct behavior when the same citation text appears more than once: each
  // replacement only ever touches the next remaining occurrence).
  const quranMatches = [...text.matchAll(QURAN_TAG_RE)];
  const quranReplacements = await Promise.all(quranMatches.map(async (match) => {
    const [fullTag, surahHint, ayahHint, innerText] = match;
    const verified = await resolveAyah(surahHint, ayahHint, innerText);
    const replacement = verified
      ? `<quran surah="${verified.surahNameArabic}" ayah="${verified.ayahNumber}" verified="true">${verified.text}</quran>`
      : innerText;
    return { fullTag, replacement };
  }));
  for (const { fullTag, replacement } of quranReplacements) {
    result = result.replace(fullTag, replacement);
  }

  if (ai) {
    const hadithMatches = [...text.matchAll(HADITH_TAG_RE)];
    const hadithReplacements = await Promise.all(hadithMatches.map(async (match) => {
      const [fullTag, , innerText] = match;
      const looked = await lookupHadithViaSearch(ai, innerText);
      const replacement = looked?.confident
        ? `<hadith narrator="${looked.narrator}" verified="true">${innerText}</hadith>`
        : fullTag.replace('<hadith ', '<hadith verified="false" ');
      return { fullTag, replacement };
    }));
    for (const { fullTag, replacement } of hadithReplacements) {
      result = result.replace(fullTag, replacement);
    }
  }

  return result;
}
