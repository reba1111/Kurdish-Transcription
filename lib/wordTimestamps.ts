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

Return ONLY these lines — no markdown, no headers, no explanations, no blank lines, no commentary.`;

const LINE_RE = /^(\d+(?:\.\d+)?)\|(\d+(?:\.\d+)?)\|(.+)$/;

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
