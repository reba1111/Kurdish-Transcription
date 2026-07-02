import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { CHUNK_THRESHOLD_SECONDS, formatChunkProgressMarker, formatVerifyingSourcesMarker, formatWordsMarker, trimSilence } from "./lib/audioChunker";
import { transcribeLongAudio } from "./lib/chunkedTranscription";
import { ISLAMIC_TEXT_DETECTION_RULE, ISLAMIC_TEXT_SYSTEM_INSTRUCTION, tagIslamicCitations, verifyAndAnnotate } from "./lib/islamicTextVerifier";
import { searchHadithByMeaning } from "./lib/hadithSearch";
import { correctArabicGrammar } from "./lib/arabicGrammarCorrector";
import { looksLikeValidWordList, parseWordTimestampLines, remapWordsToOriginalTime, WORD_TIMESTAMP_PROMPT, wordsToText, type TimedWord } from "./lib/wordTimestamps";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const app = express();
const PORT = 3000;

// Allowed values — whitelist to prevent injection
const ALLOWED_LANGUAGES = new Set(['ku', 'ar']);
const ALLOWED_MODELS = new Set(['gemini', 'gemini-pro', 'gemini-flash2', 'scribe']);
const ALLOWED_FORMATS = new Set(['srt', 'vtt']);
const ALLOWED_MIMES = new Set([
  'audio/mpeg','audio/mp3','audio/wav','audio/ogg','audio/webm','audio/mp4',
  'audio/aac','audio/flac','audio/x-m4a','audio/m4a',
  'video/webm','video/mp4','application/ogg',
]);

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

/** Rewrites a Gemini quota-exhaustion error into a friendly Kurdish message with the
 * UTC-midnight reset time converted to Kurdistan local time. Passes any other error
 * through unchanged. */
function friendlyQuotaError(err: any): Error {
  const msg = String(err?.message || "");
  if (msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("429")) {
    const nowUTC = new Date();
    const resetUTC = new Date(nowUTC);
    resetUTC.setUTCHours(24, 0, 0, 0);
    const diffMs = resetUTC.getTime() - nowUTC.getTime();
    const diffH = Math.floor(diffMs / 3600000);
    const diffM = Math.floor((diffMs % 3600000) / 60000);
    const resetKurdish = new Date(resetUTC.getTime() + 3 * 3600000);
    const kh = resetKurdish.getUTCHours().toString().padStart(2, "0");
    const km = resetKurdish.getUTCMinutes().toString().padStart(2, "0");
    return new Error(`کۆتای داواکاری ڕۆژانەی Gemini تەواو بووە. دووبارە دەستپێ دەکاتەوە لە ساعەت ${kh}:${km} بەیانی کوردستان (${diffH} کاتژمێر و ${diffM} خولەک دیکە). تکایە مۆدێلی ElevenLabs Scribe بەکاربهێنە یان چاوەڕوانبە.`);
  }
  return err instanceof Error ? err : new Error(msg || "Unknown error");
}

app.use(express.json({ limit: '1mb' }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// API route for audio transcription
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const targetLanguage = ALLOWED_LANGUAGES.has(req.body.language) ? req.body.language : 'ku';
    const selectedModel = ALLOWED_MODELS.has(req.body.model) ? req.body.model : 'gemini';

    let mimeType = req.file.mimetype.split(';')[0];
    if (!ALLOWED_MIMES.has(mimeType)) {
      return res.status(400).json({ error: "جۆری فایلەکە پشتگیری نەکراوە." });
    }
    if (mimeType === 'application/ogg') mimeType = 'audio/ogg';
    if (mimeType === 'video/webm') mimeType = 'audio/webm';
    if (mimeType === 'video/mp4') mimeType = 'audio/mp4';

    let finalBuffer = req.file.buffer;
    let finalMimeType = mimeType;
    let finalFileName = req.file.originalname || "audio.ogg";

    const fileSizeMB = req.file.buffer.length / 1024 / 1024;
    const shouldCompress = req.body.compress === "true" || fileSizeMB > 20;

    if (shouldCompress) {
      const tempInput = path.join(os.tmpdir(), crypto.randomBytes(16).toString("hex") + ".tmp");
      const tempOutput = path.join(os.tmpdir(), crypto.randomBytes(16).toString("hex") + ".mp3");
      fs.writeFileSync(tempInput, req.file.buffer);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(tempInput)
          .audioFrequency(16000)
          .audioChannels(1)
          .audioBitrate('32k')
          .toFormat('mp3')
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .save(tempOutput);
      });

      finalBuffer = fs.readFileSync(tempOutput);
      finalMimeType = "audio/mpeg";
      finalFileName = "compressed.mp3";

      console.log(`[Audio] Original: ${fileSizeMB.toFixed(2)}MB → Compressed: ${(finalBuffer.length / 1024 / 1024).toFixed(2)}MB${fileSizeMB > 20 ? ' (auto-compressed: over 20MB)' : ''}`);

      try {
        fs.unlinkSync(tempInput);
        fs.unlinkSync(tempOutput);
      } catch (e) {}
    }

    // 1. SCRIBE (ELEVENLABS) PATH
    if (selectedModel === 'scribe') {
      if (!process.env.ELEVENLABS_API_KEY) {
         return res.status(500).json({ error: "ELEVENLABS_API_KEY is not configured" });
      }
      
      const scribeForm = new FormData();
      const blob = new Blob([finalBuffer], { type: finalMimeType });
      scribeForm.append("file", blob, finalFileName);
      scribeForm.append("model_id", "scribe_v1");
      scribeForm.append("language_code", "ckb"); // Central Kurdish (Sorani) — force language
      scribeForm.append("tag_audio_events", "false");

      const elRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
        body: scribeForm
      });
      const elData = await elRes.json();

      if (!elRes.ok) throw new Error(elData.detail?.message || "ElevenLabs transcription failed");

      let finalOutput = elData.text || "";

      // Clean any non-Kurdish garbage — if output contains mostly non-Arabic-script chars, it likely mis-detected
      const arabicScriptRatio = (finalOutput.match(/[؀-ۿ]/g) || []).length / Math.max(finalOutput.replace(/\s/g, '').length, 1);
      if (arabicScriptRatio < 0.3 && finalOutput.trim().length > 0) {
        // Scribe mis-detected language — use Gemini to re-transcribe
        finalOutput = "";
      }

      if (targetLanguage === 'ar') {
        const arPrompt = finalOutput.trim()
          ? `You are a professional Arabic translator with deep expertise in Kurdish (Sorani) to Arabic translation. Translate the following Kurdish text into flawless Modern Standard Arabic (Fusha). Return ONLY the Arabic translation — no explanations, no markdown, no HTML.\n\nKurdish text:\n${finalOutput}`
          : `You are a professional Arabic translator. The following audio is in Kurdish (Sorani). Listen carefully and translate directly into flawless Modern Standard Arabic (Fusha). Return ONLY the Arabic translation.`;

        const chatRes = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          config: { temperature: 0 },
          contents: arPrompt
        });
        finalOutput = (chatRes.text || finalOutput).replace(/```[a-z]*\n?/g, '').replace(/```/g, '').replace(/<[^>]*>?/gm, '').trim();
      } else if (process.env.GEMINI_API_KEY && finalOutput.trim()) {
        // Scribe is a plain ASR — it can't follow tagging instructions itself, so give
        // its Kurdish output a quick Gemini pass to detect/tag any Quran or Hadith
        // recitation, then verify the Quran citations. Only worth the extra call when
        // the output actually contains a meaningful chunk of Arabic script.
        const arabicCharCount = (finalOutput.match(/[؀-ۿ]/g) || []).length;
        if (arabicCharCount > 10) {
          try {
            const tagPrompt = `The following is a Kurdish (Sorani) speech transcript. If any part of it is a recited Quran ayah or Hadith quotation, mark it using the rules below. Return the FULL text unchanged otherwise — do not translate, summarize, or alter any other wording.${ISLAMIC_TEXT_DETECTION_RULE}

Transcript:
${finalOutput}`;
            const tagRes = await ai.models.generateContent({
              model: "gemini-2.5-flash",
              config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
              contents: tagPrompt,
            });
            const tagged = (tagRes.text || "").trim();
            if (tagged) finalOutput = await verifyAndAnnotate(tagged, ai);
          } catch (e) {
            console.warn("[Scribe] Quran/Hadith tagging pass failed, keeping raw output:", e);
          }
        }
      }

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(finalOutput);
      return;
    }

    // 3. DEFAULT GEMINI PATH
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Gemini API key is not configured" });
    }

    const arabicPromptText = `You are a professional Arabic translator and linguist with deep expertise in Kurdish (Sorani) to Arabic translation. Listen to the Kurdish audio carefully and produce a flawless, publication-quality Arabic translation.

Rules:
- Translate into Modern Standard Arabic (Fusha/MSA) with rich, natural vocabulary
- Preserve the original meaning, tone, and nuance precisely
- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب)
- Choose the most contextually appropriate Arabic word for each Kurdish term
- Maintain the flow and rhythm of the original speech — do not make it sound robotic
- If a proper noun or name appears, transliterate it correctly into Arabic
- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML`;

    // Last-resort fallback when every model's word-timestamp attempt (WORD_TIMESTAMP_PROMPT,
    // used below) produces unusable output — guarantees a working transcript even when
    // word-timestamps can't be recovered for this particular request.
    const kurdishProseFallbackPrompt = `You are an expert transcriber. Transcribe the spoken Kurdish audio highly accurately using Kurdish script. Ensure correct spelling and grammar. Return ONLY the pure transcribed text, without markdown or html tags.${ISLAMIC_TEXT_DETECTION_RULE}`;

    // Kept as a generic name for the chunked path below, which still branches on language.
    const promptText = targetLanguage === 'ar' ? arabicPromptText : WORD_TIMESTAMP_PROMPT;

    // "gemini-pro" no longer calls Pro directly — Pro costs ~6-7x Flash per minute of
    // audio. Instead we transcribe with Flash first and only re-run the (much cheaper)
    // Flash output through Pro when it actually contains a Quran/Hadith citation, since
    // Pro is meaningfully more reliable at diacritizing/citing recited religious text.
    // Plain speech, which is the vast majority of usage, never touches Pro at all.
    const wantsProUpgrade = selectedModel === 'gemini-pro';
    const models = selectedModel === 'gemini-flash2'
      ? ["gemini-2.5-flash"]
      : ["gemini-2.5-flash"];

    // Long files get split into overlapping 5-minute chunks so each request stays
    // fast and reliable; short files keep the original single-shot streaming path.
    const tempInputPath = path.join(os.tmpdir(), crypto.randomBytes(16).toString("hex") + ".mp3");
    fs.writeFileSync(tempInputPath, finalBuffer);

    // Save the original buffer/mime before trimming so word-timestamp calls can use
    // the untrimmed audio — Gemini reports timestamps relative to what it hears, and
    // the browser plays the original file, so feeding trimmed audio for timestamps
    // would produce offsets that don't match playback.
    const originalBuffer = finalBuffer;
    const originalMimeType = finalMimeType;

    // Both Gemini and ElevenLabs bill audio by duration, so long dead-air stretches
    // (common in lectures/meetings) cost real money for nothing. Cut them out before
    // any model sees the file. trimSilence fails open (returns tempInputPath
    // unchanged) on any detection/encode error.
    const trimResult = await trimSilence(tempInputPath);
    const effectiveInputPath = trimResult.filePath;
    const speechSegments = trimResult.segments;
    if (speechSegments) {
      finalBuffer = fs.readFileSync(effectiveInputPath);
      finalMimeType = "audio/mpeg"; // trimSilence always re-encodes to mp3
    }

    // Duration already came from trimSilence's own probe — no need to re-probe here.
    const durationSeconds = trimResult.durationSeconds;

    if (durationSeconds > CHUNK_THRESHOLD_SECONDS) {
      try {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        await transcribeLongAudio({
          ai,
          inputPath: effectiveInputPath,
          mimeType: finalMimeType,
          models,
          promptText,
          useIslamicSystemPrompt: targetLanguage === 'ku',
          wantsProUpgrade,
          useWordTimestamps: targetLanguage === 'ku',
          proseFallbackPromptText: targetLanguage === 'ku' ? kurdishProseFallbackPrompt : undefined,
          speechSegments: speechSegments ?? undefined,
          knownDurationSeconds: durationSeconds,
          onChunkStart: (index, total) => {
            console.log(`[Chunking] transcribing chunk ${index + 1}/${total}`);
            res.write(formatChunkProgressMarker(index, total));
          },
          onVerifyingStart: () => res.write(formatVerifyingSourcesMarker()),
          onChunkText: (text) => res.write(text),
          onWordsChunk: (words) => res.write(formatWordsMarker(words)),
        });
        res.end();
        return;
      } finally {
        try { fs.unlinkSync(tempInputPath); } catch {}
        if (speechSegments) { try { fs.unlinkSync(effectiveInputPath); } catch {} }
      }
    }
    try { fs.unlinkSync(tempInputPath); } catch {}
    if (speechSegments) { try { fs.unlinkSync(effectiveInputPath); } catch {} }

    // Transcript audio: trimmed (silence removed) to save API cost.
    const audioPart = {
      inlineData: {
        mimeType: finalMimeType,
        data: finalBuffer.toString("base64"),
      },
    };
    // Timestamp audio: always the original untrimmed file so Gemini's reported
    // offsets match what the browser is actually playing back.
    const audioPartOriginal = {
      inlineData: {
        mimeType: originalMimeType,
        data: originalBuffer.toString("base64"),
      },
    };

    let lastError: any = null;

    if (targetLanguage === 'ku') {
      // Two-pass strategy when silence was trimmed:
      //   Pass 1 (transcript): use trimmed audio — saves API cost, no silence to transcribe.
      //   Pass 2 (timestamps): use ORIGINAL audio — Gemini timestamps must match the file
      //     the browser plays; trimmed offsets don't map cleanly even with remapping.
      // When no trimming occurred both passes use the same audio part.
      const timestampAudioPart = speechSegments ? audioPartOriginal : audioPart;

      let words: TimedWord[] = [];
      let text = "";
      let usedModel = "";

      // Pass 1: transcript from trimmed audio (word-timestamp format for text extraction)
      for (const modelName of models) {
        try {
          const result = await ai.models.generateContent({
            model: modelName,
            config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
            contents: [{ parts: [audioPart, { text: promptText }] }],
          });
          const parsed = parseWordTimestampLines(result.text || "");
          if (looksLikeValidWordList(parsed, durationSeconds)) {
            text = wordsToText(parsed);
            usedModel = modelName;
            break;
          }
          console.warn(`[Transcribe] ${modelName} word-timestamp output didn't look valid, trying next model`);
        } catch (err: any) {
          const status = err?.status || err?.code;
          const msg = String(err?.message || "");
          const isRetryable = status === 429 || status === 503 || status === 500
            || msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("high demand") || msg.includes("quota");
          if (isRetryable) { lastError = err; continue; }
          throw err;
        }
      }

      // Pass 2: word timestamps from ORIGINAL (untrimmed) audio for accurate karaoke sync
      if (text && speechSegments) {
        try {
          const tsResult = await ai.models.generateContent({
            model: usedModel || models[0],
            config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
            contents: [{ parts: [timestampAudioPart, { text: promptText }] }],
          });
          const tsWords = parseWordTimestampLines(tsResult.text || "");
          const originalDuration = trimResult.durationSeconds + (speechSegments.reduce((s, seg) => s + (seg.origEnd - seg.origStart - (seg.trimmedEnd - seg.trimmedStart)), 0));
          if (looksLikeValidWordList(tsWords, originalDuration)) {
            words = tsWords;
          }
        } catch (e) {
          console.warn("[Transcribe] Timestamp re-run on original audio failed, skipping karaoke:", e);
        }
      } else if (text && !speechSegments) {
        // No trim — reuse parse from pass 1 directly
        for (const modelName of models) {
          try {
            const result = await ai.models.generateContent({
              model: modelName,
              config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
              contents: [{ parts: [audioPart, { text: promptText }] }],
            });
            const parsed = parseWordTimestampLines(result.text || "");
            if (looksLikeValidWordList(parsed, durationSeconds)) {
              words = parsed;
              break;
            }
          } catch { break; }
        }
      }

      // Fallback prose transcript if word-timestamp pass failed
      if (!text) {
        try {
          const result = await ai.models.generateContent({
            model: models[models.length - 1],
            config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
            contents: [{ parts: [audioPart, { text: kurdishProseFallbackPrompt }] }],
          });
          text = result.text || "";
        } catch (err) {
          throw friendlyQuotaError(lastError || err);
        }
      }

      let taggedText = await tagIslamicCitations(ai, text);

      if (wantsProUpgrade && usedModel && usedModel !== "gemini-2.5-pro" && /<quran |<hadith /.test(taggedText)) {
        try {
          const proResult = await ai.models.generateContent({
            model: "gemini-2.5-pro",
            config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
            contents: [{ parts: [audioPart, { text: promptText }] }],
          });
          const proWords = parseWordTimestampLines(proResult.text || "");
          if (looksLikeValidWordList(proWords, durationSeconds)) {
            text = wordsToText(proWords);
            taggedText = await tagIslamicCitations(ai, text);
          }
        } catch (e) {
          console.warn("[Transcribe] Pro re-run for Quran/Hadith failed, keeping original output:", e);
        }
      }

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Transfer-Encoding", "chunked");
      if (/<quran |<hadith /.test(taggedText)) {
        res.write(formatVerifyingSourcesMarker());
      }
      const annotated = await verifyAndAnnotate(taggedText, ai);
      if (words.length > 0) {
        res.write(formatWordsMarker(words));
      }
      res.end(annotated);
      return;
    }

    for (const modelName of models) {
      try {
        const responseStream = await ai.models.generateContentStream({
          model: modelName,
          config: { temperature: 0 },
          contents: [{ parts: [audioPart, { text: promptText }] }],
        });

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        for await (const chunk of responseStream) {
          if (chunk.text) res.write(chunk.text);
        }
        res.end();
        return;
      } catch (err: any) {
        const status = err?.status || err?.code;
        const msg = String(err?.message || '');
        const isRetryable = status === 429 || status === 503 || status === 500
          || msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand') || msg.includes('quota');
        if (isRetryable) {
          console.log(`[Gemini] ${modelName} failed (${status}), trying next model...`);
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw friendlyQuotaError(lastError);
  } catch (error: any) {
    console.error("Transcription error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || "Failed to process audio" });
    } else {
      res.end();
    }
  }
});

// API route for word-level timestamps (karaoke highlight view / subtitle export).
// Only called on demand by the client now, not on every transcription.
app.post("/api/transcribe-timed", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file provided" });

    const targetLanguage = ALLOWED_LANGUAGES.has(req.body.language) ? req.body.language : 'ku';
    const selectedModel = ALLOWED_MODELS.has(req.body.model) ? req.body.model : 'gemini';

    let mimeType = req.file.mimetype.split(';')[0];
    if (!ALLOWED_MIMES.has(mimeType)) return res.status(400).json({ error: "جۆری فایلەکە پشتگیری نەکراوە." });
    if (mimeType === 'application/ogg') mimeType = 'audio/ogg';
    if (mimeType === 'video/webm') mimeType = 'audio/webm';
    if (mimeType === 'video/mp4') mimeType = 'audio/mp4';

    // ── SCRIBE PATH (when ElevenLabs key is available) ──────────────────────
    if (process.env.ELEVENLABS_API_KEY) {
      const scribeForm = new FormData();
      const blob = new Blob([req.file.buffer], { type: mimeType });
      scribeForm.append("file", blob, req.file.originalname || "audio.mp3");
      scribeForm.append("model_id", "scribe_v1");
      scribeForm.append("language_code", targetLanguage === "ar" ? "ara" : "ckb");
      scribeForm.append("tag_audio_events", "false");
      scribeForm.append("word_timestamps", "true");

      const elRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
        body: scribeForm,
      });

      if (elRes.ok) {
        const elData = await elRes.json();
        const raw: { text: string; start: number; end: number; type: string }[] = elData.words || [];
        const words = raw
          .filter(w => w.type === "word")
          .map(w => ({ word: w.text, start: w.start, end: w.end }));

        if (words.length > 0) {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          return res.json(words);
        }
      }
      // fall through to Gemini if Scribe fails or returns empty
    }

    // ── GEMINI PATH (fallback, or when no Scribe key) ───────────────────────
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "نە GEMINI_API_KEY و نە ELEVENLABS_API_KEY داخل نەکراوە." });
    }

    const audioPart = {
      inlineData: { mimeType, data: req.file.buffer.toString("base64") },
    };

    const promptText = targetLanguage === "ar"
      ? `You are a master Arabic linguist. Listen to the Kurdish (Sorani) audio and produce a fully-vowelled Modern Standard Arabic (الفصحى) translation with word-level timestamps.

Return ONLY a valid JSON array. Each element:
- "word": the Arabic word with full diacritics/tashkeel (مُشَكَّل)
- "start": start time in seconds (number, 2 decimal places)
- "end": end time in seconds (number, 2 decimal places)

Linguistic rules for the Arabic words:
- Full iʿrāb case endings (إعراب): ضمة رفع، فتحة نصب، كسرة جر
- Tanwīn on indefinite words: ـً ـٍ ـٌ
- Full short vowels (حركات) and shadda (شدَّة) on every word
- Correct morphological patterns and broken plurals
- Natural, flowing Modern Standard Arabic

Example: [{"word":"مَرْحَباً","start":0.00,"end":0.45},{"word":"كَيْفَ","start":0.50,"end":0.80}]

Return ONLY the JSON array — no markdown, no explanation.`
      : `You are an expert Kurdish (Sorani) speech transcriber. Listen to the audio and produce a word-by-word timestamped transcription.

Return ONLY a valid JSON array. Each element:
- "word": the Kurdish Sorani word (string)
- "start": start time in seconds (number, 2 decimal places)
- "end": end time in seconds (number, 2 decimal places)

Rules:
- Standard Central Kurdish (Sorani) Arabic-based script
- Correct Sorani spelling (ڕ vs ر, ڵ vs ل, ئ vs ع, etc.)
- Every spoken word with accurate timestamps

Example: [{"word":"سڵاو","start":0.00,"end":0.45},{"word":"چۆنی","start":0.50,"end":0.80}]

Return ONLY the JSON array — no markdown, no explanation.`;

    const models = selectedModel === "gemini-pro"
      ? ["gemini-2.5-flash", "gemini-2.5-pro"]
      : ["gemini-2.5-flash", "gemini-2.5-pro"];

    let lastError: any = null;

    for (const modelName of models) {
      try {
        const result = await ai.models.generateContent({
          model: modelName,
          config: { temperature: 0 },
          contents: [{ parts: [audioPart, { text: promptText }] }],
        });

        let raw = (result.text || "").trim();
        raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

        let words: { word: string; start: number; end: number }[];
        try {
          words = JSON.parse(raw);
        } catch {
          const match = raw.match(/\[[\s\S]*\]/);
          if (!match) throw new Error("JSON نەدۆزرایەوە لە وەڵامی Gemini.");
          words = JSON.parse(match[0]);
        }

        if (!Array.isArray(words) || words.length === 0) throw new Error("ئەنجامی timestamps بەتاڵە.");

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.json(words);
      } catch (err: any) {
        const status = err?.status || err?.code;
        const msg = String(err?.message || "");
        const isRetryable = status === 429 || status === 503 || status === 500
          || msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("quota");
        if (isRetryable) { lastError = err; continue; }
        throw err;
      }
    }

    throw lastError || new Error("هەموو مۆدێلەکان شکستیان هێنا.");
  } catch (error: any) {
    console.error("Timed transcription error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || "Failed to process audio" });
    }
  }
});

// API route for subtitle generation (SRT / VTT)
app.post("/api/subtitles", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file provided" });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "Gemini API key not configured" });

    const targetLanguage = ALLOWED_LANGUAGES.has(req.body.language) ? req.body.language : 'ku';
    const format: 'srt' | 'vtt' = ALLOWED_FORMATS.has(req.body.format) ? req.body.format : 'srt';

    let mimeType = req.file.mimetype.split(';')[0];
    if (!ALLOWED_MIMES.has(mimeType)) return res.status(400).json({ error: "جۆری فایلەکە پشتگیری نەکراوە." });
    if (mimeType === 'application/ogg') mimeType = 'audio/ogg';
    if (mimeType === 'video/webm') mimeType = 'audio/webm';
    if (mimeType === 'video/mp4') mimeType = 'audio/mp4';

    let finalBuffer = req.file.buffer;
    let finalMimeType = mimeType;

    const shouldCompress = req.body.compress === "true" || req.file.buffer.length / 1024 / 1024 > 20;
    if (shouldCompress) {
      const tempIn = path.join(os.tmpdir(), crypto.randomBytes(16).toString("hex") + ".tmp");
      const tempOut = path.join(os.tmpdir(), crypto.randomBytes(16).toString("hex") + ".mp3");
      fs.writeFileSync(tempIn, req.file.buffer);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(tempIn).audioFrequency(16000).audioChannels(1).audioBitrate('32k').toFormat('mp3')
          .on('end', () => resolve()).on('error', reject).save(tempOut);
      });
      finalBuffer = fs.readFileSync(tempOut);
      finalMimeType = "audio/mpeg";
      try { fs.unlinkSync(tempIn); fs.unlinkSync(tempOut); } catch {}
    }

    const langLabel = targetLanguage === 'ar' ? 'Arabic' : 'Kurdish (Sorani)';
    const srtExample = `1\n00:00:00,000 --> 00:00:03,500\nFirst subtitle line here\n\n2\n00:00:03,500 --> 00:00:07,200\nSecond subtitle line here`;
    const vttExample = `WEBVTT\n\n00:00:00.000 --> 00:00:03.500\nFirst subtitle line here\n\n00:00:03.500 --> 00:00:07.200\nSecond subtitle line here`;

    const prompt = format === 'srt'
      ? `You are a professional subtitle editor. Listen to this ${langLabel} audio carefully and produce a complete, accurate SRT subtitle file.\n\nRules:\n- Use REAL timestamps from the audio — listen carefully to when each phrase starts and ends\n- Each subtitle block: max 2 lines, max 42 characters per line\n- Natural break points at sentence/clause boundaries\n- Output ONLY the raw SRT content, nothing else — no markdown, no explanation\n\nSRT format example:\n${srtExample}`
      : `You are a professional subtitle editor. Listen to this ${langLabel} audio carefully and produce a complete, accurate WebVTT subtitle file.\n\nRules:\n- Use REAL timestamps from the audio — listen carefully to when each phrase starts and ends\n- Each subtitle block: max 2 lines, max 42 characters per line\n- Natural break points at sentence/clause boundaries\n- Output ONLY the raw VTT content starting with WEBVTT, nothing else — no markdown, no explanation\n\nVTT format example:\n${vttExample}`;

    const audioPart = { inlineData: { mimeType: finalMimeType, data: finalBuffer.toString("base64") } };

    const result = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      config: { temperature: 0 },
      contents: [{ parts: [audioPart, { text: prompt }] }],
    });

    let output = (result.text || "").replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();

    // Ensure VTT starts with WEBVTT header
    if (format === 'vtt' && !output.startsWith('WEBVTT')) {
      output = 'WEBVTT\n\n' + output;
    }

    res.setHeader("Content-Type", `text/plain; charset=utf-8`);
    res.send(output);
  } catch (error: any) {
    console.error("Subtitles error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message || "Failed to generate subtitles" });
  }
});

// API route for text summarization
app.post("/api/summarize", async (req, res) => {
  try {
    const { text, language } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "تێکستێک نەناردراوە." });
    if (typeof text !== 'string' || text.length > 50000) return res.status(400).json({ error: "تێکستەکە زۆر درێژە." });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY نەخوێندراوەتەوە — تکایە لە Vercel Dashboard زیادی بکە." });

    const isKurdish = language === 'ku';
    const prompt = isKurdish
      ? `تۆ پسپۆڕی کوردی کلاسیکی و ئەدەبی کوردییت. تێکستی خوارەوەی کە لە دەنگەوە گۆڕدراوە بخوێنەرەوە و:\n1. پوختەیەکی کورت (٣-٥ ڕستە) بنووسە کە گرنگترین خاڵەکانی ئەو قسانە لەخۆ بگرێت\n2. خاڵە گرنگەکانی وەک لیستێک دەربهێنە\n\nتێکست:\n${text}\n\nبە ئەم شێوەیە وەڵامبدەرەوە:\n**پوختە:**\n[پوختەکە ئێرە]\n\n**خاڵە گرنگەکان:**\n• [خاڵی یەکەم]\n• [خاڵی دووەم]\n• ...`
      : `أنت خبير لغوي عربي. اقرأ النص التالي المستخرج من تسجيل صوتي وقم بـ:\n1. كتابة ملخص موجز (3-5 جمل) يغطي أهم النقاط\n2. استخراج النقاط الرئيسية كقائمة\n\nالنص:\n${text}\n\nأجب بهذا الشكل:\n**الملخص:**\n[الملخص هنا]\n\n**النقاط الرئيسية:**\n• [النقطة الأولى]\n• [النقطة الثانية]\n• ...`;

    const responseStream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      config: { temperature: 0.3 },
      contents: [{ parts: [{ text: prompt }] }],
    });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    for await (const chunk of responseStream) {
      if (chunk.text) res.write(chunk.text);
    }
    res.end();
  } catch (error: any) {
    console.error("Summarize error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message || "Failed to summarize" });
    else res.end();
  }
});

// Rough signal that a translation was truncated or summarized rather than fully
// translated: Arabic is typically similar in length to (often a bit shorter than)
// Sorani for the same content, so a result much shorter than the source is
// suspicious. Not exact, but catches the common failure mode cheaply.
function looksTruncated(source: string, translated: string): boolean {
  if (!translated.trim()) return true;
  return translated.length < source.length * 0.45;
}

// API route for translating already-transcribed Kurdish text to Arabic — text-only,
// so it costs far less than re-uploading and re-transcribing the source audio.
app.post("/api/translate", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "هیچ دەقێک نەنێردراوە." });
    if (typeof text !== 'string' || text.length > 50000) return res.status(400).json({ error: "دەقەکە زۆر درێژە." });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY نەخوێندراوەتەوە." });

    const prompt = `You are a professional Arabic translator with deep expertise in Kurdish (Sorani) to Arabic translation.
Translate the following Kurdish Sorani text into flawless Modern Standard Arabic (Fusha/MSA).

CRITICAL — completeness: translate the ENTIRE text from its first word to its very last word. Never summarize, shorten, condense, or silently drop any sentence, clause, or paragraph — even if the text is long or repetitive. The translation's length and number of sentences/paragraphs must track the source one-to-one.

Rules:
- Preserve the original meaning, tone, and nuance precisely — do not add or omit anything.
- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب).
- Choose the most contextually appropriate Arabic word for each Kurdish term.
- Transliterate proper nouns correctly.
- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML.

Kurdish text:
${text}`;

    // Flash first (cheap) — if its output looks truncated/summarized relative to the
    // source, re-run once with Pro, which is more reliable on long/complex text. Both
    // calls are text-only, so even the Pro retry costs a fraction of an audio call.
    let translated = "";
    try {
      const flashResult = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        config: { temperature: 0 },
        contents: prompt,
      });
      translated = (flashResult.text || "").trim();
    } catch (e) {
      console.warn("[Translate] Flash pass failed, falling back to Pro:", e);
    }

    if (looksTruncated(text, translated)) {
      try {
        const proResult = await ai.models.generateContent({
          model: "gemini-2.5-pro",
          config: { temperature: 0 },
          contents: prompt,
        });
        const proText = (proResult.text || "").trim();
        if (proText) translated = proText;
      } catch (e) {
        console.warn("[Translate] Pro retry failed, keeping Flash output:", e);
      }
    }

    if (!translated) {
      return res.status(500).json({ error: "وەرگێڕانەکە سەرکەوتوو نەبوو." });
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(translated);
  } catch (error: any) {
    console.error("Translate error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message || "Failed to translate" });
    else res.end();
  }
});

// API route for semantic Hadith search: user describes a Hadith in Kurdish, Gemini
// identifies it, and the result is verified against hadithapi.com before being returned.
app.post("/api/hadith-search", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: "هیچ دەقێک نەنێردراوە." });
    if (typeof query !== 'string' || query.length > 1000) return res.status(400).json({ error: "دەقەکە زۆر درێژە." });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY نەخوێندراوەتەوە." });

    if (!process.env.HADITH_API_KEY) {
      console.warn("[hadith-search] HADITH_API_KEY not set — results will be unverified.");
    }

    const results = await searchHadithByMeaning(ai, query, process.env.HADITH_API_KEY);
    res.status(200).json({ results });
  } catch (error: any) {
    console.error("Hadith search error:", error);
    res.status(500).json({ error: error.message || "گەڕانەکە سەرکەوتوو نەبوو." });
  }
});

// API route for Arabic grammar/syntax/spelling correction with a detailed error report.
app.post("/api/grammar-check", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "هیچ دەقێک نەنێردراوە." });
    if (typeof text !== 'string' || text.length > 10000) return res.status(400).json({ error: "دەقەکە زۆر درێژە." });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY نەخوێندراوەتەوە." });

    const result = await correctArabicGrammar(ai, text);
    res.status(200).json(result);
  } catch (error: any) {
    console.error("Arabic grammar correction error:", error);
    res.status(500).json({ error: error.message || "پشکنینەکە سەرکەوتوو نەبوو." });
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
    server.setTimeout(600000);
  }
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;
