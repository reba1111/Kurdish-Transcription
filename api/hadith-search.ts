import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";
import { searchHadithByMeaning } from "../lib/hadithSearch";

export const config = {
  api: {
    maxDuration: 30,
  },
};

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY داخل نەکراوە. تکایە لە Vercel Dashboard زیادی بکە." });
    }

    const { query } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: "هیچ دەقێک نەنێردراوە." });
    if (typeof query !== "string" || query.length > 1000) return res.status(400).json({ error: "دەقەکە زۆر درێژە." });

    if (!process.env.HADITH_API_KEY) {
      console.warn("[hadith-search] HADITH_API_KEY not set — results will be unverified.");
    }

    const results = await searchHadithByMeaning(ai, query, process.env.HADITH_API_KEY);
    res.status(200).json({ results });
  } catch (error: any) {
    console.error("Hadith search error:", error);
    res.status(500).json({ error: error.message || "گەڕانەکە سەرکەوتوو نەبوو." });
  }
}
