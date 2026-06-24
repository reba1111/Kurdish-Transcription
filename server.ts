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

dotenv.config();

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
    const selectedModel = req.body.model || 'gemini';
    
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
      
      const formData = new FormData();
      const blob = new Blob([finalBuffer], { type: finalMimeType });
      formData.append("file", blob, finalFileName);
      formData.append("model_id", "scribe_v1"); // their current model
      
      const elRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
        body: formData
      });
      const elData = await elRes.json();
      
      if (!elRes.ok) throw new Error(elData.detail?.message || "ElevenLabs transcription failed");
      
      let finalOutput = elData.text;
      
      if (targetLanguage === 'ar') {
        const chatRes = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: `You are a professional Arabic translator and linguist with deep expertise in Kurdish (Sorani) to Arabic translation. Your task is to produce a flawless, publication-quality Arabic translation.

Rules:
- Translate into Modern Standard Arabic (Fusha/MSA) with rich, natural vocabulary
- Preserve the original meaning, tone, and nuance precisely
- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب)
- Choose the most contextually appropriate Arabic word for each Kurdish term
- Maintain the flow and rhythm of the original speech — do not make it sound robotic
- If a proper noun or name appears, transliterate it correctly into Arabic
- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML

Kurdish text to translate:
${finalOutput}`
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

    const models = ["gemini-2.5-flash"];
    let lastError: any = null;

    for (const modelName of models) {
      try {
        const responseStream = await ai.models.generateContentStream({
          model: modelName,
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
        if (status === 429 || status === 503 || status === 500) {
          console.log(`[Gemini] ${modelName} failed (${status}), trying next model...`);
          lastError = err;
          continue;
        }
        throw err;
      }
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
