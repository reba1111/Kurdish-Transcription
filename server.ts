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
    const selectedModel = req.body.model || 'gemini'; // 'gemini', 'groq', 'scribe'
    
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

    // 1. GROQ PATH
    if (selectedModel === 'groq' || selectedModel === 'groq-turbo') {
      if (!process.env.GROQ_API_KEY) {
         return res.status(500).json({ error: "GROQ_API_KEY is not configured" });
      }
      
      const formData = new FormData();
      const blob = new Blob([finalBuffer], { type: finalMimeType });
      formData.append("file", blob, finalFileName);
      
      const whisperModel = selectedModel === 'groq-turbo' ? "whisper-large-v3-turbo" : "whisper-large-v3";
      formData.append("model", whisperModel);
      // Kurdish is not supported by Whisper — let it auto-detect

      const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
        body: formData
      });
      const groqData = await groqRes.json();

      if (!groqRes.ok) throw new Error(groqData.error?.message || "Groq transcription failed");

      const rawTranscript = groqData.text;

      // Whisper often outputs Arabic or wrong script for Kurdish audio.
      // Use Llama to fix/translate based on desired output language.
      const systemPrompt = targetLanguage === 'ar'
        ? "You are an expert translator. The following text was auto-transcribed from audio and may contain Kurdish written in Arabic script, or already be in Arabic. Translate or convert it into highly accurate, fluent, natural standard Arabic (Fusha). Return ONLY the pure raw Arabic text. No markdown, no HTML, no explanations."
        : "You are an expert Kurdish language specialist. The following text was auto-transcribed from Kurdish audio by a speech recognition model that does not support Kurdish, so it may have errors, wrong words, or be written in Arabic instead of Kurdish. Correct it into proper Kurdish (Sorani, Arabic script). Fix spelling, grammar, and any mis-transcribed words. Return ONLY the corrected Kurdish text. No markdown, no HTML, no explanations.";

      const chatRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama3-70b-8192",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: rawTranscript }
          ]
        })
      });
      const chatData = await chatRes.json();

      let finalOutput = rawTranscript;
      if (chatRes.ok && chatData.choices && chatData.choices.length > 0) {
        finalOutput = chatData.choices[0].message.content.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').replace(/<[^>]*>?/gm, '').trim();
      }
      
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(finalOutput);
      return;
    }

    // 2. SCRIBE (ELEVENLABS) PATH
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
        // Use Gemini for translation if Scribe was used
        const chatRes = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: "You are an expert translator. Translate the following Kurdish text directly into highly accurate, fluent, and natural standard Arabic (Fusha). Return ONLY the pure raw Arabic text. DO NOT use Markdown formatting. DO NOT wrap the output in any HTML tags. DO NOT provide explanations.\n\nText: " + finalOutput
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

    let modelName = "gemini-2.5-flash";
    let promptText = "You are an expert transcriber. Transcribe the spoken Kurdish audio highly accurately using Kurdish script. Ensure correct spelling and grammar. Return ONLY the pure transcribed text, without markdown or html tags.";
    
    if (targetLanguage === 'ar') {
      promptText = "You are an expert translator. Translate the spoken Kurdish audio directly into highly accurate, fluent, and natural standard Arabic (Fusha). Ensure the Arabic grammar is perfect. Return ONLY the pure raw Arabic text. DO NOT use Markdown formatting. DO NOT wrap the output in any HTML tags.";
    }

    const responseStream = await ai.models.generateContentStream({
      model: modelName,
      contents: [
        {
          parts: [
            audioPart,
            { text: promptText }
          ]
        }
      ],
    });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    for await (const chunk of responseStream) {
      if (chunk.text) {
        res.write(chunk.text);
      }
    }
    res.end();
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
