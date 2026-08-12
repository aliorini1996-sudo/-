/**
 * التأهيل الذكي عبر **ملي (Miali Ai)** — وكيلنا المنشور على Render.
 * يقيّم كل عميل 1..10 مقابل وصف العميل المثالي الذي كتبه صاحب الحساب.
 *
 * كُتب هذا الملفّ بعد مراجعة عدائية كشفت أربعة عيوب في النسخة الأولى، وكلّها
 * مُعالَجة هنا صراحةً:
 *  1) الربط بالفهرس الموضعي: إن أسقط النموذج عنصراً انزلقت الدرجات على عملاء
 *     خاطئين **نهائياً** (لأن score≠null يُخرجهم من إعادة التأهيل). الحل:
 *     مفتاح ثابت لكل عنصر يُعاد ويُطابق، وأي مفتاح مجهول يُهمَل.
 *  2) سقف توكن ثابت (1500) يبتر JSON لدفعة كبيرة فتضيع **بصمت**. الحل: سقف
 *     محسوب من حجم الدفعة + تبليغ صريح عن الناقص.
 *  3) درجة مفقودة/غير رقمية كانت تصير 1 (وسمٌ دائم لعميل لم يُقيَّم). الحل:
 *     نتخطّاه بلا درجة ليُعاد تأهيله لاحقاً.
 *  4) استخراج JSON بregex جشع يسقط عند أي قوس في النثر. الحل: مسح متوازن.
 */

const MIALI_URL_DEFAULT = 'https://ads-skills-agent.onrender.com';

export interface QualifyItem {
  key: string; // مفتاح ثابت قصير يُعيده النموذج (نستخدم مقطعاً من معرّف العميل)
  name: string;
  category?: string | null;
  city?: string | null;
  country?: string | null;
  website?: string | null;
}

export interface QualifyResult {
  score: number;
  note: string;
}

export function mialiUrl(): string {
  return (process.env.MIALI_AGENT_URL || MIALI_URL_DEFAULT).replace(/\/+$/, '');
}

/** ملي وكيل عامّ فلا يحتاج مفتاحاً؛ المفتاح المشترك يتجاوز حدّ المعدّل فقط. */
export function qualifyReady(): boolean {
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * استخراج أوّل مصفوفة JSON صالحة من نصّ قد يحوي نثراً أو أسوار كود.
 * المسح متوازن (يحترم السلاسل والهروب) بدل regex جشع من أوّل `[` لآخر `]`.
 */
function extractJsonArray(raw: string): unknown[] | null {
  let text = String(raw || '').trim();
  // انزع أسوار الكود إن وُجدت
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // المحاولة الأسهل: النصّ كلّه مصفوفة
  try {
    const direct = JSON.parse(text);
    if (Array.isArray(direct)) return direct;
  } catch { /* نكمل للمسح */ }

  for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (Array.isArray(parsed)) return parsed;
          } catch { /* جرّب القوس التالي */ }
          break;
        }
      }
    }
  }
  return null;
}

function buildPrompt(targetDesc: string, items: QualifyItem[]): { system: string; user: string } {
  const payload = items.map((it) => ({
    k: it.key,
    name: it.name,
    type: it.category || '',
    city: it.city || '',
    country: it.country || '',
  }));
  // موجّه مشدَّد: الدرجة يجب أن **تُفرّق** فعلاً. الإصدار السابق كان يمنح 8
  // للجميع بما فيهم متاجر التجزئة، فتفقد الدرجة قيمتها كأداة فرز.
  const system =
    'أنت خبير تأهيل عملاء B2B. سأعطيك وصف العميل المثالي وقائمة شركات، لكل شركة مفتاح "k". ' +
    'قيّم كل شركة من 1 إلى 10 بحسب مطابقتها للوصف، **واستخدم المدى كلّه ولا تمنح الجميع نفس الدرجة**: ' +
    '9-10 مطابقة مؤكّدة · 6-8 مرجّحة · 3-5 غير واضحة أو نشاط مجاور · 1-2 غير مطابقة. ' +
    'إن كان الوصف يطلب شركات جملة/توزيع فمتاجر التجزئة والبقالات والتموينات والمطاعم درجتها 1-3. ' +
    'الملاحظة **بالعربية** و**٦ كلمات كحدّ أقصى** تشرح سبب الدرجة. ' +
    'أعد JSON فقط: مصفوفة {"k":"<نفس المفتاح>","score":<1-10>,"note":"<بالعربية>"} ' +
    'لكل شركة بلا استثناء وبلا أي نصّ خارج المصفوفة.';
  const user = `وصف العميل المثالي:\n${targetDesc}\n\nالشركات:\n${JSON.stringify(payload)}`;
  return { system, user };
}

/** سقف التوكن محسوب من حجم الدفعة (الوكيل يقصّه إلى 4000 على أي حال). */
function tokensFor(n: number): number {
  return Math.min(4000, 250 + n * 90);
}

async function callMiali(system: string, user: string, maxTokens: number): Promise<string> {
  const key = (process.env.MIALI_AGENT_KEY || '').trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['X-Agent-Key'] = key; // الأنظمة الموثوقة تتجاوز حدّ المعدّل

  const body = JSON.stringify({ prompt: user, system, max_tokens: maxTokens, temperature: 0.3 });
  // الوكيل يرفض ما يتجاوز 64KB — نحرسها من جهتنا فلا نضيّع محاولات على 413
  if (Buffer.byteLength(body, 'utf8') > 60_000) {
    throw new Error('حمولة التأهيل كبيرة — قلّل حجم الدفعة أو اختصر الوصف');
  }

  // الوكيل على خطة Render المجانية ينام؛ الاستيقاظ قد يستغرق ~30-60ث،
  // والتباعد المتدرّج يغطّي ذلك ويغطّي حدّ المعدّل (60ث) حين لا يوجد مفتاح.
  const backoff = [15_000, 30_000, 60_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const r = await fetch(`${mialiUrl()}/generate`, {
        method: 'POST', headers, body, signal: ctrl.signal,
      });
      if (r.ok) {
        const data = (await r.json()) as { text?: string };
        if (typeof data.text === 'string') return data.text;
        throw new Error('ردّ ملي بلا حقل text');
      }
      // 4xx دائم (عدا 429) — لا فائدة من الإعادة
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        throw new Error(`ملي رفض الطلب (HTTP ${r.status})`);
      }
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
      if (e instanceof Error && e.message.startsWith('ملي رفض')) throw e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await sleep(backoff[attempt]);
  }
  throw new Error(`ملي غير متاح: ${lastErr instanceof Error ? lastErr.message : 'سبب غير معروف'}`);
}

export interface QualifyBatchOutcome {
  scores: Map<string, QualifyResult>;
  /** عدد العناصر التي لم يُعِد لها النموذج درجة صالحة (تبقى بلا درجة). */
  missing: number;
}

/**
 * يقيّم دفعة ويعيد خريطة **بمفتاح العنصر** لا بموضعه.
 * يرمي عند تعذّر الاتصال بملي (يلتقطه المستدعي ويوقف مرحلة التأهيل وحدها).
 */
export async function qualifyBatch(
  targetDesc: string,
  items: QualifyItem[],
): Promise<QualifyBatchOutcome> {
  if (!items.length) return { scores: new Map(), missing: 0 };

  const { system, user } = buildPrompt(targetDesc, items);
  const text = await callMiali(system, user, tokensFor(items.length));

  const arr = extractJsonArray(text);
  const scores = new Map<string, QualifyResult>();
  const valid = new Set(items.map((i) => i.key));

  for (const row of arr || []) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const k = String(rec.k ?? '');
    if (!valid.has(k) || scores.has(k)) continue; // مفتاح مجهول أو مكرّر يُهمَل

    // درجة غير رقمية = النموذج لم يُقيّم؛ لا نخترع 1 ونسمه نهائياً
    const n = Number(rec.score);
    if (!Number.isFinite(n)) continue;

    scores.set(k, {
      score: Math.max(1, Math.min(10, Math.round(n))),
      note: String(rec.note ?? '').slice(0, 120),
    });
  }

  return { scores, missing: items.length - scores.size };
}
