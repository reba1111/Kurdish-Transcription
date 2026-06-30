import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import ffmpeg from "fluent-ffmpeg";

// Files longer than this get split into overlapping chunks before transcription.
export const CHUNK_THRESHOLD_SECONDS = 5 * 60; // 5 minutes
export const CHUNK_LENGTH_SECONDS = 5 * 60; // each chunk covers 5 minutes of new content
export const CHUNK_OVERLAP_SECONDS = 5; // shared tail/head between consecutive chunks

// Out-of-band progress marker embedded in the streamed transcript response so the
// client can show "transcribing chunk X of Y" without it leaking into the visible
// text. Uses a NUL byte delimiter, which never appears in normal transcript text.
const PROGRESS_MARKER_DELIM = String.fromCharCode(0);
export const CHUNK_PROGRESS_MARKER_RE = new RegExp(`${PROGRESS_MARKER_DELIM}CHUNK_PROGRESS:(\\d+)/(\\d+)${PROGRESS_MARKER_DELIM}`, "g");

export function formatChunkProgressMarker(index: number, total: number): string {
  return `${PROGRESS_MARKER_DELIM}CHUNK_PROGRESS:${index + 1}/${total}${PROGRESS_MARKER_DELIM}`;
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

/**
 * Splits an audio file into overlapping chunks for transcription.
 * Each chunk after the first begins CHUNK_OVERLAP_SECONDS before the previous
 * chunk's end, so spoken words aren't lost at the cut points.
 * Returns the original file untouched (as a single chunk) when shorter than the threshold.
 */
export async function splitIntoChunks(inputPath: string): Promise<AudioChunk[]> {
  const totalDuration = await probeDurationSeconds(inputPath);

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
