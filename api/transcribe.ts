import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";
import formidable from "formidable";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { CHUNK_THRESHOLD_SECONDS, formatChunkProgressMarker, formatVerifyingSourcesMarker, formatWordsMarker, trimSilence } from "../lib/audioChunker";
import { transcribeLongAudio } from "../lib/chunkedTranscription";
import { ISLAMIC_TEXT_DETECTION_RULE, ISLAMIC_TEXT_SYSTEM_INSTRUCTION, tagIslamicCitations, verifyAndAnnotate } from "../lib/islamicTextVerifier";
import { looksLikeValidWordList, parseWordTimestampJSON, parseWordTimestampLines, remapWordsToOriginalTime, WORD_TIMESTAMP_PROMPT, WORD_TIMESTAMP_PROMPT_JSON, WORD_TIMESTAMP_SCHEMA, wordsToText, type TimedWord } from "../lib/wordTimestamps";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const config = {
  api: {
    bodyParser: false,
    maxDuration: 300,
  },
};

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const form = formidable({ maxFileSize: 100 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);

    const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;
    if (!audioFile) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const targetLanguage = (Array.isArray(fields.language) ? fields.language[0] : fields.language) || "ku";
    const selectedModel = (Array.isArray(fields.model) ? fields.model[0] : fields.model) || "gemini";

    let mimeType = audioFile.mimetype || "audio/mpeg";
    if (mimeType === "application/ogg") mimeType = "audio/ogg";
    if (mimeType === "video/webm") mimeType = "audio/webm";
    if (mimeType === "video/mp4") mimeType = "audio/mp4";

    // Both Gemini and ElevenLabs bill audio by duration, so long dead-air stretches
    // (common in lectures/meetings) cost real money for nothing. Cut them out before
    // any model sees the file — every downstream path uses this effective file/buffer/
    // mimeType instead of the raw upload. trimSilence fails open (returns the original
    // file untouched) on any detection/encode error.
    // Keep the original buffer before trimming so word-timestamp calls can use
    // the untrimmed audio — Gemini timestamps must match what the browser plays.
    const originalBuffer = fs.readFileSync(audioFile.filepath);
    const originalMimeType = mimeType;

    const trimResult = await trimSilence(audioFile.filepath);
    const effectiveFilePath = trimResult.filePath;
    const speechSegments = trimResult.segments;
    const fileBuffer = fs.readFileSync(effectiveFilePath);
    if (speechSegments) mimeType = "audio/mpeg"; // trimSilence always re-encodes to mp3

    try {
    // SCRIBE PATH
    if (selectedModel === "scribe") {
      if (!process.env.ELEVENLABS_API_KEY) {
        return res.status(500).json({ error: "ELEVENLABS_API_KEY داخل نەکراوە. تکایە لە Vercel Dashboard → Settings → Environment Variables کلیلەکە زیاد بکە." });
      }

      const scribeForm = new FormData();
      const blob = new Blob([fileBuffer], { type: mimeType });
      scribeForm.append("file", blob, audioFile.originalFilename || "audio.mp3");
      scribeForm.append("model_id", "scribe_v1");
      scribeForm.append("language_code", "ckb"); // Central Kurdish (Sorani) — force language
      scribeForm.append("tag_audio_events", "false");

      const elRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
        body: scribeForm,
      });
      const elData = await elRes.json();

      if (!elRes.ok) throw new Error(elData.detail?.message || "ElevenLabs transcription failed");

      let finalOutput = elData.text || "";

      // Detect if Scribe mis-detected language (output should be Arabic-script for Kurdish Sorani)
      const arabicScriptRatio = (finalOutput.match(/[؀-ۿ]/g) || []).length / Math.max(finalOutput.replace(/\s/g, "").length, 1);
      if (arabicScriptRatio < 0.3 && finalOutput.trim().length > 0) {
        finalOutput = ""; // discard mis-detected output
      }

      if (targetLanguage === "ar") {
        const arPrompt = finalOutput.trim()
          ? `You are a professional Arabic translator with deep expertise in Kurdish (Sorani) to Arabic translation.\nTranslate the following Kurdish Sorani text into flawless Modern Standard Arabic (Fusha/MSA).\nRules:\n- Preserve the original meaning, tone, and nuance precisely — do not add or omit anything.\n- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب).\n- Choose the most contextually appropriate Arabic word for each Kurdish term.\n- Transliterate proper nouns correctly.\n- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML.\n\nKurdish text:\n${finalOutput}`
          : `You are a professional Arabic translator. Listen to the Kurdish (Sorani) audio and translate it directly into flawless Modern Standard Arabic (Fusha/MSA).\nRules:\n- Preserve the original meaning, tone, and nuance precisely — do not add or omit anything.\n- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب).\n- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML.`;

        const chatRes = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          config: { temperature: 0 },
          contents: arPrompt,
        });
        finalOutput = (chatRes.text || finalOutput)
          .replace(/```[a-z]*\n?/g, "")
          .replace(/```/g, "")
          .replace(/<[^>]*>?/gm, "")
          .trim();
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
      return res.send(finalOutput);
    }

    // GEMINI PATH (default)
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY داخل نەکراوە. تکایە لە Vercel Dashboard → Settings → Environment Variables کلیلەکە زیاد بکە." });
    }

    const arabicPromptText = `You are a professional Arabic translator and linguist with deep expertise in Kurdish (Sorani) to Arabic translation. Listen to the Kurdish (Sorani) audio carefully and produce a flawless, publication-quality Arabic translation.

Rules:
- Translate into Modern Standard Arabic (Fusha/MSA) with rich, natural vocabulary.
- Preserve the original meaning, tone, and nuance precisely — do not add or omit any content.
- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب).
- Choose the most contextually appropriate Arabic word for each Kurdish term.
- Maintain the flow and rhythm of the original speech — do not make it sound robotic.
- Transliterate proper nouns and names correctly into Arabic script.
- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML.`;

    // Last-resort fallback when every model's word-timestamp attempt (WORD_TIMESTAMP_PROMPT,
    // used below) produces unusable output — guarantees a working transcript even when
    // word-timestamps can't be recovered for this particular request.
    const kurdishProseFallbackPrompt = `You are an expert Kurdish (Sorani) speech transcriber. Your task is to produce a perfectly faithful transcription of the spoken audio in Kurdish Sorani script.

Strict rules — follow every one without exception:
1. Transcribe EXACTLY what is spoken — do not add, remove, or change any word.
2. Use the standard Central Kurdish (Sorani) Arabic-based script (e.g. ئ، ا، ب، پ، ت، ج، چ، ح، خ، د، ر، ڕ، ز، ژ، س، ش، ع، غ، ف، ڤ، ق، ک، گ، ل، ڵ، م، ن، وو، و، ه، ھ، ی، ێ، ئ، ە).
3. Spell every word correctly according to standard Sorani orthography — pay close attention to:
   - The difference between ئ and ع
   - Long vowels (وو، ێ، ای) vs. short vowels (ە، ی، و)
   - ڕ (rolled R) vs. ر (regular R)
   - ڵ (lateral L) vs. ل (regular L)
   - ڤ vs. ف and ق vs. ک where needed
4. Preserve natural sentence boundaries and punctuation (. ، ؟ !)
5. Do NOT translate, summarize, or paraphrase — only transcribe.
6. Return ONLY the plain transcribed text — no markdown, no HTML, no labels, no explanations.${ISLAMIC_TEXT_DETECTION_RULE}`;

    // Kept as a generic name for the chunked path below, which still branches on language.
    const promptText = targetLanguage === "ar" ? arabicPromptText : WORD_TIMESTAMP_PROMPT;


    // "gemini-pro" no longer calls Pro directly — Pro costs ~6-7x Flash per minute of
    // audio. Instead we transcribe with Flash first and only re-run the (much cheaper)
    // Flash output through Pro when it actually contains a Quran/Hadith citation, since
    // Pro is meaningfully more reliable at diacritizing/citing recited religious text.
    // Plain speech, which is the vast majority of usage, never touches Pro at all.
    const wantsProUpgrade = selectedModel === 'gemini-pro';
    const models = selectedModel === 'gemini-flash2'
      ? ["gemini-2.5-flash"]
      : ["gemini-2.5-flash"];

    // Long files get split into overlapping 5-minute chunks so each Gemini
    // request stays fast and reliable; short files keep single-shot streaming.
    // Duration already came from trimSilence's own probe — no need to re-probe here.
    const durationSeconds = trimResult.durationSeconds;

    if (durationSeconds > CHUNK_THRESHOLD_SECONDS) {
      try {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        await transcribeLongAudio({
          ai,
          inputPath: effectiveFilePath,
          mimeType,
          models,
          promptText,
          useIslamicSystemPrompt: targetLanguage === "ku",
          wantsProUpgrade,
          useWordTimestamps: targetLanguage === "ku",
          proseFallbackPromptText: targetLanguage === "ku" ? kurdishProseFallbackPrompt : undefined,
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
        return res.end();
      } finally {
        try { fs.unlinkSync(audioFile.filepath); } catch {}
      }
    }

    // Transcript audio: trimmed (silence removed) to save API cost.
    const audioPart = {
      inlineData: { mimeType, data: fileBuffer.toString("base64") },
    };
    // Timestamp audio: always the original untrimmed file so Gemini's reported
    // offsets match what the browser is actually playing back.
    const audioPartOriginal = {
      inlineData: { mimeType: originalMimeType, data: originalBuffer.toString("base64") },
    };

    let lastError: any = null;

    if (targetLanguage === "ku") {
      let words: TimedWord[] = [];
      let text = "";
      let usedModel = "";

      // Pass 1 — transcript from trimmed audio (cheaper, no silence to process)
      for (const modelName of models) {
        try {
          const result = await ai.models.generateContent({
            model: modelName,
            config: {
              temperature: 0.1,
              systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION,
              responseSchema: WORD_TIMESTAMP_SCHEMA,
              responseMimeType: "application/json",
            },
            contents: [{ parts: [audioPart, { text: WORD_TIMESTAMP_PROMPT_JSON }] }],
          });
          const parsed = parseWordTimestampJSON(result.text || "");
          if (looksLikeValidWordList(parsed, durationSeconds)) {
            text = wordsToText(parsed);
            usedModel = modelName;
            break;
          }
          console.warn(`[Transcribe] ${modelName} JSON schema output invalid, retrying with line format`);
          const lineResult = await ai.models.generateContent({
            model: modelName,
            config: { temperature: 0, systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION },
            contents: [{ parts: [audioPart, { text: promptText }] }],
          });
          const lineParsed = parseWordTimestampLines(lineResult.text || "");
          if (looksLikeValidWordList(lineParsed, durationSeconds)) {
            text = wordsToText(lineParsed);
            usedModel = modelName;
            break;
          }
          console.warn(`[Transcribe] ${modelName} line-format output also invalid, trying next model`);
        } catch (err: any) {
          const status = err?.status || err?.code;
          const msg = String(err?.message || "");
          const isRetryable = status === 429 || status === 503 || status === 500
            || msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("high demand") || msg.includes("quota");
          if (isRetryable) { lastError = err; continue; }
          throw err;
        }
      }

      // Pass 2 — word timestamps from ORIGINAL (untrimmed) audio for accurate karaoke sync.
      // When no trimming occurred reuse the same audio part (no extra API call).
      if (text) {
        const tsAudioPart = speechSegments ? audioPartOriginal : audioPart;
        const tsDuration = speechSegments
          ? trimResult.durationSeconds + speechSegments.reduce((s, seg) => s + (seg.origEnd - seg.origStart - (seg.trimmedEnd - seg.trimmedStart)), 0)
          : durationSeconds;
        try {
          const tsResult = await ai.models.generateContent({
            model: usedModel || models[0],
            config: {
              temperature: 0.1,
              systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION,
              responseSchema: WORD_TIMESTAMP_SCHEMA,
              responseMimeType: "application/json",
            },
            contents: [{ parts: [tsAudioPart, { text: WORD_TIMESTAMP_PROMPT_JSON }] }],
          });
          const tsWords = parseWordTimestampJSON(tsResult.text || "");
          if (looksLikeValidWordList(tsWords, tsDuration)) words = tsWords;
        } catch (e) {
          console.warn("[Transcribe] Timestamp pass on original audio failed, skipping karaoke:", e);
        }
      }

      // Fallback prose if both word-timestamp passes failed
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
            config: {
              temperature: 0.1,
              systemInstruction: ISLAMIC_TEXT_SYSTEM_INSTRUCTION,
              responseSchema: WORD_TIMESTAMP_SCHEMA,
              responseMimeType: "application/json",
            },
            contents: [{ parts: [audioPart, { text: WORD_TIMESTAMP_PROMPT_JSON }] }],
          });
          const proWords = parseWordTimestampJSON(proResult.text || "");
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
      res.write(annotated);
      res.end();
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
    } finally {
      if (speechSegments) { try { fs.unlinkSync(effectiveFilePath); } catch {} }
    }
  } catch (error: any) {
    console.error("Transcription error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || "Failed to process audio" });
    } else {
      res.end();
    }
  }
}
