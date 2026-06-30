import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import ffmpeg from "fluent-ffmpeg";

// Files longer than this get split into overlapping chunks before transcription.
export const CHUNK_THRESHOLD_SECONDS = 5 * 60; // 5 minutes
export const CHUNK_LENGTH_SECONDS = 5 * 60; // each chunk covers 5 minutes of new content
export const CHUNK_OVERLAP_SECONDS = 5; // shared tail/head between consecutive chunks

// Out-of-band progress markers embedded in the streamed transcript response so the
// client can show progress text ("transcribing chunk X of Y", "extracting sources...")
// without it leaking into the visible text. Uses a NUL byte delimiter, which never
// appears in normal transcript text.
const PROGRESS_MARKER_DELIM = String.fromCharCode(0);
export const CHUNK_PROGRESS_MARKER_RE = new RegExp(`${PROGRESS_MARKER_DELIM}CHUNK_PROGRESS:(\\d+)/(\\d+)${PROGRESS_MARKER_DELIM}`, "g");
export const VERIFYING_SOURCES_MARKER_RE = new RegExp(`${PROGRESS_MARKER_DELIM}VERIFYING_SOURCES${PROGRESS_MARKER_DELIM}`, "g");
// Captures a JSON-encoded TimedWord[] array — non-greedy so it stops at the first
// closing delimiter rather than swallowing the rest of the stream.
export const WORDS_MARKER_RE = new RegExp(`${PROGRESS_MARKER_DELIM}WORDS:([\\s\\S]*?)${PROGRESS_MARKER_DELIM}`, "g");

export function formatChunkProgressMarker(index: number, total: number): string {
  return `${PROGRESS_MARKER_DELIM}CHUNK_PROGRESS:${index + 1}/${total}${PROGRESS_MARKER_DELIM}`;
}

/** Emitted right before the server starts verifying Quran/Hadith citations
 * (AlQuran Cloud lookup + Google Search Grounding), which adds noticeable latency
 * on top of the transcription itself. */
export function formatVerifyingSourcesMarker(): string {
  return `${PROGRESS_MARKER_DELIM}VERIFYING_SOURCES${PROGRESS_MARKER_DELIM}`;
}

/** Embeds a chunk's (already globally-offset) word timestamps in the streamed
 * response, so the client gets the karaoke/subtitle word list for free as part of
 * the main transcription instead of needing a second audio call to fetch it. */
export function formatWordsMarker(words: { word: string; start: number; end: number }[]): string {
  return `${PROGRESS_MARKER_DELIM}WORDS:${JSON.stringify(words)}${PROGRESS_MARKER_DELIM}`;
}

export interface AudioChunk {
  filePath: string;
  /** start time of this chunk within the original audio, in seconds */
  start: number;
  /** end time of this chunk within the original audio, in seconds */
  end: number;
  /** seconds of overlap shared with the previous chunk (0 for the first chunk) */
  overlapWithPrevious: number;
  index: number;
}

/**
 * Reads the media duration (in seconds) by parsing ffmpeg's own stderr output.
 * Avoids depending on a separate ffprobe binary, which isn't bundled here.
 */
export function probeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    ffmpeg(filePath)
      .on("stderr", (line) => {
        stderr += line + "\n";
      })
      .on("error", (err) => {
        const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (match) {
          const [, h, m, s] = match;
          resolve(Number(h) * 3600 + Number(m) * 60 + Number(s));
        } else {
          reject(err);
        }
      })
      .on("end", () => {
        const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (match) {
          const [, h, m, s] = match;
          resolve(Number(h) * 3600 + Number(m) * 60 + Number(s));
        } else {
          reject(new Error("Could not determine audio duration"));
        }
      })
      // -f null with no output triggers ffmpeg to print Duration and exit
      .outputOptions(["-f", "null"])
      .output(os.platform() === "win32" ? "NUL" : "/dev/null")
      .run();
  });
}

function extractSegment(inputPath: string, outputPath: string, startSec: number, durationSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSec)
      .duration(durationSec)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioBitrate("32k")
      .toFormat("mp3")
      .on("end", () => resolve())
      .on("error", reject)
      .save(outputPath);
  });
}

// ── Silence trimming ───────────────────────────────────────────────────────────
// Gemini/ElevenLabs bill audio by duration, so long dead-air stretches (common in
// lecture/meeting recordings) cost real money for nothing. We detect them with
// ffmpeg's silencedetect filter and physically cut them out before any model sees
// the file. Since the browser still plays back the ORIGINAL (untrimmed) audio, every
// returned word timestamp must be mapped from trimmed-audio time back to
// original-audio time — `SpeechSegment[]` is that mapping.

const SILENCE_NOISE_THRESHOLD_DB = "-35dB";
const SILENCE_MIN_DURATION_SECONDS = 1.5; // pauses shorter than this are natural speech rhythm, not dead air
const SILENCE_PADDING_SECONDS = 0.3; // kept on both sides of a cut so word onsets/offsets aren't clipped
const MIN_TOTAL_SILENCE_TO_TRIM_SECONDS = 3; // skip the re-encode pass if savings would be negligible

export interface SpeechSegment {
  /** start/end of this kept segment in the ORIGINAL (untrimmed) audio's timeline */
  origStart: number;
  origEnd: number;
  /** start/end of this kept segment in the TRIMMED (output) audio's timeline */
  trimmedStart: number;
  trimmedEnd: number;
}

export interface SilenceTrimResult {
  /** The trimmed file, or the original inputPath unchanged when nothing was trimmed. */
  filePath: string;
  /** null when no trimming was applied — callers should use original timestamps as-is. */
  segments: SpeechSegment[] | null;
  /** Duration of the returned file (trimmed duration if segments is non-null, original
   * duration otherwise) — callers should use this instead of re-probing, since trimSilence
   * already determined it from the same ffmpeg pass. */
  durationSeconds: number;
}

interface RawInterval { start: number; end: number; }
interface ProbeWithSilenceResult { duration: number; silences: RawInterval[]; }

/** Single ffmpeg pass that reads BOTH the duration (from ffmpeg's own startup banner)
 * and silence intervals (via the silencedetect filter) — both come from the same
 * decode, so there's no need for a separate duration-only probe before or after this.
 * An unterminated trailing silence_start (audio ends while still silent) is
 * conservatively dropped rather than guessed at. */
function probeWithSilenceDetection(inputPath: string): Promise<ProbeWithSilenceResult> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const finish = () => {
      const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!durMatch) { reject(new Error("Could not determine audio duration")); return; }
      const [, h, m, s] = durMatch;
      const duration = Number(h) * 3600 + Number(m) * 60 + Number(s);

      const starts = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map(mt => parseFloat(mt[1]));
      const ends = [...stderr.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map(mt => parseFloat(mt[1]));
      const silences: RawInterval[] = [];
      for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
        if (ends[i] > starts[i]) silences.push({ start: starts[i], end: ends[i] });
      }
      resolve({ duration, silences });
    };
    ffmpeg(inputPath)
      .audioFilters(`silencedetect=noise=${SILENCE_NOISE_THRESHOLD_DB}:d=${SILENCE_MIN_DURATION_SECONDS}`)
      .on("stderr", (line) => { stderr += line + "\n"; })
      .on("error", finish) // -f null commonly "errors" on exit for this probe-only usage; the log is still complete
      .on("end", finish)
      .outputOptions(["-f", "null"])
      .output(os.platform() === "win32" ? "NUL" : "/dev/null")
      .run();
  });
}

/** Computes the kept (non-silent) ranges in the ORIGINAL timeline — the complement of
 * the detected silences, padded slightly so cuts don't clip word edges. */
function computeSpeechRanges(silences: RawInterval[], totalDuration: number): RawInterval[] {
  const ranges: RawInterval[] = [];
  let cursor = 0;
  for (const s of silences) {
    const segEnd = Math.min(Math.max(cursor, s.start + SILENCE_PADDING_SECONDS), totalDuration);
    if (segEnd > cursor) ranges.push({ start: cursor, end: segEnd });
    cursor = Math.max(cursor, s.end - SILENCE_PADDING_SECONDS);
  }
  if (cursor < totalDuration) ranges.push({ start: cursor, end: totalDuration });
  return ranges;
}

/** Builds the trimmed file by concatenating each kept range via an ffmpeg complex
 * filtergraph (atrim per range + concat), re-encoding once to 16kHz mono mp3. */
function buildTrimmedAudio(inputPath: string, outputPath: string, ranges: RawInterval[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const filterParts = ranges.map((r, i) => `[0:a]atrim=start=${r.start}:end=${r.end},asetpts=PTS-STARTPTS[a${i}]`);
    const concatInputs = ranges.map((_, i) => `[a${i}]`).join("");
    filterParts.push(`${concatInputs}concat=n=${ranges.length}:v=0:a=1[outa]`);

    ffmpeg(inputPath)
      .complexFilter(filterParts, "outa")
      .audioFrequency(16000)
      .audioChannels(1)
      .audioBitrate("32k")
      .toFormat("mp3")
      .on("end", () => resolve())
      .on("error", reject)
      .save(outputPath);
  });
}

/**
 * Detects and removes long internal silences from an audio file before it's sent to
 * any model, since both Gemini and ElevenLabs bill by audio duration. Fails open at
 * every step — any detection or encoding failure returns the original file untouched
 * with `segments: null`, never blocking transcription on this being an optimization.
 */
export async function trimSilence(inputPath: string): Promise<SilenceTrimResult> {
  let totalDuration: number;
  let silences: RawInterval[];
  try {
    const probe = await probeWithSilenceDetection(inputPath);
    totalDuration = probe.duration;
    silences = probe.silences;
  } catch {
    // Fall back to a plain duration-only probe — callers always need a duration even
    // when silencedetect itself fails for some reason.
    try {
      totalDuration = await probeDurationSeconds(inputPath);
    } catch {
      return { filePath: inputPath, segments: null, durationSeconds: 0 };
    }
    return { filePath: inputPath, segments: null, durationSeconds: totalDuration };
  }

  if (silences.length === 0) return { filePath: inputPath, segments: null, durationSeconds: totalDuration };

  const speechRanges = computeSpeechRanges(silences, totalDuration);
  if (speechRanges.length === 0) return { filePath: inputPath, segments: null, durationSeconds: totalDuration };

  const keptDuration = speechRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const removedDuration = totalDuration - keptDuration;
  if (removedDuration < MIN_TOTAL_SILENCE_TO_TRIM_SECONDS) return { filePath: inputPath, segments: null, durationSeconds: totalDuration };

  const outputPath = path.join(os.tmpdir(), `trimmed-${crypto.randomBytes(8).toString("hex")}.mp3`);
  try {
    await buildTrimmedAudio(inputPath, outputPath, speechRanges);
  } catch (e) {
    console.warn("[SilenceTrim] Trim encode failed, using original audio:", e);
    return { filePath: inputPath, segments: null, durationSeconds: totalDuration };
  }

  let trimmedCursor = 0;
  const segments: SpeechSegment[] = speechRanges.map(r => {
    const duration = r.end - r.start;
    const seg: SpeechSegment = { origStart: r.start, origEnd: r.end, trimmedStart: trimmedCursor, trimmedEnd: trimmedCursor + duration };
    trimmedCursor += duration;
    return seg;
  });

  console.log(`[SilenceTrim] Removed ${removedDuration.toFixed(1)}s of silence (${totalDuration.toFixed(1)}s → ${keptDuration.toFixed(1)}s)`);
  return { filePath: outputPath, segments, durationSeconds: keptDuration };
}

/**
 * Splits an audio file into overlapping chunks for transcription.
 * Each chunk after the first begins CHUNK_OVERLAP_SECONDS before the previous
 * chunk's end, so spoken words aren't lost at the cut points.
 * Returns the original file untouched (as a single chunk) when shorter than the threshold.
 * Accepts an already-known duration to skip a redundant probe pass when the caller
 * has already determined it (e.g. via trimSilence).
 */
export async function splitIntoChunks(inputPath: string, knownDurationSeconds?: number): Promise<AudioChunk[]> {
  const totalDuration = knownDurationSeconds ?? await probeDurationSeconds(inputPath);

  if (totalDuration <= CHUNK_THRESHOLD_SECONDS) {
    return [{ filePath: inputPath, start: 0, end: totalDuration, overlapWithPrevious: 0, index: 0 }];
  }

  const chunks: AudioChunk[] = [];
  const tmpDir = os.tmpdir();
  let start = 0;
  let index = 0;

  try {
    // Each chunk covers CHUNK_LENGTH_SECONDS of new content plus a CHUNK_OVERLAP_SECONDS
    // tail, e.g. 00:00-05:05, 05:00-10:05, 10:00-15:05 — so consecutive chunks always
    // share the same 5-second boundary region.
    while (start < totalDuration) {
      const overlapWithPrevious = index === 0 ? 0 : CHUNK_OVERLAP_SECONDS;
      const segmentStart = Math.max(0, start - overlapWithPrevious);
      const segmentEnd = Math.min(totalDuration, start + CHUNK_LENGTH_SECONDS + CHUNK_OVERLAP_SECONDS);
      const segmentDuration = segmentEnd - segmentStart;

      const outputPath = path.join(tmpDir, `chunk-${crypto.randomBytes(8).toString("hex")}-${index}.mp3`);
      await extractSegment(inputPath, outputPath, segmentStart, segmentDuration);

      chunks.push({
        filePath: outputPath,
        start: segmentStart,
        end: segmentEnd,
        overlapWithPrevious,
        index,
      });

      start += CHUNK_LENGTH_SECONDS;
      index += 1;
    }
  } catch (err) {
    // Don't leak partially-written chunk files if splitting fails partway through.
    cleanupChunks(chunks, inputPath);
    throw err;
  }

  return chunks;
}

export function cleanupChunks(chunks: AudioChunk[], originalPath: string) {
  for (const chunk of chunks) {
    if (chunk.filePath === originalPath) continue; // never delete the original upload
    try {
      fs.unlinkSync(chunk.filePath);
    } catch {
      // best-effort cleanup
    }
  }
}
