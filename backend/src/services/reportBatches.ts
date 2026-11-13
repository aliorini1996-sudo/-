/**
 * قراءة سجلّات الزيارات الخام كاملةً على دفعات — دقّة التقارير (طلب المالك ١٣ نوفمبر ٢٠٢٦، البند ٧).
 *
 * كانت تقارير الزيارات الأربعة (زيارات العملاء، أداء المناديب، ساعات العمل، التقييم بمعيار الزيارات) تسحب السجلّات بسقفٍ
 * صامت مختلف لكلٍّ منها (٥٬٠٠٠ / ٢٠٬٠٠٠ / ١٠٬٠٠٠ / ٥٠٬٠٠٠) وبترتيبٍ مختلف — والتصاعدي منها يُبقي **الأقدم** ويُسقط الأحدث —
 * ثم تعدّ الوقفات من الناقص وتعرضه كأنه كامل، فيختلف عدد المندوب نفسه بين تبويبين على الصفحة نفسها.
 *
 * فالقراءة الآن واحدة للأربعة: كل السجلّات في المدى، دفعاتٍ من ٥٬٠٠٠ بترتيبٍ ثابت بلا تعادل (createdAt ثم id، الأحدث أولاً)
 * وبمؤشّر «ما بعد آخر صفٍّ قُرئ» (keyset) لا بإزاحة — الإزاحة تُعيد مسح ما قبلها في كل دفعة وتتزحزح إن أُضيف سجلٌّ أثناء القراءة.
 * والسقف الوحيد حدُّ أمانٍ عالٍ (٢٠٠٬٠٠٠ سجلٍّ خام) لقاعدةٍ صغيرة: إن بُلغ بقي **الأحدث** وأُعلن `truncated` — لا قصّ صامت.
 *
 * createdAt بدقّة ملّي ثانية في القاعدة (timestamp(3)) فيعود إليها من JavaScript كما خرج، والمقارنة في المؤشّر مطابقةٌ تامّة.
 * صرفٌ بلا قاعدة: المسار يمرّر دالّة الدفعة (استعلامه هو بشرطه واختياره)، فيُختبر المنطق وحده.
 */
import type { Prisma } from '@prisma/client';

/** حجم الدفعة — صفوفٌ بأعمدةٍ قليلة، فلا يحمل الخادم ولا القاعدة الصغيرة دفعةً ضخمة واحدة */
export const VISIT_BATCH_SIZE = 5_000;
/** حدّ الأمان للسجلّات الخام في طلبٍ واحد — بلوغه وحده يُعلن `truncated` */
export const VISIT_RAW_CEILING = 200_000;

/** آخر صفٍّ قُرئ: لحظته ومعرّفه (المعرّف يفصل بين سجلّين في اللحظة نفسها) */
export interface KeysetCursor { id: string; createdAt: Date }

/** الترتيب الثابت للقراءة: الأحدث أولاً، والمعرّف كاسر التعادل — فلا يتكرّر صفٌّ بين دفعتين ولا يسقط */
export const NEWEST_FIRST: Prisma.RepVisitOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

/**
 * شرط «أقدم من آخر صفٍّ قُرئ» بالترتيب نفسه — يُضمّ إلى شرط المسار عنصراً في AND (لا نثراً: شرط المسار قد يحمل OR أو AND).
 * الدفعة الأولى بلا مؤشّر فلا قيد. و`createdAt <= لحظة المؤشّر` يلزم من OR نفسه، لكنّ المخطِّط لا يستنتجه منه: صريحاً يصير
 * حدَّ مسحٍ على فهرس (tenantId, createdAt) فتبدأ كل دفعةٍ من موضعها ولا تعيد مسح ما قُرئ قبلها.
 */
export function olderThan(after: KeysetCursor | null): Prisma.RepVisitWhereInput {
  if (!after) return {};
  return {
    createdAt: { lte: after.createdAt },
    OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }],
  };
}

export interface BatchedRead<T> {
  /** الصفوف المقروءة، الأحدث أولاً — `limit` على الأكثر */
  rows: T[];
  /** true فقط إن وُجد في المدى أكثر من `limit` سجلّ فأُسقط الأقدم */
  truncated: boolean;
  /** حدّ الأمان المطبَّق */
  limit: number;
}

/**
 * يقرأ كل صفوف المدى دفعةً بعد دفعة حتى ينفد أو يبلغ الحدّ. `page(after, take)` تعيد حتى `take` صفّاً بالترتيب NEWEST_FIRST
 * بعد المؤشّر `after` (null للأولى). وعند الحدّ تُطلب **صفٌّ واحد زائد** ليُعرف أهناك ما بعده: مدىً فيه الحدّ بالضبط ليس مقصوصاً.
 */
export async function readNewestFirst<T extends KeysetCursor>(
  page: (after: KeysetCursor | null, take: number) => Promise<T[]>,
  opts: { batch?: number; ceiling?: number } = {},
): Promise<BatchedRead<T>> {
  const batch = Math.max(1, opts.batch ?? VISIT_BATCH_SIZE);
  const limit = Math.max(1, opts.ceiling ?? VISIT_RAW_CEILING);
  const rows: T[] = [];
  let after: KeysetCursor | null = null;
  for (;;) {
    // لا تتجاوز الحدّ إلا بصفٍّ واحد هو شاهد «يوجد المزيد»
    const take = Math.min(batch, limit - rows.length + 1);
    const got = await page(after, take);
    for (const r of got) rows.push(r);
    if (rows.length > limit) {
      rows.length = limit;
      return { rows, truncated: true, limit };
    }
    if (got.length < take) return { rows, truncated: false, limit };
    const last = got[got.length - 1];
    after = { id: last.id, createdAt: last.createdAt };
  }
}

/** اليوم 'YYYY-MM-DD' بتوقيت UTC للحظة — null لتاريخٍ غير صالح بدل أن يُسقط المسار بـRangeError */
export function utcDay(d: Date): string | null {
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * «المدى المطبَّق فعلاً» (البند ٩): ما قصّ به الخادم البيانات، بأيام اصطلاح المسار نفسه — لتبني الواجهة عنوان «الفترة» في
 * PDF وExcel منه لا من حقلَي الإدخال (كانت تطبع «كل الفترات» فوق تسعين يوماً فرضها الخادم صامتاً).
 * `defaulted` = لم يحدّد الطالب بداية المدى فاختارها الخادم. والطرف null = بلا حدٍّ من تلك الجهة (حدّد الطالب الطرف الآخر وحده).
 */
export interface AppliedRange { from: string | null; to: string | null; defaulted: boolean }

/**
 * المدى المطبَّق لمساراتٍ تقطع بأيام UTC (`new Date('YYYY-MM-DD')` منتصف ليل UTC، و«إلى» شاملٌ حتى منتصف ليله): يُشتقّ من
 * الشرط الذي طُبِّق نفسه لا من المدخلات — gte يومه، وlt يوم اللحظة التي قبله. وبلا lt فلا حدّ أعلى (`to: null`) ولو كان
 * المدى افتراضياً: نافذة المبيعات والمرتجع والطلبات الافتراضية «آخر ٩٠ يوماً» بلا طرفٍ أعلى، والطلبات تُقصّ بتاريخ التسليم
 * فالتسليمات القادمة داخلة — و«إلى اليوم» كان حدّاً لم يُطبَّق.
 */
export function utcAppliedRange(defaulted: boolean, filter: { gte?: Date; lt?: Date }): AppliedRange {
  return {
    from: filter.gte ? utcDay(filter.gte) : null,
    to: filter.lt ? utcDay(new Date(filter.lt.getTime() - 1)) : null,
    defaulted,
  };
}
