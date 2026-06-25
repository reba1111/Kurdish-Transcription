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

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(path.dirname(process.argv[1] || ''), '.env') });

const app = express();
const PORT = 3000;

// Setup Multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Initialize Gemini
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

app.use(express.json());

// API route for audio transcription
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const targetLanguage = req.body.language || 'ku';
    const selectedModel = req.body.model || 'gemini'; // 'gemini' | 'gemini-flash2' | 'scribe'
    
    let mimeType = req.file.mimetype.split(';')[0];
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
          contents: arPrompt
        });
        finalOutput = (chatRes.text || finalOutput).replace(/```[a-z]*\n?/g, '').replace(/```/g, '').replace(/<[^>]*>?/gm, '').trim();
      }
      
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(finalOutput);
      return;
    }

    // 3. DEFAULT GEMINI PATH
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Gemini API key is not configured" });
    }

    const audioPart = {
      inlineData: {
        mimeType: finalMimeType,
        data: finalBuffer.toString("base64"),
      },
    };

    const promptText = targetLanguage === 'ar'
      ? `You are a professional Arabic translator and linguist with deep expertise in Kurdish (Sorani) to Arabic translation. Listen to the Kurdish audio carefully and produce a flawless, publication-quality Arabic translation.

Rules:
- Translate into Modern Standard Arabic (Fusha/MSA) with rich, natural vocabulary
- Preserve the original meaning, tone, and nuance precisely
- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب)
- Choose the most contextually appropriate Arabic word for each Kurdish term
- Maintain the flow and rhythm of the original speech — do not make it sound robotic
- If a proper noun or name appears, transliterate it correctly into Arabic
- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML`
      : "You are an expert transcriber. Transcribe the spoken Kurdish audio highly accurately using Kurdish script. Ensure correct spelling and grammar. Return ONLY the pure transcribed text, without markdown or html tags.";

    const models = selectedModel === 'gemini-pro'
      ? ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"]
      : selectedModel === 'gemini-flash2'
        ? ["gemini-2.0-flash"]
        : ["gemini-2.5-flash", "gemini-2.0-flash"];
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
      throw new Error("کۆتای داواکاری ڕۆژانەی Gemini تەواو بووە. تکایە سبەی دووبارە هەوڵ بدەرەوە، یان لە AI Studio billing چالاک بکە، یان مۆدێلی ElevenLabs Scribe بەکاربهێنە.");
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
});

// API route for subtitle generation (SRT / VTT)
app.post("/api/subtitles", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file provided" });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "Gemini API key not configured" });

    const targetLanguage = req.body.language || 'ku';
    const format: 'srt' | 'vtt' = req.body.format === 'vtt' ? 'vtt' : 'srt';

    let mimeType = req.file.mimetype.split(';')[0];
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
    if (!text?.trim()) return res.status(400).json({ error: "No text provided" });
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
