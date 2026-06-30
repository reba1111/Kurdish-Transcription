import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
    maxDuration: 60,
  },
};

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const form = formidable({ maxFileSize: 100 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);

    const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;
    if (!audioFile) return res.status(400).json({ error: "No audio file provided" });

    const targetLanguage = (Array.isArray(fields.language) ? fields.language[0] : fields.language) || "ku";
    const selectedModel = (Array.isArray(fields.model) ? fields.model[0] : fields.model) || "gemini";

    const fileBuffer = fs.readFileSync(audioFile.filepath);
    let mimeType = audioFile.mimetype || "audio/mpeg";
    if (mimeType === "application/ogg") mimeType = "audio/ogg";
    if (mimeType === "video/webm") mimeType = "audio/webm";
    if (mimeType === "video/mp4") mimeType = "audio/mp4";

    // ── SCRIBE PATH (when ElevenLabs key is available) ──────────────────────
    if (process.env.ELEVENLABS_API_KEY) {
      const scribeForm = new FormData();
      const blob = new Blob([fileBuffer], { type: mimeType });
      scribeForm.append("file", blob, audioFile.originalFilename || "audio.mp3");
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
      inlineData: { mimeType, data: fileBuffer.toString("base64") },
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
      ? ["gemini-2.5-pro", "gemini-2.5-flash"]
      : selectedModel === "gemini-flash2"
        ? ["gemini-2.0-flash"]
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
}
