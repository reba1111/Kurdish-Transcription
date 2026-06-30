import fs from "fs";
import type { GoogleGenAI } from "@google/genai";
import { cleanupChunks, splitIntoChunks, type SpeechSegment } from "./audioChunker";
import { ISLAMIC_TEXT_SYSTEM_INSTRUCTION, tagIslamicCitations, verifyAndAnnotate } from "./islamicTextVerifier";
import { looksLikeValidWordList, offsetWords, parseWordTimestampLines, remapWordsToOriginalTime, wordsToText, type TimedWord } from "./wordTimestamps";

const SENTENCE_END_RE = /[.!?؟،۔]/;
const ANY_TAG_RE = /<\/?(?:quran|hadith)[^>]*>/g;

/** Extracts the last sentence of a transcript, used as continuation context for the next chunk.
 * Strips quran/hadith tags first so raw markup never leaks into the next chunk's prompt. */
function lastSentence(text: string): string {
  const trimmed = text.replace(ANY_TAG_RE, "").trim();
  if (!trimmed) return "";
  const matches = [...trimmed.matchAll(new RegExp(SENTENCE_END_RE, "g"))];
  if (matches.length === 0) return trimmed;
  const lastBoundary = matches[matches.length - 1].index ?? -1;
  const secondToLastBoundary = matches.length > 1 ? matches[matches.length - 2].index ?? -1 : -1;
  return trimmed.slice(secondToLastBoundary + 1, lastBoundary + 1).trim();
}

const continuationPrompt = (basePrompt: string, previousTailText: string, chunkNumber: number) =>
  `${basePrompt}

IMPORTANT — CONTINUATION CONTEXT: This is part ${chunkNumber} of a longer audio file. The previous part ended with this already-transcribed sentence:
"${previousTailText}"

The first few seconds of this audio repeat that same sentence. Start your output from where that sentence left off — do NOT transcribe or repeat it again. Continue seamlessly as if producing one continuous transcript.`;

interface TranscribeChunkArgs {
  ai: GoogleGenAI;
  models: string[];
  mimeType: string;
  audioBase64: string;
  promptText: string;
  useIslamicSystemPrompt?: boolean;
}

async function transcribeChunkWithFallback({ ai, models, mimeType, audioBase64, promptText, useIslamicSystemPrompt }: TranscribeChunkArgs): Promise<string> {
  const audioPart = { inlineData: { mimeType, data: audioBase64 } };

  let lastError: any = null;
  for (const modelName of models) {
    try {
      const result = await ai.models.generateContent({
        model: modelName,
        config: {
          temperature: 0,
          ...(useIslamicSystemPrompt ? { systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION } : {}),
        },
        contents: [{ parts: [audioPart, { text: promptText }] }],
      });
      return result.text || "";
    } catch (err: any) {
      const status = err?.status || err?.code;
      const msg = String(err?.message || "");
      const isRetryable = status === 429 || status === 503 || status === 500
        || msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("high demand") || msg.includes("quota");
      if (isRetryable) { lastError = err; continue; }
      throw err;
    }
  }
  throw lastError || new Error("All models failed");
}

interface TranscribeChunkWordsArgs {
  ai: GoogleGenAI;
  models: string[];
  mimeType: string;
  audioBase64: string;
  promptText: string;
  proseFallbackPromptText: string;
  chunkDurationSeconds: number;
}

interface ChunkWordsResult {
  words: TimedWord[]; // chunk-local timestamps, NOT yet offset to the global timeline
  text: string;
  usedModel: string | null; // null when the prose fallback had to be used (no words available)
}

/** Same retry-across-models behavior as transcribeChunkWithFallback, but requests
 * word+timestamp lines instead of plain prose, falling back to a plain-prose call
 * (losing word-timestamps for just this chunk) only if every model's word-timestamp
 * attempt produces unusable output — the transcript itself must never be lost. */
async function transcribeChunkWordsWithFallback({ ai, models, mimeType, audioBase64, promptText, proseFallbackPromptText, chunkDurationSeconds }: TranscribeChunkWordsArgs): Promise<ChunkWordsResult> {
  const audioPart = { inlineData: { mimeType, data: audioBase64 } };

  let lastError: any = null;
  for (const modelName of models) {
    try {
      const result = await ai.models.generateContent({
        model: modelName,
        config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
        contents: [{ parts: [audioPart, { text: promptText }] }],
      });
      const parsed = parseWordTimestampLines(result.text || "");
      if (looksLikeValidWordList(parsed, chunkDurationSeconds)) {
        return { words: parsed, text: wordsToText(parsed), usedModel: modelName };
      }
      console.warn(`[Chunking] ${modelName} word-timestamp output didn't look valid, trying next model`);
    } catch (err: any) {
      const status = err?.status || err?.code;
      const msg = String(err?.message || "");
      const isRetryable = status === 429 || status === 503 || status === 500
        || msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("high demand") || msg.includes("quota");
      if (isRetryable) { lastError = err; continue; }
      throw err;
    }
  }

  const result = await ai.models.generateContent({
    model: models[models.length - 1],
    config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
    contents: [{ parts: [audioPart, { text: proseFallbackPromptText }] }],
  });
  const text = result.text || "";
  if (!text) throw lastError || new Error("All models failed");
  return { words: [], text, usedModel: null };
}

/**
 * Transcribes a long audio file by splitting it into overlapping chunks and
 * stitching the per-chunk results into one continuous transcript. The first
 * chunk is sent as a plain audio file. Every following chunk is sent with the
 * previous chunk's last transcribed sentence given as text context in the
 * prompt, instructing the model to resume from there instead of re-transcribing
 * the shared overlap audio at its start.
 */
export async function transcribeLongAudio(args: {
  ai: GoogleGenAI;
  inputPath: string;
  mimeType: string;
  models: string[];
  promptText: string;
  /** Set when promptText includes ISLAMIC_TEXT_DETECTION_RULE, so each chunk call also gets the matching system instruction. */
  useIslamicSystemPrompt?: boolean;
  /** When true, a chunk whose (cheap) Flash transcription contains a Quran/Hadith tag gets
   * re-transcribed with gemini-2.5-pro before verification, for more reliable citation —
   * keeping Pro off the cost path for the (vast majority of) chunks with plain speech. */
  wantsProUpgrade?: boolean;
  /** When true, promptText is treated as WORD_TIMESTAMP_PROMPT: each chunk requests
   * word+timestamp lines (parsed, reconstructed into prose, and offset to the global
   * timeline) instead of plain prose — giving the karaoke/subtitle word list for free
   * from the same audio call instead of a separate, doubly-priced one. Requires
   * proseFallbackPromptText as the safety net for chunks whose word-timestamp output
   * doesn't parse usably.
   */
  useWordTimestamps?: boolean;
  proseFallbackPromptText?: string;
  /** Kept-segment map from trimSilence, when inputPath is a silence-trimmed file —
   * remaps each chunk's (already chunk-offset) word timestamps from the trimmed
   * audio's timeline back to the original upload's timeline, since chunk boundaries
   * (splitIntoChunks) are computed against the TRIMMED file's duration. Omit when
   * inputPath is the original, untrimmed audio. */
  speechSegments?: SpeechSegment[];
  /** Already-known duration of inputPath (e.g. from trimSilence) — skips a redundant
   * ffmpeg probe pass inside splitIntoChunks when provided. */
  knownDurationSeconds?: number;
  onChunkStart?: (index: number, total: number) => void;
  /** Called right before a chunk's Quran/Hadith citations are verified — only fires when the chunk actually contains tags to check. */
  onVerifyingStart?: () => void;
  /** Called with each chunk's transcribed text as soon as it's ready, for progressive streaming to the client. */
  onChunkText?: (text: string, index: number, total: number) => void;
  /** Called with each chunk's word list (already offset to the global timeline) as soon as it's ready. Only fires when useWordTimestamps is set and the chunk produced usable timestamps. */
  onWordsChunk?: (words: TimedWord[]) => void;
}): Promise<string> {
  const { ai, inputPath, mimeType, models, promptText, useIslamicSystemPrompt, wantsProUpgrade, useWordTimestamps, proseFallbackPromptText, speechSegments, knownDurationSeconds, onChunkStart, onVerifyingStart, onChunkText, onWordsChunk } = args;
  const chunks = await splitIntoChunks(inputPath, knownDurationSeconds);

  try {
    const parts: string[] = [];
    let previousTail = "";
    for (const chunk of chunks) {
      onChunkStart?.(chunk.index, chunks.length);
      const chunkBuffer = fs.readFileSync(chunk.filePath);
      const chunkMimeType = chunks.length > 1 ? "audio/mpeg" : mimeType;
      const finalPrompt = chunk.index === 0 || !previousTail
        ? promptText
        : continuationPrompt(promptText, previousTail, chunk.index + 1);
      const audioBase64 = chunkBuffer.toString("base64");
      const chunkDurationSeconds = chunk.end - chunk.start;

      let text: string;
      let taggedText: string;

      if (useWordTimestamps) {
        const finalProseFallback = chunk.index === 0 || !previousTail
          ? proseFallbackPromptText!
          : continuationPrompt(proseFallbackPromptText!, previousTail, chunk.index + 1);

        let { words, text: reconstructed, usedModel } = await transcribeChunkWordsWithFallback({
          ai,
          models,
          mimeType: chunkMimeType,
          audioBase64,
          promptText: finalPrompt,
          proseFallbackPromptText: finalProseFallback,
          chunkDurationSeconds,
        });

        taggedText = await tagIslamicCitations(ai, reconstructed);

        if (wantsProUpgrade && usedModel && usedModel !== "gemini-2.5-pro" && /<quran |<hadith /.test(taggedText)) {
          try {
            const proResult = await transcribeChunkWordsWithFallback({
              ai,
              models: ["gemini-2.5-pro"],
              mimeType: chunkMimeType,
              audioBase64,
              promptText: finalPrompt,
              proseFallbackPromptText: finalProseFallback,
              chunkDurationSeconds,
            });
            if (proResult.text) {
              words = proResult.words;
              reconstructed = proResult.text;
              taggedText = await tagIslamicCitations(ai, reconstructed);
            }
          } catch (e) {
            console.warn("[Chunking] Pro re-run for Quran/Hadith failed, keeping original output:", e);
          }
        }

        text = reconstructed;
        if (words.length > 0) {
          const globalWords = offsetWords(words, chunk.start);
          onWordsChunk?.(speechSegments ? remapWordsToOriginalTime(globalWords, speechSegments) : globalWords);
        }
      } else {
        text = await transcribeChunkWithFallback({
          ai,
          models,
          mimeType: chunkMimeType,
          audioBase64,
          promptText: finalPrompt,
          useIslamicSystemPrompt,
        });

        if (wantsProUpgrade && !models.includes("gemini-2.5-pro") && /<quran |<hadith /.test(text)) {
          try {
            const proText = await transcribeChunkWithFallback({
              ai,
              models: ["gemini-2.5-pro"],
              mimeType: chunkMimeType,
              audioBase64,
              promptText: finalPrompt,
              useIslamicSystemPrompt,
            });
            if (proText) text = proText;
          } catch (e) {
            console.warn("[Chunking] Pro re-run for Quran/Hadith failed, keeping Flash output:", e);
          }
        }

        taggedText = text;
      }

      const trimmed = taggedText.trim();
      // Verify any Quran citations before this chunk's text is forwarded — a no-op
      // when the chunk contains no <quran> tags (e.g. non-religious or Arabic-translation content).
      if (/<quran |<hadith /.test(trimmed)) onVerifyingStart?.();
      const annotated = trimmed ? await verifyAndAnnotate(trimmed, ai) : trimmed;
      parts.push(annotated);
      if (trimmed) previousTail = lastSentence(trimmed);
      if (annotated) onChunkText?.((chunk.index === 0 ? "" : " ") + annotated, chunk.index, chunks.length);
    }
    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  } finally {
    cleanupChunks(chunks, inputPath);
  }
}
