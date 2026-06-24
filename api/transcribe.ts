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
        return res.status(500).json({ error: "ELEVENLABS_API_KEY is not configured" });
      }

      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: mimeType });
      formData.append("file", blob, audioFile.originalFilename || "audio.mp3");
      formData.append("model_id", "scribe_v1");

      const elRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
        body: formData,
      });
      const elData = await elRes.json();

      if (!elRes.ok) throw new Error(elData.detail?.message || "ElevenLabs transcription failed");

      let finalOutput = elData.text;

      if (targetLanguage === "ar") {
        const chatRes = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents:
            "You are an expert translator. Translate the following Kurdish text directly into highly accurate, fluent, and natural standard Arabic (Fusha). Return ONLY the pure raw Arabic text. DO NOT use Markdown formatting. DO NOT wrap the output in any HTML tags. DO NOT provide explanations.\n\nText: " +
            finalOutput,
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
      return res.status(500).json({ error: "GEMINI_API_KEY is not configured" });
    }

    const audioPart = {
      inlineData: {
        mimeType,
        data: fileBuffer.toString("base64"),
      },
    };

    const promptText =
      targetLanguage === "ar"
        ? "You are an expert translator. Translate the spoken Kurdish audio directly into highly accurate, fluent, and natural standard Arabic (Fusha). Ensure the Arabic grammar is perfect. Return ONLY the pure raw Arabic text. DO NOT use Markdown formatting. DO NOT wrap the output in any HTML tags."
        : "You are an expert transcriber. Transcribe the spoken Kurdish audio highly accurately using Kurdish script. Ensure correct spelling and grammar. Return ONLY the pure transcribed text, without markdown or html tags.";

    const responseStream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [{ parts: [audioPart, { text: promptText }] }],
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
}
