import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";
import { correctArabicGrammar } from "../lib/arabicGrammarCorrector";

export const config = {
  api: {
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

    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "هیچ دەقێک نەنێردراوە." });
    if (typeof text !== "string" || text.length > 10000) return res.status(400).json({ error: "دەقەکە زۆر درێژە." });

    const result = await correctArabicGrammar(ai, text);
    res.status(200).json(result);
  } catch (error: any) {
    console.error("Grammar check error:", error);
    res.status(500).json({ error: error.message || "پشکنینەکە سەرکەوتوو نەبوو." });
  }
}
