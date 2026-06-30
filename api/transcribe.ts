import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";
import formidable from "formidable";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { CHUNK_THRESHOLD_SECONDS, formatChunkProgressMarker, probeDurationSeconds } from "../lib/audioChunker";
import { transcribeLongAudio } from "../lib/chunkedTranscription";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const config = {
  api: {
    bodyParser: false,
    maxDuration: 300,
  },
};

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

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

    const fileBuffer = fs.readFileSync(audioFile.filepath);
    let mimeType = audioFile.mimetype || "audio/mpeg";
    if (mimeType === "application/ogg") mimeType = "audio/ogg";
    if (mimeType === "video/webm") mimeType = "audio/webm";
    if (mimeType === "video/mp4") mimeType = "audio/mp4";

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
        const arBaseRules = `You are a master Arabic linguist and translator specialising in Kurdish (Sorani) to Arabic.
Produce a fully-vowelled (مُشَكَّل), grammatically impeccable Modern Standard Arabic (الفصحى) translation.

Strict linguistic rules:

GRAMMAR & SYNTAX (نحو):
- Apply full iʿrāb (إعراب): ضمة رفع، فتحة نصب، كسرة جر، سكون جزم
- Mark tanwīn on indefinite words: ـً ـٍ ـٌ
- Use correct definite article (ال) with sun-letter assimilation
- Subject–verb agreement in gender and number (مفرد/مثنى/جمع)
- Correct verb conjugations: tense, voice (معلوم/مجهول), mood

MORPHOLOGY (صرف):
- Derive words from correct Arabic roots (جذر ثلاثي/رباعي)
- Use correct morphological patterns (أوزان صرفية)
- Correct broken plurals: فُعُول، أَفْعَال، فِعَال، فُعَلَاء
- Proper hamza (همزة وصل vs همزة قطع)

DIACRITICS (تشكيل):
- Full short vowels on every word: فَتْحَة، كَسْرَة، ضَمَّة، سُكُون
- Shadda (شدَّة) on all geminate consonants
- Tanwīn on all indefinite nouns and adjectives

Return ONLY the final fully-vowelled Arabic text — no explanations, no markdown, no HTML.`;

        const arPrompt = finalOutput.trim()
          ? `You are a professional Arabic translator with deep expertise in Kurdish (Sorani) to Arabic translation.\nTranslate the following Kurdish Sorani text into flawless Modern Standard Arabic (Fusha/MSA).\nRules:\n- Preserve the original meaning, tone, and nuance precisely — do not add or omit anything.\n- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب).\n- Choose the most contextually appropriate Arabic word for each Kurdish term.\n- Transliterate proper nouns correctly.\n- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML.\n\nKurdish text:\n${finalOutput}`
          : `You are a professional Arabic translator. Listen to the Kurdish (Sorani) audio and translate it directly into flawless Modern Standard Arabic (Fusha/MSA).\nRules:\n- Preserve the original meaning, tone, and nuance precisely — do not add or omit anything.\n- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب).\n- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML.`;

        const chatRes = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: arPrompt,
        });
        finalOutput = (chatRes.text || finalOutput)
          .replace(/```[a-z]*\n?/g, "")
          .replace(/```/g, "")
          .replace(/<[^>]*>?/gm, "")
          .trim();
      }

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.send(finalOutput);
    }

    // GEMINI PATH (default)
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY داخل نەکراوە. تکایە لە Vercel Dashboard → Settings → Environment Variables کلیلەکە زیاد بکە." });
    }

    const promptText =
      targetLanguage === "ar"
        ? `You are a professional Arabic translator and linguist with deep expertise in Kurdish (Sorani) to Arabic translation. Listen to the Kurdish (Sorani) audio carefully and produce a flawless, publication-quality Arabic translation.

Rules:
- Translate into Modern Standard Arabic (Fusha/MSA) with rich, natural vocabulary.
- Preserve the original meaning, tone, and nuance precisely — do not add or omit any content.
- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب).
- Choose the most contextually appropriate Arabic word for each Kurdish term.
- Maintain the flow and rhythm of the original speech — do not make it sound robotic.
- Transliterate proper nouns and names correctly into Arabic script.
- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML.`
        : `You are an expert Kurdish (Sorani) speech transcriber. Your task is to produce a perfectly faithful transcription of the spoken audio in Kurdish Sorani script.

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
6. Return ONLY the plain transcribed text — no markdown, no HTML, no labels, no explanations.`;


    const models = selectedModel === 'gemini-pro'
      ? ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"]
      : selectedModel === 'gemini-flash2'
        ? ["gemini-2.0-flash"]
        : ["gemini-2.5-flash", "gemini-2.0-flash"];

    // Long files get split into overlapping 5-minute chunks so each Gemini
    // request stays fast and reliable; short files keep single-shot streaming.
    let durationSeconds = 0;
    try {
      durationSeconds = await probeDurationSeconds(audioFile.filepath);
    } catch (e) {
      console.warn("[Chunking] Duration probe failed, falling back to single-shot transcription:", e);
    }

    if (durationSeconds > CHUNK_THRESHOLD_SECONDS) {
      try {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Transfer-Encoding", "chunked");
        await transcribeLongAudio({
          ai,
          inputPath: audioFile.filepath,
          mimeType,
          models,
          promptText,
          onChunkStart: (index, total) => {
            console.log(`[Chunking] transcribing chunk ${index + 1}/${total}`);
            res.write(formatChunkProgressMarker(index, total));
          },
          onChunkText: (text) => res.write(text),
        });
        return res.end();
      } finally {
        try { fs.unlinkSync(audioFile.filepath); } catch {}
      }
    }

    const audioPart = {
      inlineData: {
        mimeType,
        data: fileBuffer.toString("base64"),
      },
    };

    let lastError: any = null;

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

    const lastMsg = String(lastError?.message || '');
    if (lastMsg.includes('quota') || lastMsg.includes('RESOURCE_EXHAUSTED') || lastMsg.includes('429')) {
      const nowUTC = new Date();
      const resetUTC = new Date(nowUTC);
      resetUTC.setUTCHours(24, 0, 0, 0);
      const diffMs = resetUTC.getTime() - nowUTC.getTime();
      const diffH = Math.floor(diffMs / 3600000);
      const diffM = Math.floor((diffMs % 3600000) / 60000);
      const resetKurdish = new Date(resetUTC.getTime() + 3 * 3600000);
      const kh = resetKurdish.getUTCHours().toString().padStart(2, '0');
      const km = resetKurdish.getUTCMinutes().toString().padStart(2, '0');
      throw new Error(`کۆتای داواکاری ڕۆژانەی Gemini تەواو بووە. دووبارە دەستپێ دەکاتەوە لە ساعەت ${kh}:${km} بەیانی کوردستان (${diffH} کاتژمێر و ${diffM} خولەک دیکە). تکایە مۆدێلی ElevenLabs Scribe بەکاربهێنە یان چاوەڕوانبە.`);
    }
    throw lastError;
  } catch (error: any) {
    console.error("Transcription error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || "Failed to process audio" });
    } else {
      res.end();
    }
  }
}
