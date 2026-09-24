// ============================================================================
// ZATCA المرحلة الثانية (Z5.8، نقد الخطة 4.4) — سباق التفعيل: قفل صفّ الإعدادات المشترك في مسار إصدار المرحلة الأولى
// ----------------------------------------------------------------------------
// شركةٌ مُسلَّحة قد تُفعَّل حيّاً (goLive يضبط zatcaPhase2StartedAt) بينما فاتورةٌ قرّر نظامُها الضريبيُّ «المرحلة الأولى»
// قبل التفعيل تُجهَّز على وشك الالتزام. بلا قفلٍ يلتزم صفٌّ غير مختوم على شركةٍ صارت حيّة. الحلّ (كترتيب أقفال Z5):
//   • goLive يكتب داخل معاملة تأخذ FOR UPDATE على company_settings (onboardingStore.setPhase2StartedAtOnce).
//   • هذا المسار يعيد قراءة zatcaPhase2StartedAt بقفل مشترك (FOR SHARE) **داخل معاملة الإنشاء** قبل إدراج الصفّ.
// فإمّا تلتزم فاتورة المرحلة الأولى قبل التفعيل (قفلها المشترك سبق قفله الحصريّ)، أو تُحجب ثمّ ترى التفعيل مضبوطاً فتُرفض.
// مطفأ تماماً لغير المُسلَّح ولغير المرحلة الأولى (المستدعي يحرس ذلك) — صفر أثر على أيّ شركة اليوم.
// المعاملات المزيّفة (الاختبار) بلا $queryRaw تقرأ بلا قفل — كنمط invoicesNotes.lockNoteOriginal.
// ============================================================================

import { ZatcaHttpError } from '../compliance/zatca/errors';

/** ما يحتاجه إعادة القراءة من مقبض المعاملة: قفلٌ خام (اختياريّ في المزيّف) + قراءة صفّ الإعدادات. */
export interface GoLiveRaceTx {
  $queryRaw?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  companySettings: { findUnique: (args: unknown) => Promise<{ zatcaPhase2StartedAt: Date | null } | null> };
}

/**
 * سُنّة تُرمى من داخل معاملة الإنشاء حين تبيّن أنّ الشركة فُعّلت حيّاً أثناء تجهيز فاتورة المرحلة الأولى.
 * تحمل ZatcaHttpError جاهزاً (ZATCA_CUTOVER_REVIEW): للطلب الحيّ (اللوحة) رسالةٌ تدعوه للتحديث وإعادة الإصدار (فيمضي
 * مرحلةً ثانية)، ولإعادة رفعٍ من صندوق العمل دون اتصال يبقى المستند مصفوفاً فيُسجَّل عند إعادة الرفع التالية عبر قاعدة
 * الانتقال (D11) — لا رفض صامت ولا فاتورة غير مختومة.
 */
export class Phase2WentLiveError extends Error {
  readonly httpError: ZatcaHttpError;
  constructor() {
    super('PHASE2_WENT_LIVE');
    this.name = 'Phase2WentLiveError';
    this.httpError = new ZatcaHttpError('ZATCA_CUTOVER_REVIEW', { logDetail: { source: 'GO_LIVE_RACE', code: 'STARTED_MIDFLIGHT' } });
  }
}

/**
 * إعادة قراءة zatcaPhase2StartedAt بقفلٍ مشترك (FOR SHARE) داخل المعاملة. يُستدعى فقط حين تكون الشركة مُسلَّحة وقرّر
 * نظامها الضريبيُّ المرحلةَ الأولى (المستدعي يحرس ذلك). يعيد القيمة الطازجة الملتزَمة؛ null = لم تُفعَّل بعد.
 */
export async function reReadPhase2StartedForShare(tx: GoLiveRaceTx, tenantId: string): Promise<Date | null> {
  if (typeof tx.$queryRaw === 'function') {
    await tx.$queryRaw`SELECT id FROM company_settings WHERE "tenantId" = ${tenantId} FOR SHARE`;
  }
  const s = await tx.companySettings.findUnique({ where: { tenantId }, select: { zatcaPhase2StartedAt: true } });
  return s?.zatcaPhase2StartedAt ?? null;
}

/**
 * إن فُعّلت الشركة حيّاً أثناء المعاملة (startedAt صار مضبوطاً) تُرمى Phase2WentLiveError؛ وإلّا لا شيء ويكمل الإنشاء.
 * armed=false (غير مُسلَّحة) ⇒ لا قراءة ولا قفل إطلاقاً — سلوك اليوم حرفاً بحرف.
 */
export async function assertNotWentLiveInTx(tx: GoLiveRaceTx, tenantId: string, armed: boolean): Promise<void> {
  if (!armed) return;
  const startedAt = await reReadPhase2StartedForShare(tx, tenantId);
  if (startedAt != null) throw new Phase2WentLiveError();
}
