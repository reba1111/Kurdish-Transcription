// Kurdish (Sorani) spelling & typo corrector: takes user-uploaded Kurdish text and
// returns a fully corrected version plus a detailed report of each fixed word. The
// prompt is the only safeguard against the model silently rewriting, summarizing, or
// changing the meaning of the text — it's instructed repeatedly and explicitly not to
// add or remove words, only to fix ones that are genuinely misspelled/garbled.

import type { GoogleGenAI } from "@google/genai";

export interface WordError {
  original: string;
  corrected: string;
  explanation: string;
}

export interface TextCorrectionResult {
  correctedText: string;
  errors: WordError[];
}

const PROMPT_TEMPLATE = (text: string) => `تۆ یاریدەدەرێکی ڕاستکردنەوەی دەقی کوردی (سۆرانی) یت کە لە لێدوان و قسەکردن وەرگیراوە. ئەرکت پێداچوونەوەیە بە دەقی خوارەوە و تەنها ڕاستکردنەوەی ئەو وشانەیە کە پیتیان لێ پەڕیوە یان بەهۆی خێرا قسەکردنەوە کورت بوونەتەوە.

ڕێسا توندەکان کە دەبێت بەبێ هیچ لادانێک پەیڕەوی بکرێن:
1. هیچ وشەیەک زیاد مەکە و هیچ وشەیەک لامەبە. تەنها ئەو وشانە بگۆڕە کە بە ڕوونی پیتیان لێ پەڕیوە، تێکچوونی پیت تێدایە، یان بەهۆی خێرا قسەکردنەوە کورت بوونەتەوە (بۆ نموونە: "کا" یان "کان" لە شوێنی گونجاودا بکە بە "کە" یان "کاکە").
2. بە هیچ شێوەیەک شێوازی دەربڕین و قسەکردنەکە مەکە بە زمانی فەرمی. وشە و دەستەواژە زاراوەیی و لێدوانییەکان (وەک "ئەچێ"، "ئەڵێ"، "حاڵەکەم وایە"، "عەتیادیە") دەبێت وەک خۆیان بمێننەوە بەبێ گۆڕانکاری — تەنها هەڵەی ڕاستنووسی ڕاستەقینەی ناو هەمان وشەیە ڕاست بکەوە، لە کاتێکدا زاراوەیی و شێوازی قسەکردنەکەی وەک خۆی دەهێڵیتەوە.
3. مانا، ڕیزبەندی ڕستەکان، یان دەستەواژەکان مەگۆڕە بە هیچ شێوەیەک.
4. هیچ کۆما، خاڵ، یان نیشانەیەکی نووسینی تر لە دەقی سەرەتایی مەسڕەوە یان مەگۆڕە بە بیانووی "باشترکردنی شێواز" — دانانی کۆما هەرگیز هەڵەی ڕێنووسی نییە، تەنانەت ئەگەر بۆ تۆ نامۆ بێت.
5. ئەگەر دەقەکە بە تەواوی ڕاستە (یان ڕاستە بەگوێرەی شێوازی سەرەتایی خۆی)، هەمان دەق بەبێ هیچ گۆڕانکارییەک بگەڕێنەوە و لیستی هەڵەکان بەتاڵ بهێڵەوە.
6. بۆ هەر هەڵەیەک کە ڕاستی دەکەیتەوە، تۆماری بکە لە لیستی هەڵەکاندا لەگەڵ: وشەی هەڵەی سەرەتایی، وەشانی ڕاستکراوە، و ڕوونکردنەوەیەکی کورت و ڕوون بۆ هۆکاری هەڵەکە — بە زمانی کوردی (سۆرانی).

دەقی پێویست بە ڕاستکردنەوە:
"""
${text}
"""

ئەنجامەکە تەنها بە فۆرماتی JSON بگەڕێنەوە، بەبێ هیچ markdown یان ڕوونکردنەوەی زیادە لە دەرەوەی JSON، بەم شێوەیە بەدروستی:
{
  "correctedText": "دەقی تەواو دوای ڕاستکردنەوە",
  "errors": [
    {
      "original": "وشەی هەڵەی سەرەتایی",
      "corrected": "وشە دوای ڕاستکردنەوە",
      "explanation": "هۆکاری هەڵەکە و چۆنیەتی ڕاستکردنەوەی، بە کوردی"
    }
  ]
}`;

/** responseSchema enforcing the exact { correctedText, errors[] } shape — Gemini
 * cannot emit malformed JSON (unescaped quotes, truncated arrays) when this is set,
 * unlike free-form prompting where a long errors list previously broke mid-array. */
const RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    correctedText: { type: "string" as const },
    errors: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          original: { type: "string" as const },
          corrected: { type: "string" as const },
          explanation: { type: "string" as const },
        },
        required: ["original", "corrected", "explanation"],
      },
    },
  },
  required: ["correctedText", "errors"],
};

/**
 * Sends Kurdish text to Gemini for spelling/typo correction, returning the corrected
 * text plus a structured list of every word changed and why. Throws on malformed JSON
 * or API failure — the caller is expected to surface that as an error rather than
 * silently showing nothing.
 */
export async function correctKurdishText(ai: GoogleGenAI, text: string): Promise<TextCorrectionResult> {
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    config: { temperature: 0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
    contents: PROMPT_TEMPLATE(text),
  });

  const raw = (result.text || "").replace(/```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : raw);

  if (typeof parsed?.correctedText !== "string") {
    throw new Error("وەڵامی نادروستی Gemini — correctedText نەدۆزرایەوە.");
  }

  const errors: WordError[] = Array.isArray(parsed.errors)
    ? parsed.errors
        .filter((e: any) => e && typeof e.original === "string" && typeof e.corrected === "string")
        .map((e: any) => ({
          original: e.original,
          corrected: e.corrected,
          explanation: typeof e.explanation === "string" ? e.explanation : "",
        }))
    : [];

  return { correctedText: parsed.correctedText, errors };
}
