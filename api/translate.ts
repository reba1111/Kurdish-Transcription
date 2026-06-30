import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GoogleGenAI } from "@google/genai";

export const config = {
  api: {
    maxDuration: 60,
  },
};

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const TRANSLATE_PROMPT = (text: string) => `You are a professional Arabic translator with deep expertise in Kurdish (Sorani) to Arabic translation.
Translate the following Kurdish Sorani text into flawless Modern Standard Arabic (Fusha/MSA).

CRITICAL — completeness: translate the ENTIRE text from its first word to its very last word. Never summarize, shorten, condense, or silently drop any sentence, clause, or paragraph — even if the text is long or repetitive. The translation's length and number of sentences/paragraphs must track the source one-to-one.

Rules:
- Preserve the original meaning, tone, and nuance precisely — do not add or omit anything.
- Use proper Arabic grammar, correct verb conjugations, and accurate case endings (إعراب).
- Choose the most contextually appropriate Arabic word for each Kurdish term.
- Transliterate proper nouns correctly.
- Return ONLY the final Arabic translation — no explanations, no markdown, no HTML.

Kurdish text:
${text}`;

/** Rough signal that a translation was truncated or summarized rather than fully
 * translated: Arabic is typically similar in length to (often a bit shorter than)
 * Sorani for the same content, so a result much shorter than the source is
 * suspicious. Not exact, but catches the common failure mode cheaply. */
function looksTruncated(source: string, translated: string): boolean {
  if (!translated.trim()) return true;
  return translated.length < source.length * 0.45;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY داخل نەکراوە. تکایە لە Vercel Dashboard → Settings → Environment Variables کلیلەکە زیاد بکە." });
    }

    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "No text provided" });

    const prompt = TRANSLATE_PROMPT(text);

    // Flash first (cheap) — if its output looks truncated/summarized relative to the
    // source, re-run once with Pro, which is more reliable on long/complex text.
    // Both calls are text-only, so even the Pro retry costs a fraction of a single
    // audio-based call.
    let translated = "";
    try {
      const flashResult = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        config: { temperature: 0 },
        contents: prompt,
      });
      translated = (flashResult.text || "").trim();
    } catch (e) {
      console.warn("[Translate] Flash pass failed, falling back to Pro:", e);
    }

    if (looksTruncated(text, translated)) {
      try {
        const proResult = await ai.models.generateContent({
          model: "gemini-2.5-pro",
          config: { temperature: 0 },
          contents: prompt,
        });
        const proText = (proResult.text || "").trim();
        if (proText) translated = proText;
      } catch (e) {
        console.warn("[Translate] Pro retry failed, keeping Flash output:", e);
      }
    }

    if (!translated) {
      return res.status(500).json({ error: "وەرگێڕانەکە سەرکەوتوو نەبوو." });
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(translated);
  } catch (error: any) {
    console.error("Translate error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message || "Failed to translate" });
    else res.end();
  }
}
