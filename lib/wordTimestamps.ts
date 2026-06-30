// Single-call transcription with per-word timestamps: instead of running a separate
// Gemini audio call just to get word-level timing for the karaoke highlight view and
// subtitle export (doubling the audio-token cost of every transcription), the main
// transcription itself is asked to return word+timestamp lines directly. The plain
// transcript text is then reconstructed from those words, so callers get both outputs
// from one audio read.
//
// Output is intentionally LINE-DELIMITED ("start|end|word", one per line) rather than
// a single JSON array: a response that gets cut off mid-output (long audio running
// into the model's output token limit) still leaves every complete line before the
// cutoff parseable. A truncated JSON array, by contrast, is entirely unparseable and
// would lose the whole transcript — unacceptable for what's the app's core feature.

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

const SORANI_SPELLING_RULES = `Strict rules — follow every one without exception:
1. Transcribe EXACTLY what is spoken — do not add, remove, or change any word.
2. Use the standard Central Kurdish (Sorani) Arabic-based script (e.g. ئ، ا، ب، پ، ت، ج، چ، ح، خ، د، ر، ڕ، ز، ژ، س، ش، ع، غ، ف، ڤ، ق، ک، گ، ل، ڵ، م، ن، وو، و، ه، ھ، ی، ێ، ئ، ە).
3. Spell every word correctly according to standard Sorani orthography — pay close attention to:
   - The difference between ئ and ع
   - Long vowels (وو، ێ، ای) vs. short vowels (ە، ی، و)
   - ڕ (rolled R) vs. ر (regular R)
   - ڵ (lateral L) vs. ل (regular L)
   - ڤ vs. ف and ق vs. ک where needed
4. Do NOT translate, summarize, or paraphrase — only transcribe.
5. If the speaker recites a Quran ayah or Hadith, transcribe those words too, exactly as recited in Arabic script — citation detection happens separately afterward, so just give accurate words and timestamps here.`;

/** Prompt for the Kurdish word-timestamp transcription pass. Replaces the old plain-
 * prose prompt for the main transcription call, since the reconstructed text (via
 * wordsToText) is used as the transcript everywhere a plain string is needed. */
export const WORD_TIMESTAMP_PROMPT = `You are an expert Kurdish (Sorani) speech transcriber. Transcribe the spoken audio word by word, with an accurate start/end timestamp (in seconds) for every word.

${SORANI_SPELLING_RULES}
6. Punctuation marks (. ، ؟ !) that fall at a natural sentence/clause boundary should be emitted as their own line, using the same start/end time as the word immediately before them.

Output format — return ONLY lines in this EXACT format, one word (or punctuation mark) per line, nothing else:
start_seconds|end_seconds|word

Example:
0.00|0.45|سڵاو
0.50|0.80|چۆنی
0.80|0.80|،
0.85|1.40|باشیت

After the last word line, add exactly one more line: CITATION:yes if any part of the audio was a recited Quran ayah or Hadith quotation, or CITATION:no if it was ordinary speech with no such recitation. Always include this line.

Return ONLY the word lines followed by the CITATION line — no markdown, no headers, no explanations, no blank lines, no other commentary.`;

const LINE_RE = /^(\d+(?:\.\d+)?)\|(\d+(?:\.\d+)?)\|(.+)$/;
const CITATION_HINT_RE = /CITATION:\s*(yes|no)/i;

/** Cheap pre-check using the model's own CITATION:yes/no line (see WORD_TIMESTAMP_PROMPT)
 * to decide whether the separate, more expensive citation-tagging pass is worth running
 * at all. Returns null when the signal is missing or malformed (e.g. output got cut off
 * before reaching it) — callers should treat null as "uncertain" and run the tagging
 * pass anyway, since skipping it is purely a latency optimization, never something that
 * should risk losing a real citation. Can't use a same-script character check instead:
 * Kurdish Sorani is written in the same Arabic Unicode block as the Arabic it's being
 * checked against, so such a check matches almost every Kurdish transcript regardless
 * of whether it contains an actual citation. */
export function hasCitationHint(raw: string): boolean | null {
  const match = raw.match(CITATION_HINT_RE);
  if (!match) return null;
  return match[1].toLowerCase() === "yes";
}

/** Parses the "start|end|word" line format. Silently skips any malformed line
 * instead of throwing — by design, a partially-truncated response should still
 * yield every word transcribed before the cutoff. */
export function parseWordTimestampLines(raw: string): TimedWord[] {
  const words: TimedWord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(LINE_RE);
    if (!match) continue;
    const start = parseFloat(match[1]);
    const end = parseFloat(match[2]);
    const word = match[3].trim();
    if (!word || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    words.push({ word, start, end });
  }
  return words;
}

const TRAILING_PUNCTUATION_RE = /^[.,،؛:؟!]+$/;

/** Joins a word array into prose text, attaching trailing punctuation (، ؟ ! .)
 * directly to the preceding word instead of leaving a stray space before it. */
export function wordsToText(words: TimedWord[]): string {
  let text = "";
  for (const w of words) {
    if (!text) { text = w.word; continue; }
    text += TRAILING_PUNCTUATION_RE.test(w.word) ? w.word : ` ${w.word}`;
  }
  return text;
}

/** Shifts every word's start/end by `offsetSeconds` — used to convert a chunk-local
 * word list (timestamps relative to that chunk's extracted clip, which always starts
 * at 0) into global timestamps matching the original uploaded audio's timeline. */
export function offsetWords(words: TimedWord[], offsetSeconds: number): TimedWord[] {
  if (offsetSeconds === 0) return words;
  return words.map(w => ({ ...w, start: w.start + offsetSeconds, end: w.end + offsetSeconds }));
}

/** Maps a timestamp measured in TRIMMED-audio time back to the ORIGINAL (untrimmed)
 * audio's timeline, using the kept-segment list from trimSilence. The browser always
 * plays back the original file, so every timestamp the model reports (relative to the
 * silence-trimmed audio it actually heard) must be remapped before reaching the
 * client. Falls back to returning the value unchanged if it doesn't fall in any kept
 * segment (shouldn't normally happen, but fails safe rather than throwing). */
function remapTrimmedTime(trimmedSeconds: number, segments: { origStart: number; origEnd: number; trimmedStart: number; trimmedEnd: number }[]): number {
  for (const seg of segments) {
    if (trimmedSeconds >= seg.trimmedStart && trimmedSeconds <= seg.trimmedEnd) {
      return seg.origStart + (trimmedSeconds - seg.trimmedStart);
    }
  }
  // Past the last segment (e.g. a word's "end" lands exactly on the trimmed
  // duration) — anchor to the last segment's original-time end plus the overrun.
  const last = segments[segments.length - 1];
  if (last && trimmedSeconds > last.trimmedEnd) return last.origEnd + (trimmedSeconds - last.trimmedEnd);
  return trimmedSeconds;
}

/** Remaps every word's start/end from trimmed-audio time to original-audio time. */
export function remapWordsToOriginalTime(words: TimedWord[], segments: { origStart: number; origEnd: number; trimmedStart: number; trimmedEnd: number }[]): TimedWord[] {
  if (segments.length === 0) return words;
  return words.map(w => ({
    ...w,
    start: remapTrimmedTime(w.start, segments),
    end: remapTrimmedTime(w.end, segments),
  }));
}

/** Sanity check that a parsed word list looks like a real transcription rather than a
 * near-total parse failure (e.g. the model ignored the line format and returned prose,
 * or a refusal). Callers should fall back to a plain-prose retry when this is false,
 * rather than silently shipping an empty/near-empty transcript. */
export function looksLikeValidWordList(words: TimedWord[], audioDurationSeconds: number): boolean {
  if (words.length === 0) return false;
  // Speech is rarely slower than ~0.5 words/sec even for deliberate speakers; well
  // below that suggests most lines failed to parse rather than genuine silence.
  if (audioDurationSeconds > 3 && words.length < audioDurationSeconds * 0.5) return false;
  return true;
}
