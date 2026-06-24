import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

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

    // 1. GROQ PATH
    if (selectedModel === 'groq' || selectedModel === 'groq-turbo') {
      if (!process.env.GROQ_API_KEY) {
         return res.status(500).json({ error: "GROQ_API_KEY is not configured" });
      }
      
      const formData = new FormData();
      const blob = new Blob([req.file.buffer], { type: mimeType });
      formData.append("file", blob, req.file.originalname || "audio.ogg");
      
      const whisperModel = selectedModel === 'groq-turbo' ? "whisper-large-v3-turbo" : "whisper-large-v3";
      formData.append("model", whisperModel);
      // formData.append("language", "ku");
      
      const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
        body: formData
      });
      const groqData = await groqRes.json();
      
      if (!groqRes.ok) throw new Error(groqData.error?.message || "Groq transcription failed");
      
      let finalOutput = groqData.text;
      
      // If Arabic is requested, translate the Kurdish text to Arabic using Groq Llama 3
      if (targetLanguage === 'ar') {
        const chatRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "llama3-70b-8192",
            messages: [
              { role: "system", content: "You are an expert translator. Translate the following Kurdish text directly into highly accurate, fluent, and natural standard Arabic (Fusha). Return ONLY the pure raw Arabic text. DO NOT use Markdown formatting. DO NOT wrap the output in any HTML tags. DO NOT provide explanations." },
              { role: "user", content: finalOutput }
            ]
          })
        });
        const chatData = await chatRes.json();
        if (chatRes.ok && chatData.choices && chatData.choices.length > 0) {
          finalOutput = chatData.choices[0].message.content.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').replace(/<[^>]*>?/gm, '').trim();
        }
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
      const blob = new Blob([req.file.buffer], { type: mimeType });
      formData.append("file", blob, req.file.originalname || "audio.ogg");
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
        mimeType: mimeType,
        data: req.file.buffer.toString("base64"),
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

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  server.setTimeout(600000);
}

startServer();
