// ============================================================================
// ZATCA المرحلة الثانية (Z5.7) — إخفاء رمز المشاركة عن سجلّ الطلبات.
// ----------------------------------------------------------------------------
// رابط المشتري يحمل الإذن كلّه في المسار: `/e/:token` (صفحة الواجهة) و`/api/public/einvoice/:token[/xml]`.
// وmorgan مركَّب قبل كلّ موجّه بصيغة `combined` في الإنتاج، وهي تطبع `:url` (أي `req.originalUrl`) و`:referrer`
// في كلّ سطر. فبلا هذا الوسيط تُكتب بصمة الرمز كاملةً في مجرى سجلّات الاستضافة مع كلّ فتحة صفحة وكلّ تنزيل:
//   • من يقرأ السجلّ جمهورٌ أوسع من الشركة صاحبة المستند، ويكفيه أن يعيد إرسال السطر ليأخذ الـXML الموقَّع
//     بأسماء المشتري وبنوده وأسعاره — بلا تخمينٍ يوقفه محدّد المعدّل ولا 404 موحّدة تضلّله.
//   • والرمز مشتقّ لا مخزَّن فلا تنقضي صلاحيته بذاتها: سطرٌ عمره أشهر يبقى صالحاً حتى يُبدَّل سرّ الخادم.
// والصفحة تُرسل مسارها في ترويسة `Referer` مع نداء الـAPI (نفس الأصل)، فالرمز يتسرّب مرّتين لا مرّة.
//
// العلاج: نقنّع مقطع الرمز في `originalUrl` وفي `Referer` **قبل التوجيه**، وmorgan يقرأ الاثنين عند انتهاء
// الردّ لا عند دخوله — فيطبع المقنَّع. وقبل التوجيه لا بعده عمداً: ردّ 429 من محدّد المعدّل، و404 من الموجّه،
// وصفحة الواجهة الساكنة (`/e/:token` تصلها من express.static) كلّها تُسجَّل ولا يمرّ أيٌّ منها بمعالج المسار.
//
// `req.url` لا يُمسّ — فالتوجيه و`req.params.token` يريان الرمز الحقيقي كما هو. `originalUrl` لا يقرؤه في
// هذا الخادم إلا morgan و`isLongLivedRequest` (مسار `/api/live/stream`، خارج ما نقنّعه).
//
// الكلفة على كلّ طلبٍ آخر: مقارنتا بدايةِ نصّ. بلا قاعدة بيانات ولا ساعة ولا تخصيص ذاكرة ما لم يُطابق المسار.
// ============================================================================

import { Request, Response, NextFunction } from 'express';

/** ما يحلّ محلّ الرمز في السطر المسجَّل — نصٌّ ثابت لا يُشتقّ من الرمز (لا بادئة ولا طول). */
export const TOKEN_MASK = '<token>';

/**
 * البادئتان اللتان يأتي بعدهما مقطعُ الرمز مباشرةً، ولا شيء غيرهما:
 *   • `/api/public/einvoice/` — موجّه routes/publicEinvoice.ts مركَّباً على `/api/public`.
 *   • `/e/` — صفحة الواجهة العامّة (`shareUrlOf` في compliance/zatca/publicView.ts).
 * التقنيع بالموضع لا بشكل الرمز: رمزٌ مشوّه أو مبتور يُقنَّع أيضاً — لا فائدة من تسجيله، وقد يكون صحيحاً
 * بحرفٍ واحد. واختبارٌ يثبّت البادئتين على مصدرهما كي لا تنزلق إحداهما عن الأخرى.
 */
const SHARE_PREFIXES: readonly string[] = Object.freeze(['/api/public/einvoice/', '/e/']);

/** أوّل فاصلٍ ينهي المقطع (`/` أو `?` أو `#`)، أو طول النصّ إن لم يوجد. */
function segmentEnd(rest: string): number {
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest.charCodeAt(i);
    if (c === 47 /* / */ || c === 63 /* ? */ || c === 35 /* # */) return i;
  }
  return rest.length;
}

/** المسار مُقنَّعاً، أو null إن لم يكن من مسارات المشاركة (فلا نخصّص ولا ننسخ شيئاً). */
function redactPath(path: string): string | null {
  for (const prefix of SHARE_PREFIXES) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const end = segmentEnd(rest);
    if (end === 0) return null; // `/e/` أو `/api/public/einvoice/` بلا رمز — لا شيء يُخفى
    if (rest.slice(0, end) === TOKEN_MASK) return null; // مُقنَّع سلفاً — العملية عديمة الأثر عند التكرار
    return prefix + TOKEN_MASK + rest.slice(end);
  }
  return null;
}

/**
 * الرابط مُقنَّعاً، أو null إن لم يتغيّر. يقبل المسار النسبيّ (`originalUrl`) والمطلق (`Referer`) معاً:
 * الأصل يُقتطع كما هو ويُعاد كما هو، والتقنيع يقع على المسار وحده.
 */
export function redactShareUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/.exec(raw);
  const origin = m ? m[0] : '';
  const path = raw.slice(origin.length);
  if (path.charCodeAt(0) !== 47 /* / */) return null;
  const red = redactPath(path);
  return red === null ? null : origin + red;
}

/** ترويسة واحدة أو عدّة نسخ منها — نقنّع كلّ نسخة ونُبقي الشكل كما جاء. */
function redactHeader(value: string | string[] | undefined): string | string[] | null {
  if (typeof value === 'string') return redactShareUrl(value);
  if (!Array.isArray(value)) return null;
  let hit = false;
  const out = value.map((v) => { const r = redactShareUrl(v); if (r !== null) hit = true; return r ?? v; });
  return hit ? out : null;
}

/**
 * الوسيط: يُركَّب في index.ts مباشرةً بعد morgan وقبل أيّ موجّه. لا يردّ ولا يمنع ولا يقرأ جسماً — يقنّع
 * حقلين اثنين إن طابقا، ويمرّر.
 */
export function redactShareTokensInLogs(req: Request, _res: Response, next: NextFunction): void {
  const holder = req as Request & { originalUrl?: string };
  const url = redactShareUrl(holder.originalUrl);
  if (url !== null) holder.originalUrl = url;

  const headers = req.headers as Record<string, string | string[] | undefined>;
  // morgan يقرأ `referer` ثمّ `referrer` — نقنّع الموجود منهما
  for (const name of ['referer', 'referrer']) {
    const red = redactHeader(headers[name]);
    if (red !== null) headers[name] = red;
  }

  next();
}

export default redactShareTokensInLogs;
