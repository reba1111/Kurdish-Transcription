import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";

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

    const { text, language } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "No text provided" });

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
}
