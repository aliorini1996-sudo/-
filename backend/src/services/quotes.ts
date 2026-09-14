/**
 * سجلّ عروض الأسعار الصادرة من الرابط الخاص `/q-fs7k2m` — منطقٌ خالص بلا قاعدة.
 *
 * كل عرضٍ يُحفَظ **لقطةً كاملة** لما طُبع في ملفّه (الباقة وحدّها وسعرها ساعة
 * الإصدار)، فيُعاد عرضه للمالك كما رآه العميل حتى لو تغيّرت الأسعار لاحقاً.
 *
 * الرابط **بلا دخول**، فلا يُؤتمَن المتصفّح على شيءٍ يُسجَّل غير هويّة العرض:
 * - الباقة واسمها وحدّها وسعرها **من كتالوج الخادم** بمعرّف الباقة وحده،
 *   والمبالغ مشتقّة منه، والصلاحية ثابتٌ في الخادم.
 * - الرقم المؤقّت (عرضٌ صدر بلا اتصال) يُقبَل **مقيَّداً بلحظة إصداره** ويُوسَم
 *   `offline` في السجلّ، فلا يُختار رقمٌ أو تاريخٌ على هوى المُرسِل دون أثر.
 */
import { z } from 'zod';

export const VAT_RATE = 0.15;
/** صلاحية العرض بالأيام — ثابتٌ في الخادم لا يُرسَل */
export const QUOTE_VALID_DAYS = 10;

/**
 * كتالوج الباقات — **يطابق حرفياً** `PACKAGES` في web-admin/src/quote/quoteDoc.tsx
 * (اختبار quotes.test.ts يقرأ الملفّين ويُفشل البناء عند أيّ افتراق).
 * الأسعار بالريال **شاملة الضريبة**: `total` شهريّ، و`yearly` سعر السنة المعتمد
 * (قرار المالك ١٤ سبتمبر ٢٠٢٦: السنويّ = عشرة أشهر، أي شهران مجاناً — لا ١٢ × الشهري).
 */
export const QUOTE_PACKAGES = {
  starter: { name: 'المبتدئة', total: 299, yearly: 2990, limit: 'حتى ٥ مناديب ومستخدم إداري واحد' },
  growth: { name: 'المتوسطة', total: 399, yearly: 3990, limit: 'حتى ١٠ مناديب ومستخدمَين إداريَّين' },
  pro: { name: 'الاحترافية', total: 599, yearly: 5990, limit: 'حتى ٢٠ مندوباً و٥ مستخدمين إداريين' },
} as const;
export type QuotePackageId = keyof typeof QUOTE_PACKAGES;

/** رقم العرض الموحّد: FS-QT-السنة-تسلسلٌ من أربع خانات فأكثر */
export function formatQuoteNo(seq: number, issuedAt: Date): string {
  return `FS-QT-${riyadhParts(issuedAt).y}-${String(seq).padStart(4, '0')}`;
}

/** رقمٌ مؤقّت يولّده الجوال حين يتعذّر التسجيل لحظة الإصدار — عشر خانات تميّزه عن التسلسل */
export const LOCAL_NO = /^FS-QT-\d{4}-\d{10}$/;

function riyadhParts(d: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === t)?.value ?? '00';
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour'), min: g('minute'), s: g('second') };
}

/** الرقم المؤقّت الذي **يجب** أن يطبعه الجوال للحظةٍ ما — نفس صيغة localQuoteNo في الواجهة */
export function localNoFor(d: Date): string {
  const p = riyadhParts(d);
  return `FS-QT-${p.y}-${p.m}${p.d}${p.h}${p.min}${p.s}`;
}

/**
 * الضريبة **تُستخرَج من السعر الشامل لا تُضاف إليه** — بالهللات الصحيحة كي لا ينحرف
 * الصافي + الضريبة عن الإجمالي. الإجمالي: سعر الشهر أو سعر السنة المعتمد كما هو.
 */
export function quoteFigures(totalHalalas: number) {
  const netHalalas = Math.round(totalHalalas / (1 + VAT_RATE));
  return { totalHalalas, netHalalas, vatHalalas: totalHalalas - netHalalas };
}

const oneLine = (max: number, msg: string) =>
  z.string().trim().max(max, msg).transform(s => s.replace(/\s+/g, ' '));

export const quoteInput = z.object({
  /** معرّفٌ يولّده الجوال لكل إصدار — يجعل إعادة الإرسال (مهلة، طابور، تبويبان) لا تكرّر العرض */
  clientRef: z.string().uuid('معرف العرض غير صالح'),
  company: oneLine(200, 'اسم المنشأة طويل').pipe(z.string().min(2, 'اسم المنشأة قصير')),
  unifiedNo: z.string().trim().regex(/^\d{5,20}$/, 'الرقم الموحد أرقام فقط من 5 إلى 20'),
  packageId: z.enum(Object.keys(QUOTE_PACKAGES) as [QuotePackageId, ...QuotePackageId[]], {
    errorMap: () => ({ message: 'الباقة غير معروفة' }),
  }),
  cycle: z.enum(['monthly', 'yearly'], { errorMap: () => ({ message: 'دورة السداد غير صالحة' }) }),
  presenter: oneLine(80, 'اسم مقدم العرض طويل').optional(),
  note: z.string().trim().max(500, 'النص الإضافي أطول من 500 حرف').optional(),
  /** للعروض المُصدَرة بلا تسجيل: الرقم المطبوع في ملفّها ولحظة إصدارها (يُتحقَّق من تطابقهما) */
  localNo: z.string().regex(LOCAL_NO).optional(),
  issuedAt: z.string().datetime().optional(),
  dryRun: z.boolean().optional(),
  // حقول لقطة الواجهة (اسم الباقة وسعرها وحدّها وصلاحيتها) تُحذف عند التحقّق — المرجع الكتالوج
});

export type QuoteInput = z.infer<typeof quoteInput>;

const DAY = 86_400_000;
/** أقصى عمرٍ لعرضٍ صدر بلا اتصال ويصل متأخّراً (جوالٌ لم يُفتح عليه الرابط أسابيع) */
export const OFFLINE_MAX_AGE_DAYS = 180;

/**
 * الرقم المؤقّت ولحظته **معاً أو لا شيء**: يُقبَلان فقط إن كان الرقم هو ما يطبعه
 * الجوال لتلك اللحظة بتوقيت الرياض، واللحظة ماضيةٌ (بسماحِ دقيقتين لانحراف ساعة
 * الجوال) وضمن ١٨٠ يوماً. وإلا يُهمَلان ويأخذ العرض تسلسل الخادم ولحظته.
 */
export function resolveOffline(localNo: string | undefined, claimedAt: string | undefined, now: Date):
  { quoteNo: string; issuedAt: Date } | null {
  if (!localNo || !claimedAt) return null;
  const t = new Date(claimedAt);
  const ms = t.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms > now.getTime() + 2 * 60_000 || ms < now.getTime() - OFFLINE_MAX_AGE_DAYS * DAY) return null;
  if (localNoFor(t) !== localNo) return null;
  return { quoteNo: localNo, issuedAt: ms > now.getTime() ? now : t };
}

/** بيانات الإنشاء من المدخلات المتحقَّق منها — الباقة والمبالغ والصلاحية من الخادم */
export function toQuoteRecord(input: QuoteInput, now: Date) {
  const pkg = QUOTE_PACKAGES[input.packageId];
  const monthlyHalalas = pkg.total * 100;
  const yearlyHalalas = pkg.yearly * 100;
  const offline = resolveOffline(input.localNo, input.issuedAt, now);
  return {
    clientRef: input.clientRef,
    quoteNo: offline?.quoteNo ?? null,
    offline: !!offline,
    company: input.company,
    unifiedNo: input.unifiedNo,
    packageId: input.packageId,
    packageName: pkg.name,
    packageLimit: pkg.limit,
    monthlyHalalas,
    yearlyHalalas,
    cycle: input.cycle,
    ...quoteFigures(input.cycle === 'yearly' ? yearlyHalalas : monthlyHalalas),
    presenter: input.presenter?.trim() || null,
    note: input.note?.trim() || null,
    validDays: QUOTE_VALID_DAYS,
    issuedAt: offline?.issuedAt ?? now,
  };
}

/** الرقم المعروض: المطبوع في ملفّ العرض إن وُلد بلا تسجيل، وإلا التسلسل */
export function displayNo(q: { seq: number; quoteNo: string | null; issuedAt: Date }): string {
  return q.quoteNo ?? formatQuoteNo(q.seq, q.issuedAt);
}
