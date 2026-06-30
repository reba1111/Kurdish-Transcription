// Arabic grammar & syntax corrector: takes user-written Arabic text and returns a
// fully corrected version (spelling/إملاء, syntax/نحو, morphology/صرف) plus a
// detailed, learnable report of each error and why it was fixed. The prompt is the
// only safeguard against the model silently rewriting, summarizing, or changing the
// meaning of the text — it's instructed repeatedly and explicitly not to.

import type { GoogleGenAI } from "@google/genai";

export interface GrammarError {
  original: string;
  corrected: string;
  type: 'إملائي' | 'نحوي' | 'صرفي' | string;
  explanation: string;
}

export interface GrammarCorrectionResult {
  correctedText: string;
  errors: GrammarError[];
}

const PROMPT_TEMPLATE = (text: string) => `أنت أستاذ متخصص في النحو والصرف والإملاء العربي. مهمتك مراجعة النص التالي وتصحيح أخطائه فقط.

قواعد صارمة يجب اتباعها دون أي استثناء:
1. لا تُضِف ولا تحذف ولا تُعِد صياغة أي كلمة أو جملة. غيّر فقط ما هو خطأ نحويًا أو إملائيًا أو صرفيًا.
2. لا تُغيّر المعنى أو الأسلوب أو ترتيب الجمل بأي شكل.
3. لا تحذف ولا تُغيّر أي فاصلة أو علامة ترقيم موجودة في النص الأصلي بحجة "تحسين الأسلوب" — وضع الفواصل ليس خطأ نحويًا أو إملائيًا أبدًا، حتى لو بدا غير معتاد لك. مثال: الجملة "أنا، في الحقيقة، لا أعرف، ماذا، أقول، الآن." يجب أن تبقى بكل فواصلها كما هي دون حذف أي واحدة منها — هذا اختيار أسلوبي للكاتب، وليس خطأ.
4. إذا كان النص مكتوبًا بلهجة عامية أو بأسلوب غير رسمي مقصود، لا تُحوّله إلى الفصحى (لا تستبدل صيغها أو أفعالها أو ضمائرها العامية بمرادفات فصيحة) — صحّح فقط الأخطاء الإملائية الحقيقية (كالهمزات) داخل نفس الكلمات العامية، واترك طابعها العامي كما هو.
5. إذا كان النص صحيحًا بالكامل (أو صحيحًا حسب طابعه العامي/الأسلوبي الأصلي)، أعد نفس النص دون أي تغيير وأرجع مصفوفة أخطاء فارغة.
6. لكل خطأ تصححه، سجّله في قائمة الأخطاء مع: الكلمة/الجملة الأصلية الخاطئة، النسخة المصححة، نوع الخطأ (إملائي، نحوي، أو صرفي)، وشرح موجز وواضح لسبب الخطأ. اكتب الشرح (explanation) باللغة الكردية (Sorani) حصراً، لأن المستخدم متعلم كردي يحتاج الشرح بلغته — لا تكتب الشرح بالعربية مهما كان.

النص المطلوب تصحيحه:
"""
${text}
"""

أرجع النتيجة بصيغة JSON فقط، دون أي markdown أو شرح إضافي خارج الـ JSON، بهذا الشكل بالضبط:
{
  "correctedText": "النص الكامل بعد التصحيح",
  "errors": [
    {
      "original": "الجزء الخاطئ من النص الأصلي",
      "corrected": "الجزء بعد التصحيح",
      "type": "إملائي",
      "explanation": "هۆکاری هەڵەکە و چۆنیەتی ڕاستکردنەوەی، بە کوردی"
    }
  ]
}`;

/**
 * Sends Arabic text to Gemini for grammar/syntax/spelling correction, returning the
 * corrected text plus a structured list of every change made and why. Throws on
 * malformed JSON or API failure — the caller is expected to surface that as an error
 * rather than silently showing nothing, since a wrong "no errors found" result would
 * be worse than a visible failure for this use case.
 */
export async function correctArabicGrammar(ai: GoogleGenAI, text: string): Promise<GrammarCorrectionResult> {
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    config: { temperature: 0 },
    contents: PROMPT_TEMPLATE(text),
  });

  const raw = (result.text || "").replace(/```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : raw);

  if (typeof parsed?.correctedText !== "string") {
    throw new Error("وەڵامی نادروستی Gemini — correctedText نەدۆزرایەوە.");
  }

  const errors: GrammarError[] = Array.isArray(parsed.errors)
    ? parsed.errors
        .filter((e: any) => e && typeof e.original === "string" && typeof e.corrected === "string")
        .map((e: any) => ({
          original: e.original,
          corrected: e.corrected,
          type: typeof e.type === "string" ? e.type : "نادیار",
          explanation: typeof e.explanation === "string" ? e.explanation : "",
        }))
    : [];

  return { correctedText: parsed.correctedText, errors };
}
