import fs from "fs";
import type { GoogleGenAI } from "@google/genai";
import { cleanupChunks, splitIntoChunks } from "./audioChunker";
import { ISLAMIC_TEXT_SYSTEM_INSTRUCTION, verifyAndAnnotate } from "./islamicTextVerifier";

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
  onChunkStart?: (index: number, total: number) => void;
  /** Called right before a chunk's Quran/Hadith citations are verified — only fires when the chunk actually contains tags to check. */
  onVerifyingStart?: () => void;
  /** Called with each chunk's transcribed text as soon as it's ready, for progressive streaming to the client. */
  onChunkText?: (text: string, index: number, total: number) => void;
}): Promise<string> {
  const { ai, inputPath, mimeType, models, promptText, useIslamicSystemPrompt, onChunkStart, onVerifyingStart, onChunkText } = args;
  const chunks = await splitIntoChunks(inputPath);

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

      const text = await transcribeChunkWithFallback({
        ai,
        models,
        mimeType: chunkMimeType,
        audioBase64: chunkBuffer.toString("base64"),
        promptText: finalPrompt,
        useIslamicSystemPrompt,
      });

      const trimmed = text.trim();
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
