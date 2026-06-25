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
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY داخل نەکراوە. تکایە لە Vercel Dashboard زیادی بکە." });
    }

    const form = formidable({ maxFileSize: 100 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);

    const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;
    if (!audioFile) return res.status(400).json({ error: "No audio file provided" });

    const targetLanguage = (Array.isArray(fields.language) ? fields.language[0] : fields.language) || "ku";
    const format: 'srt' | 'vtt' = (Array.isArray(fields.format) ? fields.format[0] : fields.format) === 'vtt' ? 'vtt' : 'srt';

    const fileBuffer = fs.readFileSync(audioFile.filepath);
    let mimeType = audioFile.mimetype || "audio/mpeg";
    if (mimeType === "application/ogg") mimeType = "audio/ogg";
    if (mimeType === "video/webm") mimeType = "audio/webm";
    if (mimeType === "video/mp4") mimeType = "audio/mp4";

    const langLabel = targetLanguage === 'ar' ? 'Arabic' : 'Kurdish (Sorani)';
    const srtExample = `1\n00:00:00,000 --> 00:00:03,500\nFirst subtitle line\n\n2\n00:00:03,500 --> 00:00:07,200\nSecond subtitle line`;
    const vttExample = `WEBVTT\n\n00:00:00.000 --> 00:00:03.500\nFirst subtitle line\n\n00:00:03.500 --> 00:00:07.200\nSecond subtitle line`;

    const prompt = format === 'srt'
      ? `You are a professional subtitle editor. Listen to this ${langLabel} audio carefully and produce a complete, accurate SRT subtitle file.\n\nRules:\n- Use REAL timestamps from the audio\n- Each subtitle block: max 2 lines, max 42 characters per line\n- Natural break points at sentence/clause boundaries\n- Output ONLY the raw SRT content, nothing else\n\nFormat:\n${srtExample}`
      : `You are a professional subtitle editor. Listen to this ${langLabel} audio carefully and produce a complete, accurate WebVTT subtitle file.\n\nRules:\n- Use REAL timestamps from the audio\n- Each subtitle block: max 2 lines, max 42 characters per line\n- Natural break points at sentence/clause boundaries\n- Output ONLY the raw VTT content starting with WEBVTT, nothing else\n\nFormat:\n${vttExample}`;

    const audioPart = { inlineData: { mimeType, data: fileBuffer.toString("base64") } };

    const result = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      config: { temperature: 0 },
      contents: [{ parts: [audioPart, { text: prompt }] }],
    });

    let output = (result.text || "").replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
    if (format === 'vtt' && !output.startsWith('WEBVTT')) output = 'WEBVTT\n\n' + output;

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(output);
  } catch (error: any) {
    console.error("Subtitles error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message || "Failed to generate subtitles" });
  }
}
