/**
 * دفتر برنامج السفراء: الإسناد ← العمولة ← الصرف.
 *
 * القواعد الحاكمة (CONTRACT §1، §3، §4، §5):
 *  - **مصدر حقيقة الدفع** صفّ `payment_links`: الحالة `paid` ومعرّف الشركة، و
 *    `refundedHalalas` للاسترداد الجزئيّ المؤكَّد من ميسر. لا يُقرأ `Tenant.plan` ولا
 *    تاريخ انتهاء الاشتراك (درس «MRR 1197» في المالية).
 *  - **عمولةٌ واحدة لكلّ شركة** على **أوّل دفعةٍ لها على الإطلاق**: إن سبقتها
 *    دفعةٌ (ولو قبل الإسناد) فالشركة ليست عميلاً جديداً جاء به السفير.
 *  - العمولة = النسبة × (الدفعة − المستردّ). النسبة والحجز ومهلة الدفعة الأولى
 *    **لقطةٌ من الشروط التي قبلها السفير**، تُخزَّن على الإسناد.
 *  - **مسودّة الدفعة لقطةٌ مجمَّدة**: المالك يحوّل مبلغها من البنك قبل أن يسجّلها،
 *    فلا شيء يغيّر صافيها. ما يُستردّ بعد تجهيزها — كما بعد صرفها — قيدٌ سالب
 *    يُخصم من الدفعة القادمة. **ولا دفعة سالبة أبداً**.
 *
 * **مصالحة العمولة مع دفعتها دالّةٌ واحدة: `syncCommissionTx`.** تقفل صفّ العمولة
 * ثمّ تقرأها ورابطها من جديد داخل القفل وتقرّر: عكسٌ أو تخفيضٌ لعمولةٍ غير
 * ملتزَمٍ بها، أو قيدٌ سالب بالفرق لعمولةٍ ملتزَمٍ بها. كلّ مسارٍ — خطاف ميسر،
 * المصالحة الدورية، إنشاء الدفعة وتسجيلها وإلغاؤها — يمرّ منها، فلا قرارٌ ماليّ
 * يُبنى على قراءةٍ سبقت القفل.
 *
 * الثابت: **قيد الاسترداد (clawback_refund) لا يوجد إلا لعمولةٍ مدفوعة أو داخل مسودّة**.
 *
 * الخطافات من `routes/payments.ts` تُستدعى خارج معاملة الدفع ولا ترمي، والاسترداد
 * الجزئيّ يُحفظ على الرابط أوّلاً — فما يفوت الخطاف تلتقطه `reconcile()` من المصدر.
 */
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import {
  commissionAfterRefund, clawbackDelta, eligibleAt as calcEligibleAt,
  paymentWithinAttribution, parseRef, attributionFlags, isDisputedByFlags, normPhoneSA, payoutTotals,
  AttributionFlag,
} from './rules';
import { getSettings, rulesFor, logEvent, isUniqueViolation, DAY_MS, TermsRules } from './core';
import { mailCommissionCreated } from './mail';

type Tx = Prisma.TransactionClient;
type Actor = { type: 'system' | 'owner' | 'company' | 'affiliate'; id?: string | null };

/** أسباب الإيقاف التي يضعها النظام ويرفعها حين يزول سببها — إيقاف المالك اليدوي لا يُمسّ */
export const HOLD_DISPUTED = 'الإسناد قيد المراجعة';
export const HOLD_VOID = 'الإسناد مُبطل';
const SYSTEM_HOLDS = new Set([HOLD_DISPUTED, HOLD_VOID]);
/** إيقافاتٌ نظاميّة لا تُرفع آلياً — تحتاج قرار المالك */
export const HOLD_OUTSIDE_WINDOW = 'الدفعة قبل بداية الإسناد الجديد — حرّرها إن كان احتسابها مقصوداً';
export const HOLD_EARLIER_PAYMENT = 'رُبطت بالشركة دفعةٌ أقدم من دفعة هذه العمولة — راجع استحقاقها';
const isManualHold = (note: string | null) => !!note && !SYSTEM_HOLDS.has(note) && note !== HOLD_OUTSIDE_WINDOW;

export const DRAFT_LOCKED = 'العمولة ضمن مسودّة دفعة — ألغِ المسودّة أولاً ثم أعد المحاولة';

export class LedgerError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

const sar = (h: number) => (h / 100).toFixed(2);

async function lockCommission(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM affiliate_commissions WHERE id = ${id} FOR UPDATE`;
}
async function lockAttribution(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM tenant_attributions WHERE id = ${id} FOR UPDATE`;
}

/** العمولة «ملتزَمٌ بها»: صُرفت، أو دخلت مسودّةً قد يكون مبلغها حُوِّل */
function isCommitted(c: { status: string; payoutId: string | null }): boolean {
  return c.status === 'paid' || (c.status === 'approved' && !!c.payoutId);
}

/** الحدّ الأدنى للصرف كما في الشروط التي قبلها السفير — رفعُه في إصدارٍ لم يقبله لا يحبس مستحقّاته */
const rulesCache = new Map<string, Promise<TermsRules>>();
function rulesForCached(version: string): Promise<TermsRules> {
  if (!rulesCache.has(version)) {
    rulesCache.set(version, rulesFor(version));
    setTimeout(() => rulesCache.delete(version), 60_000).unref?.();
  }
  return rulesCache.get(version)!;
}

// ───────────────────────────── الإسناد عند التسجيل ─────────────────────────────

/**
 * يُستدعى **بعد** التزام معاملة التسجيل لا داخلها: خطأٌ داخل معاملة Postgres
 * يُفسدها كلّها فيسقط تسجيل الشركة — والقاعدة ٦ تمنع ذلك منعاً مطلقاً. ثمنه
 * نافذةٌ ضيّقة قد يُفقد فيها الإسناد إن انهار الخادم بين الالتزام وهذا السطر،
 * ويسدّها الإسناد اليدوي من المالك.
 */
export async function attachSignupAttribution(input: {
  tenantId: string; tenantName: string; adminEmail: string; companyPhone: string | null;
  ref: unknown; refVia: unknown; refAt?: unknown;
}): Promise<void> {
  try {
    const code = parseRef(input.ref);
    if (!code) return;
    const affiliate = await prisma.affiliateUser.findUnique({
      where: { code }, select: { id: true, email: true, phone: true, status: true, termsVersion: true },
    });
    if (!affiliate || affiliate.status !== 'approved') return;

    const now = new Date();
    const via = input.refVia === 'link' ? 'link' : 'typed';
    const [settings, rules] = await Promise.all([getSettings(), rulesFor(affiliate.termsVersion)]);
    // صلاحية الرابط من الشروط التي قبلها السفير، وتُفرض هنا لا في المتصفّح وحده
    // رابطٌ تجاوز مدّته لا يُهمَل بصمت: قد يكون السفير أبلغ الشركة برمزه مجدّداً فتركته
    // مملوءاً — يُسجَّل متنازعاً عليه ويحسمه المالك بدل أن تضيع الإحالة بلا أثر
    const linkExpired = via === 'link' && typeof input.refAt === 'number' && Number.isFinite(input.refAt)
      && input.refAt <= now.getTime() + DAY_MS
      && now.getTime() - input.refAt > rules.refWindowDays * DAY_MS;

    // جوالات الشركات مخزَّنةٌ كما كُتبت («055 123 4567»، أرقامٌ هندية) — تُطبَّع كلّها
    // هنا؛ مطابقةٌ نصّية في SQL كانت تُفلت العميل القائم وهي الحارس الآلي الوحيد
    const comp = normPhoneSA(input.companyPhone ?? '');
    const existingCompanyPhones = comp
      ? (await prisma.companySettings.findMany({
          where: { tenantId: { not: input.tenantId }, phone: { not: null } }, select: { phone: true },
        })).map(s => s.phone ?? '').filter(p => normPhoneSA(p) === comp)
      : [];
    const flags: AttributionFlag[] = attributionFlags({
      affiliateEmail: affiliate.email, affiliatePhone: affiliate.phone,
      adminEmail: input.adminEmail, companyPhone: input.companyPhone, existingCompanyPhones,
    });
    // سفيرٌ لم يقبل الشروط الحالية لا يواصل الكسب بشروطٍ نُسخت — يحسمه المالك
    const outdated = affiliate.termsVersion !== settings.currentTermsVersion;
    if (outdated) flags.push('terms_outdated');
    if (linkExpired) flags.push('link_expired');
    const status = outdated || linkExpired || isDisputedByFlags(flags) ? 'disputed' : 'active';

    await prisma.$transaction(async tx => {
      const a = await tx.tenantAttribution.create({
        data: {
          tenantId: input.tenantId, tenantNameSnapshot: input.tenantName, affiliateId: affiliate.id,
          source: 'signup_code', codeUsed: code, refVia: via, status, flags,
          effectiveFrom: now, rateBps: rules.rateBps, holdDays: rules.holdDays,
          firstPaymentDeadline: new Date(now.getTime() + rules.firstPaymentWithinDays * DAY_MS),
          termsVersion: affiliate.termsVersion,
        },
      });
      await logEvent(tx, {
        entity: 'attribution', entityId: a.id, action: 'created', toState: status,
        actorType: 'company', actorId: input.tenantId, meta: { source: 'signup_code', via, flags },
      });
    });
  } catch (e) {
    if (!isUniqueViolation(e)) console.error('[affiliate] signup attribution skipped:', (e as Error).message);
  }
}

// ───────────────────────────── نشوء العمولة ─────────────────────────────

export type AccrueResult =
  | { created: true; commissionId: string; status: string }
  | { created: false; reason: string };

/** يُنشئ عمولة الدفعة إن استوفت كلّ الشروط — آمنٌ للتكرار */
export async function accrueForPayment(linkId: string): Promise<AccrueResult> {
  try {
    const link = await prisma.paymentLink.findUnique({ where: { id: linkId } });
    if (!link || link.status !== 'paid' || !link.paidAt || !link.tenantId) return { created: false, reason: 'not_paid_or_unlinked' };
    if (link.amountHalalas <= 0) return { created: false, reason: 'zero_amount' };
    const paidAt = link.paidAt;

    const existing = await prisma.affiliateCommission.findUnique({ where: { tenantId: link.tenantId } });
    if (existing) {
      // دفعةٌ أقدم رُبطت بالشركة بعد أن نشأت العمولة على دفعةٍ لاحقة (رابط تسجيل واتساب
      // يتيم) — العمولة القائمة ليست على «أوّل دفعة»
      if (existing.paymentLinkId !== link.id && existing.paymentPaidAt.getTime() > paidAt.getTime()) {
        // المصالحة تُوقف غير الملتزَم بها، والسبب يصف ما حدث فعلاً لا ما كان يُرجى
        if (isCommitted(existing)) return { created: false, reason: 'earlier_payment_committed' };
        if (existing.status === 'reversed' || existing.status === 'declined') return { created: false, reason: 'earlier_payment_no_commission' };
        await syncCommission(existing.id);
        return { created: false, reason: 'earlier_payment_linked' };
      }
      return { created: false, reason: 'exists' };
    }

    // أوّل دفعةٍ للشركة على الإطلاق — لا «أوّل دفعة بعد الإسناد»
    const earlier = await prisma.paymentLink.findFirst({
      where: { tenantId: link.tenantId, id: { not: link.id }, paidAt: { not: null, lt: paidAt } },
      select: { id: true },
    });
    if (earlier) return { created: false, reason: 'not_first_payment' };

    const head = await prisma.tenantAttribution.findUnique({ where: { tenantId: link.tenantId }, select: { id: true } });
    if (!head) return { created: false, reason: 'no_attribution' };

    let reason = '';
    const c = await prisma.$transaction(async tx => {
      // قفل الإسناد: نقلُه لسفيرٍ آخر في اللحظة نفسها لا يُنشئ عمولةً للسابق
      await lockAttribution(tx, head.id);
      const a = await tx.tenantAttribution.findUnique({ where: { id: head.id } });
      if (!a || a.status === 'void') { reason = 'no_attribution'; return null; }
      if (!paymentWithinAttribution(paidAt, a)) { reason = 'outside_window'; return null; }
      const amount = commissionAfterRefund(link.amountHalalas, link.refundedHalalas, a.rateBps);
      if (amount <= 0) { reason = 'zero_commission'; return null; }
      const onHold = a.status === 'disputed';
      const row = await tx.affiliateCommission.create({
        data: {
          tenantId: link.tenantId!, paymentLinkId: link.id, affiliateId: a.affiliateId,
          attributionId: a.id, tenantNameSnapshot: a.tenantNameSnapshot,
          paymentAmountHalalas: link.amountHalalas, refundedHalalas: link.refundedHalalas, coveredMonths: link.months,
          rateBps: a.rateBps, commissionHalalas: amount,
          paymentPaidAt: paidAt, eligibleAt: calcEligibleAt(paidAt, a.holdDays), status: onHold ? 'on_hold' : 'pending',
          reasonNote: onHold ? HOLD_DISPUTED : null, termsVersion: a.termsVersion,
        },
      });
      await logEvent(tx, {
        entity: 'commission', entityId: row.id, action: 'accrued', toState: row.status, actorType: 'system',
        meta: { paymentLinkId: link.id, paymentAmountHalalas: link.amountHalalas, refundedHalalas: link.refundedHalalas, commissionHalalas: amount },
      });
      return row;
    });
    if (!c) return { created: false, reason };

    const aff = await prisma.affiliateUser.findUnique({ where: { id: c.affiliateId }, select: { email: true, fullName: true } });
    if (aff) mailCommissionCreated(aff.email, aff.fullName, { tenantName: c.tenantNameSnapshot, commissionHalalas: c.commissionHalalas, eligibleAt: c.eligibleAt, onHold: c.status === 'on_hold' });
    return { created: true, commissionId: c.id, status: c.status };
  } catch (e) {
    if (isUniqueViolation(e)) return { created: false, reason: 'exists' };
    console.error(`[affiliate] accrue ${linkId} failed:`, (e as Error).message);
    return { created: false, reason: 'error' };
  }
}

/** بعد إنشاء إسنادٍ أو تعديله: ابحث عن أوّل دفعة الشركة */
export async function accrueForTenant(tenantId: string): Promise<AccrueResult> {
  const first = await prisma.paymentLink.findFirst({
    where: { tenantId, paidAt: { not: null } }, orderBy: { paidAt: 'asc' }, select: { id: true, status: true },
  });
  if (!first) return { created: false, reason: 'no_payment' };
  if (first.status !== 'paid') return { created: false, reason: 'first_payment_reversed' };
  return accrueForPayment(first.id);
}

// ───────────────────────────── مصالحة العمولة مع دفعتها ─────────────────────────────

export type SyncOutcome = 'missing' | 'terminal' | 'noop' | 'reversed' | 'reduced' | 'clawback' | 'held_earlier' | 'error';

/**
 * يجب أن تُستدعى داخل معاملة. القفل أوّلاً ثمّ كلّ القراءات — لا شيء ممّا قُرئ
 * قبله يدخل القرار.
 */
async function syncCommissionTx(tx: Tx, commissionId: string, actor: Actor): Promise<SyncOutcome> {
  await lockCommission(tx, commissionId);
  const c = await tx.affiliateCommission.findUnique({ where: { id: commissionId } });
  if (!c) return 'missing';
  if (c.status === 'reversed' || c.status === 'declined') return 'terminal';
  const link = await tx.paymentLink.findUnique({ where: { id: c.paymentLinkId }, select: { status: true, refundedHalalas: true } });
  const paid = link?.status === 'paid';
  const refunded = paid ? Math.max(c.refundedHalalas, link!.refundedHalalas) : c.paymentAmountHalalas;
  const target = paid ? commissionAfterRefund(c.paymentAmountHalalas, refunded, c.rateBps) : 0;

  if (isCommitted(c)) {
    if (refunded !== c.refundedHalalas) {
      await tx.affiliateCommission.update({ where: { id: c.id }, data: { refundedHalalas: refunded } });
    }
    const agg = await tx.affiliateAdjustment.aggregate({ where: { commissionId: c.id, kind: 'clawback_refund' }, _sum: { amountHalalas: true } });
    const delta = clawbackDelta(agg._sum.amountHalalas ?? 0, target - c.commissionHalalas);
    if (delta >= 0) return 'noop';
    const adj = await tx.affiliateAdjustment.create({
      data: {
        affiliateId: c.clawbackAffiliateId ?? c.affiliateId, commissionId: c.id, kind: 'clawback_refund',
        sourceRef: `sync:${paid ? `refund:${refunded}` : `link:${link?.status ?? 'missing'}`}`,
        amountHalalas: delta, createdBy: actor.id ?? 'system',
        note: paid
          ? `استرداد جزئي ${sar(refunded)} ر.س من دفعة «${c.tenantNameSnapshot}» بعد ${c.status === 'paid' ? 'صرف' : 'تجهيز'} عمولتها`
          : `استرداد دفعة «${c.tenantNameSnapshot}» بعد ${c.status === 'paid' ? 'صرف' : 'تجهيز'} عمولتها`,
      },
    });
    await logEvent(tx, { entity: 'adjustment', entityId: adj.id, action: 'clawback', actorType: actor.type, actorId: actor.id, meta: { commissionId: c.id, amountHalalas: delta, linkStatus: link?.status ?? 'missing', refunded } });
    return 'clawback';
  }

  if (!paid) {
    await tx.affiliateCommission.update({ where: { id: c.id }, data: { status: 'reversed', reversedAt: new Date(), reasonNote: 'استُردّت الدفعة' } });
    // الثابت: لا قيد استردادٍ لعمولةٍ غير ملتزَمٍ بها
    await tx.affiliateAdjustment.deleteMany({ where: { commissionId: c.id, kind: 'clawback_refund', payoutId: null } });
    await logEvent(tx, { entity: 'commission', entityId: c.id, action: 'reversed', fromState: c.status, toState: 'reversed', actorType: actor.type, actorId: actor.id, meta: { linkStatus: link?.status ?? 'missing' } });
    return 'reversed';
  }
  let outcome: SyncOutcome = 'noop';
  if (refunded !== c.refundedHalalas || target !== c.commissionHalalas) {
    await tx.affiliateCommission.update({ where: { id: c.id }, data: { refundedHalalas: refunded, commissionHalalas: target } });
    await logEvent(tx, { entity: 'commission', entityId: c.id, action: 'partial_refund', actorType: actor.type, actorId: actor.id, meta: { refundedHalalas: refunded, before: c.commissionHalalas, after: target } });
    outcome = 'reduced';
  }
  // «الدفعة الأولى فقط»: دفعةٌ أقدم للشركة (رابط تسجيل يتيم رُبط لاحقاً) تعني أنّ هذه
  // العمولة ليست على الأولى — تُوقف هنا، في النقطة التي يمرّ منها كلّ قرارٍ ماليّ، فلا
  // يرفعها تفعيلٌ أو نقلٌ لاحق دون أن تُراجع
  const earlier = await tx.paymentLink.findFirst({
    where: { tenantId: c.tenantId, id: { not: c.paymentLinkId }, paidAt: { not: null, lt: c.paymentPaidAt } }, select: { id: true },
  });
  if (earlier && !(c.status === 'on_hold' && c.reasonNote?.startsWith(HOLD_EARLIER_PAYMENT))) {
    const note = c.status === 'on_hold' && c.reasonNote ? `${HOLD_EARLIER_PAYMENT} (سابقاً: ${c.reasonNote})` : HOLD_EARLIER_PAYMENT;
    await tx.affiliateCommission.update({ where: { id: c.id }, data: { status: 'on_hold', reasonNote: note } });
    await logEvent(tx, { entity: 'commission', entityId: c.id, action: 'hold', fromState: c.status, toState: 'on_hold', actorType: actor.type, actorId: actor.id, reason: HOLD_EARLIER_PAYMENT, meta: { earlierLinkId: earlier.id } });
    return 'held_earlier';
  }
  return outcome;
}

export async function syncCommission(commissionId: string, actor: Actor = { type: 'system' }): Promise<SyncOutcome> {
  try {
    return await prisma.$transaction(tx => syncCommissionTx(tx, commissionId, actor));
  } catch (e) {
    if (isUniqueViolation(e)) return 'noop';
    console.error(`[affiliate] sync ${commissionId} failed:`, (e as Error).message);
    return 'error';
  }
}

/** خطاف: دفعةٌ لم تعد مدفوعة */
export async function reverseForPayment(linkId: string, actor: Actor = { type: 'system' }): Promise<{ reversed: boolean; reason?: string }> {
  const c = await prisma.affiliateCommission.findUnique({ where: { paymentLinkId: linkId }, select: { id: true } }).catch(() => null);
  if (!c) return { reversed: false, reason: 'no_commission' };
  const out = await syncCommission(c.id, actor);
  return { reversed: out === 'reversed' || out === 'clawback', reason: out };
}

/**
 * خطاف: استردادٌ جزئيّ حُفظ على الرابط (`payment_links.refundedHalalas`). لا يحمل
 * مبلغاً — المصدر على الرابط، فاستدعاءٌ فائت تُكمله `reconcile()` لاحقاً.
 */
export async function applyPartialRefund(linkId: string, actor: Actor = { type: 'system' }): Promise<SyncOutcome> {
  const c = await prisma.affiliateCommission.findUnique({ where: { paymentLinkId: linkId }, select: { id: true } }).catch(() => null);
  if (!c) return 'missing';
  return syncCommission(c.id, actor);
}

/**
 * مصالحة الدفتر مع روابط الدفع — تلتقط ما فات الخطافات من الاتّجاهين: دفعةٌ أولى
 * لشركةٍ مُسندة بلا عمولة، وعمولةٌ حيّة تغيّرت دفعتها (عكسٌ أو استردادٌ جزئي).
 * تقرأ كلّ الصفوف بصفحات — سقفٌ ثابت كان سيُعيد القديم نفسه ويُهمل الجديد.
 */
export async function reconcile(): Promise<{ accrued: number; synced: number }> {
  let accrued = 0; let synced = 0;
  const PAGE = 1000;

  // ترقيمٌ بالمفتاح (id > آخر مقروء) لا بمؤشّر Prisma: المعالجة تُخرج الصفّ من المرشِّح،
  // ومؤشّرٌ على صفٍّ خرج منه يُسقط بـskip الصفَّ التالي
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.tenantAttribution.findMany({
      where: { status: { in: ['active', 'disputed'] }, commission: { is: null }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, tenantId: true }, orderBy: { id: 'asc' }, take: PAGE,
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    const paid = await prisma.paymentLink.findMany({
      where: { tenantId: { in: rows.map(r => r.tenantId) }, status: 'paid' }, select: { tenantId: true }, distinct: ['tenantId'],
    });
    for (const p of paid) if (p.tenantId && (await accrueForTenant(p.tenantId)).created) accrued++;
    if (rows.length < PAGE) break;
  }

  let after: string | undefined;
  for (;;) {
    const rows: { id: string; paymentLinkId: string; refundedHalalas: number }[] = await prisma.affiliateCommission.findMany({
      where: { status: { in: ['pending', 'on_hold', 'approved', 'paid'] }, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, paymentLinkId: true, refundedHalalas: true }, orderBy: { id: 'asc' }, take: PAGE,
    });
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    const links = await prisma.paymentLink.findMany({ where: { id: { in: rows.map(r => r.paymentLinkId) } }, select: { id: true, status: true, refundedHalalas: true } });
    const byId = new Map(links.map(l => [l.id, l]));
    for (const r of rows) {
      const l = byId.get(r.paymentLinkId);
      if (!l || l.status !== 'paid' || l.refundedHalalas > r.refundedHalalas) {
        const out = await syncCommission(r.id);
        if (out === 'reversed' || out === 'reduced' || out === 'clawback') synced++;
      }
    }
    if (rows.length < PAGE) break;
  }
  return { accrued, synced };
}

// ───────────────────────────── قرارات المالك على العمولة ─────────────────────────────

export async function approveCommission(id: string, ownerId: string): Promise<string> {
  // الدفعة أوّلاً: عكسٌ أو استردادٌ جزئيّ فات خطافه يُطبَّق قبل أيّ اعتماد
  const synced = await syncCommission(id, { type: 'owner', id: ownerId });
  if (synced === 'reversed') throw new LedgerError(409, 'الدفعة لم تعد مدفوعة — عُكست العمولة', 'payment_not_paid');
  if (synced === 'error') throw new LedgerError(503, 'تعذّرت مطابقة العمولة مع دفعتها الآن — أعد المحاولة', 'sync_failed');
  const c = await prisma.affiliateCommission.findUnique({ where: { id }, include: { affiliate: { select: { status: true } }, attribution: { select: { status: true } } } });
  if (!c) throw new LedgerError(404, 'العمولة غير موجودة');
  if (c.status === 'on_hold' && c.reasonNote?.startsWith(HOLD_EARLIER_PAYMENT)) {
    throw new LedgerError(409, 'للشركة دفعةٌ أقدم من دفعة هذه العمولة — ليست الدفعة الأولى؛ ارفضها وعوّض بقيد تصحيح إن لزم', 'earlier_payment');
  }
  if (c.status !== 'pending') throw new LedgerError(409, 'العمولة ليست معلّقة', 'not_pending');
  if (Date.now() < c.eligibleAt.getTime()) throw new LedgerError(409, `لم تنتهِ مدّة الحجز — تُعتمد بعد ${c.eligibleAt.toISOString().slice(0, 10)}`, 'hold_not_over');
  if (c.attribution.status !== 'active') throw new LedgerError(409, 'الإسناد ليس سارياً — احسمه أولاً', 'attribution_not_active');
  if (c.affiliate.status !== 'approved') throw new LedgerError(409, 'حساب السفير ليس مقبولاً حالياً', 'affiliate_not_approved');
  if (c.commissionHalalas <= 0) throw new LedgerError(409, 'العمولة صفر بعد الاسترداد — ارفضها', 'zero_commission');
  await prisma.$transaction(async tx => {
    const won = await tx.affiliateCommission.updateMany({
      where: { id, status: 'pending', commissionHalalas: c.commissionHalalas }, data: { status: 'approved', approvedAt: new Date(), approvedBy: ownerId },
    });
    if (won.count !== 1) throw new LedgerError(409, 'تغيّرت العمولة — حدّث الصفحة', 'raced');
    await logEvent(tx, { entity: 'commission', entityId: id, action: 'approved', fromState: 'pending', toState: 'approved', actorType: 'owner', actorId: ownerId, meta: { commissionHalalas: c.commissionHalalas } });
  });
  return 'approved';
}

export async function holdCommission(id: string, ownerId: string, reason: string): Promise<string> {
  const c = await prisma.affiliateCommission.findUnique({ where: { id } });
  if (!c) throw new LedgerError(404, 'العمولة غير موجودة');
  if (c.payoutId) throw new LedgerError(409, DRAFT_LOCKED, 'in_draft');
  if (!['pending', 'approved'].includes(c.status)) throw new LedgerError(409, 'لا يمكن إيقاف عمولةٍ بهذه الحالة');
  await prisma.$transaction(async tx => {
    const won = await tx.affiliateCommission.updateMany({
      where: { id, status: c.status, payoutId: null }, data: { status: 'on_hold', reasonNote: reason },
    });
    if (won.count !== 1) throw new LedgerError(409, 'تغيّرت حالة العمولة — ربما دخلت مسودّة دفعة؛ حدّث الصفحة');
    await logEvent(tx, { entity: 'commission', entityId: id, action: 'hold', fromState: c.status, toState: 'on_hold', actorType: 'owner', actorId: ownerId, reason });
  });
  return 'on_hold';
}

export async function releaseCommission(id: string, ownerId: string): Promise<string> {
  const c = await prisma.affiliateCommission.findUnique({ where: { id }, include: { attribution: { select: { status: true } } } });
  if (!c) throw new LedgerError(404, 'العمولة غير موجودة');
  if (c.status !== 'on_hold') throw new LedgerError(409, 'العمولة ليست موقوفة');
  if (c.attribution.status !== 'active') throw new LedgerError(409, 'الإسناد ليس سارياً — احسمه أولاً');
  await prisma.$transaction(async tx => {
    const won = await tx.affiliateCommission.updateMany({ where: { id, status: 'on_hold' }, data: { status: 'pending', reasonNote: null } });
    if (won.count !== 1) throw new LedgerError(409, 'تغيّرت حالة العمولة — حدّث الصفحة');
    await logEvent(tx, { entity: 'commission', entityId: id, action: 'release', fromState: 'on_hold', toState: 'pending', actorType: 'owner', actorId: ownerId });
  });
  return 'pending';
}

export async function declineCommission(id: string, ownerId: string, reason: string): Promise<string> {
  const c = await prisma.affiliateCommission.findUnique({ where: { id } });
  if (!c) throw new LedgerError(404, 'العمولة غير موجودة');
  if (!['pending', 'on_hold'].includes(c.status)) throw new LedgerError(409, 'لا يمكن رفض عمولةٍ بهذه الحالة');
  await prisma.$transaction(async tx => {
    const won = await tx.affiliateCommission.updateMany({ where: { id, status: c.status, payoutId: null }, data: { status: 'declined', reasonNote: reason } });
    if (won.count !== 1) throw new LedgerError(409, 'تغيّرت حالة العمولة — حدّث الصفحة');
    await logEvent(tx, { entity: 'commission', entityId: id, action: 'declined', fromState: c.status, toState: 'declined', actorType: 'owner', actorId: ownerId, reason });
  });
  return 'declined';
}

// ───────────────────────────── قرارات المالك على الإسناد ─────────────────────────────

async function tenantBrief(tenantId: string) {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, createdAt: true } });
  if (!t) throw new LedgerError(404, 'الشركة غير موجودة');
  return t;
}

async function approvedAffiliate(id: string) {
  const aff = await prisma.affiliateUser.findUnique({ where: { id }, select: { id: true, status: true, termsVersion: true } });
  if (!aff) throw new LedgerError(404, 'السفير غير موجود');
  if (aff.status !== 'approved') throw new LedgerError(409, 'السفير ليس مقبولاً');
  return aff;
}

/** عمولةٌ داخل مسودّة لا يغيّرها قرارٌ على الإسناد — ما في المسودّة قد حُوِّل */
function assertNotInDraft(c: { payoutId: string | null; status: string } | null | undefined): void {
  if (c && c.status === 'approved' && c.payoutId) throw new LedgerError(409, DRAFT_LOCKED, 'in_draft');
}

/** إسنادٌ يدويّ من المالك — `effectiveFrom` في الماضي يسمح بإسنادٍ متأخّر عن دفعةٍ تمّت */
export async function createOwnerAttribution(input: { tenantId: string; affiliateId: string; reason: string; effectiveFrom?: Date }, ownerId: string) {
  const t = await tenantBrief(input.tenantId);
  const aff = await approvedAffiliate(input.affiliateId);
  const eff = input.effectiveFrom ?? new Date();
  if (eff.getTime() > Date.now()) throw new LedgerError(400, 'تاريخ السريان لا يكون في المستقبل');
  const existing = await prisma.tenantAttribution.findUnique({ where: { tenantId: t.id }, select: { id: true } });
  if (existing) throw new LedgerError(409, 'للشركة إسنادٌ قائم — استعمل «إعادة إسناد» عليه بعد إبطاله أو وضعه قيد المراجعة', 'exists');
  const rules = await rulesFor(aff.termsVersion);
  let attributionId = '';
  try {
    await prisma.$transaction(async tx => {
      const a = await tx.tenantAttribution.create({
        data: {
          tenantId: t.id, tenantNameSnapshot: t.name, affiliateId: aff.id, source: 'owner', status: 'active', flags: [],
          reasonNote: input.reason, effectiveFrom: eff, rateBps: rules.rateBps, holdDays: rules.holdDays,
          firstPaymentDeadline: new Date(Math.max(eff.getTime(), t.createdAt.getTime()) + rules.firstPaymentWithinDays * DAY_MS),
          termsVersion: aff.termsVersion, decidedBy: ownerId,
        },
      });
      attributionId = a.id;
      await logEvent(tx, { entity: 'attribution', entityId: a.id, action: 'created', toState: 'active', actorType: 'owner', actorId: ownerId, reason: input.reason, meta: { source: 'owner' } });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new LedgerError(409, 'للشركة إسنادٌ قائم — استعمل «إعادة إسناد»', 'exists');
    throw e;
  }
  const accrual = await accrueForTenant(t.id);
  return { attributionId, accrual };
}

export async function voidAttribution(id: string, ownerId: string, reason: string) {
  await prisma.$transaction(async tx => {
    await lockAttribution(tx, id);
    const a = await tx.tenantAttribution.findUnique({ where: { id }, include: { commission: true } });
    if (!a) throw new LedgerError(404, 'الإسناد غير موجود');
    if (a.status === 'void') throw new LedgerError(409, 'الإسناد مُبطل مسبقاً');
    // القرار على العمولة بعد قفلها وقراءتها من جديد: إنشاء دفعةٍ متزامن قد أدخلها مسودّة
    const c = a.commission ? (await lockCommission(tx, a.commission.id), await tx.affiliateCommission.findUnique({ where: { id: a.commission.id } })) : null;
    assertNotInDraft(c);
    await tx.tenantAttribution.update({ where: { id }, data: { status: 'void', reasonNote: reason, decidedBy: ownerId } });
    // إيقاف المالك اليدويّ يبقى كما هو بسببه — لا يُكتب فوقه سببٌ نظاميّ يرفعه التفعيل لاحقاً.
    // والمدفوعة لا تُمسّ آلياً — إن أراد المالك استعادتها فبقيد تصحيحٍ صريح
    if (c && (c.status === 'pending' || c.status === 'approved' || (c.status === 'on_hold' && !!c.reasonNote && SYSTEM_HOLDS.has(c.reasonNote)))) {
      const cw = await tx.affiliateCommission.updateMany({ where: { id: c.id, status: c.status, payoutId: null }, data: { status: 'on_hold', reasonNote: HOLD_VOID } });
      if (cw.count !== 1) throw new LedgerError(409, DRAFT_LOCKED, 'in_draft');
      await logEvent(tx, { entity: 'commission', entityId: c.id, action: 'hold', fromState: c.status, toState: 'on_hold', actorType: 'owner', actorId: ownerId, reason: HOLD_VOID });
    }
    await logEvent(tx, { entity: 'attribution', entityId: id, action: 'void', fromState: a.status, toState: 'void', actorType: 'owner', actorId: ownerId, reason });
  });
}

/** void→active أو disputed→active: تُرفع إيقافات النظام وتُحاول العمولة إن لم توجد */
export async function activateAttribution(id: string, ownerId: string, reason: string) {
  const hadCommission = await prisma.$transaction(async tx => {
    await lockAttribution(tx, id);
    const a = await tx.tenantAttribution.findUnique({ where: { id }, include: { commission: true } });
    if (!a) throw new LedgerError(404, 'الإسناد غير موجود');
    if (a.status === 'active') throw new LedgerError(409, 'الإسناد سارٍ مسبقاً');
    await tx.tenantAttribution.update({ where: { id }, data: { status: 'active', reasonNote: reason, decidedBy: ownerId } });
    const c = a.commission;
    if (c) {
      await lockCommission(tx, c.id);
      const fresh = await tx.affiliateCommission.findUnique({ where: { id: c.id } });
      if (fresh && fresh.status === 'on_hold' && fresh.reasonNote && SYSTEM_HOLDS.has(fresh.reasonNote)) {
        await tx.affiliateCommission.update({ where: { id: c.id }, data: { status: 'pending', reasonNote: null } });
        await logEvent(tx, { entity: 'commission', entityId: c.id, action: 'release', fromState: 'on_hold', toState: 'pending', actorType: 'owner', actorId: ownerId, reason: 'تفعيل الإسناد' });
      }
    }
    await logEvent(tx, { entity: 'attribution', entityId: id, action: 'activate', fromState: a.status, toState: 'active', actorType: 'owner', actorId: ownerId, reason });
    return c ? { commissionId: c.id, tenantId: a.tenantId } : { commissionId: null, tenantId: a.tenantId };
  });
  if (hadCommission.commissionId) {
    // الرابط قد يكون استُردّ أثناء الإبطال
    await syncCommission(hadCommission.commissionId, { type: 'owner', id: ownerId });
    return { accrual: null };
  }
  return { accrual: await accrueForTenant(hadCommission.tenantId) };
}

/**
 * نقل إسنادٍ متنازعٍ عليه أو مُبطَل إلى سفيرٍ آخر — الطريق ليكسب الأحقّ (ترشيحٌ
 * معتمد سبق رمز التسجيل، أو رمزٌ أُدخل خطأً). الصفّ يُعاد توجيهه في مكانه لأنّ
 * الإسناد فريدٌ لكلّ شركة، وكلّ القراءات داخل القفل.
 *
 * العمولة:
 *  - غير المصروفة (معلّقة/موقوفة/معتمدة/**مرفوضة**) تُعاد لقطتها للسفير الجديد؛ رفضٌ
 *    قُصد به السفير السابق لا يحرم الأحقّ. وإيقاف المالك اليدويّ يبقى بسببه.
 *  - المصروفة تبقى تاريخاً للسابق، ويُقيَّد تلقائياً سالبٌ عليه وموجبٌ للجديد بصافيها،
 *    ويتحمّل الجديد أيّ استردادٍ لاحق (`clawbackAffiliateId`).
 */
export async function reassignAttribution(
  id: string,
  input: { affiliateId: string; reason: string; effectiveFrom?: Date; claimId?: string },
  ownerId: string,
) {
  const aff = await approvedAffiliate(input.affiliateId);
  if (input.effectiveFrom && input.effectiveFrom.getTime() > Date.now()) throw new LedgerError(400, 'تاريخ السريان لا يكون في المستقبل');
  let claim: { id: string; submittedAt: Date } | null = null;
  if (input.claimId) {
    const cl = await prisma.affiliateClaim.findUnique({ where: { id: input.claimId } });
    if (!cl || cl.affiliateId !== aff.id) throw new LedgerError(400, 'الترشيح لا يخصّ هذا السفير');
    if (!['approved', 'expired'].includes(cl.status)) throw new LedgerError(409, 'يُستعمل ترشيحٌ معتمد أو منتهٍ فقط');
    claim = { id: cl.id, submittedAt: cl.submittedAt };
  }
  const rules = await rulesFor(aff.termsVersion);

  const out = await prisma.$transaction(async tx => {
    await lockAttribution(tx, id);
    const a = await tx.tenantAttribution.findUnique({ where: { id }, include: { commission: true } });
    if (!a) throw new LedgerError(404, 'الإسناد غير موجود');
    if (a.status === 'active') throw new LedgerError(409, 'أبطل الإسناد أو ضعه قيد المراجعة قبل نقله');
    const t = await tx.tenant.findUnique({ where: { id: a.tenantId }, select: { createdAt: true } });
    const c = a.commission ? (await lockCommission(tx, a.commission.id), await tx.affiliateCommission.findUnique({ where: { id: a.commission.id } })) : null;
    assertNotInDraft(c);

    const eff = input.effectiveFrom ?? claim?.submittedAt ?? a.effectiveFrom;
    const deadline = new Date(Math.max(eff.getTime(), (t?.createdAt ?? eff).getTime()) + rules.firstPaymentWithinDays * DAY_MS);
    await tx.tenantAttribution.update({
      where: { id },
      data: {
        affiliateId: aff.id, source: claim ? 'claim' : 'owner', claimId: claim?.id ?? null, codeUsed: null, refVia: null,
        flags: [], status: 'active', reasonNote: input.reason, effectiveFrom: eff, firstPaymentDeadline: deadline,
        rateBps: rules.rateBps, holdDays: rules.holdDays, termsVersion: aff.termsVersion, decidedBy: ownerId,
      },
    });

    if (c && ['pending', 'on_hold', 'approved', 'declined'].includes(c.status)) {
      const inWindow = paymentWithinAttribution(c.paymentPaidAt, { effectiveFrom: eff, firstPaymentDeadline: deadline });
      const keepManualHold = c.status === 'on_hold' && isManualHold(c.reasonNote);
      const status = keepManualHold ? 'on_hold' : inWindow ? 'pending' : 'on_hold';
      const reasonNote = keepManualHold ? c.reasonNote : inWindow ? null : HOLD_OUTSIDE_WINDOW;
      await tx.affiliateCommission.update({
        where: { id: c.id },
        data: {
          affiliateId: aff.id, clawbackAffiliateId: null, rateBps: rules.rateBps,
          commissionHalalas: commissionAfterRefund(c.paymentAmountHalalas, c.refundedHalalas, rules.rateBps),
          eligibleAt: calcEligibleAt(c.paymentPaidAt, rules.holdDays), termsVersion: aff.termsVersion,
          status, reasonNote, approvedAt: null, approvedBy: null,
        },
      });
      await logEvent(tx, { entity: 'commission', entityId: c.id, action: 'reassigned', fromState: c.status, toState: status, actorType: 'owner', actorId: ownerId, reason: input.reason, meta: { fromAffiliate: c.affiliateId, toAffiliate: aff.id } });
    } else if (c && c.status === 'paid') {
      const bearer = c.clawbackAffiliateId ?? c.affiliateId;
      if (bearer !== aff.id) {
        const agg = await tx.affiliateAdjustment.aggregate({ where: { commissionId: c.id, kind: 'clawback_refund' }, _sum: { amountHalalas: true } });
        const net = c.commissionHalalas + (agg._sum.amountHalalas ?? 0);
        const n = await tx.affiliateAdjustment.count({ where: { commissionId: c.id, kind: 'correction', sourceRef: { startsWith: 'reassign:' } } });
        if (net > 0) {
          await tx.affiliateAdjustment.create({ data: { affiliateId: bearer, commissionId: c.id, kind: 'correction', sourceRef: `reassign:${n}:from`, amountHalalas: -net, note: `نُقل إسناد «${c.tenantNameSnapshot}» لسفيرٍ آخر بعد صرف عمولته`, createdBy: ownerId } });
          await tx.affiliateAdjustment.create({ data: { affiliateId: aff.id, commissionId: c.id, kind: 'correction', sourceRef: `reassign:${n}:to`, amountHalalas: net, note: `عمولة «${c.tenantNameSnapshot}» بعد نقل إسنادها إليك`, createdBy: ownerId } });
        }
        await tx.affiliateCommission.update({ where: { id: c.id }, data: { clawbackAffiliateId: aff.id } });
        await logEvent(tx, { entity: 'commission', entityId: c.id, action: 'reassigned_paid', actorType: 'owner', actorId: ownerId, reason: input.reason, meta: { from: bearer, to: aff.id, netHalalas: net } });
      }
    }
    if (claim) {
      await tx.affiliateClaim.update({ where: { id: claim.id }, data: { status: 'converted', tenantId: a.tenantId, convertedAt: new Date() } });
      await logEvent(tx, { entity: 'claim', entityId: claim.id, action: 'converted', toState: 'converted', actorType: 'owner', actorId: ownerId, meta: { tenantId: a.tenantId, via: 'reassign' } });
    }
    await logEvent(tx, {
      entity: 'attribution', entityId: id, action: 'reassigned', fromState: a.status, toState: 'active', actorType: 'owner', actorId: ownerId,
      reason: input.reason, meta: { fromAffiliate: a.affiliateId, toAffiliate: aff.id, codeUsed: a.codeUsed, claimId: claim?.id ?? null },
    });
    return { tenantId: a.tenantId, commissionId: c?.id ?? null };
  });
  if (out.commissionId) {
    await syncCommission(out.commissionId, { type: 'owner', id: ownerId });
    return { attributionId: id, accrual: null };
  }
  return { attributionId: id, accrual: await accrueForTenant(out.tenantId) };
}

/**
 * تعديل بداية إسنادٍ لم تنشأ له عمولة — لدفعةٍ تمّت قبل بدايته الحالية (رابط
 * تسجيل واتساب دُفع قبل إنشاء الحساب، أو ترشيحٌ اعتُمد متأخّراً).
 */
export async function adjustAttributionWindow(id: string, input: { effectiveFrom: Date; reason: string }, ownerId: string) {
  if (input.effectiveFrom.getTime() > Date.now()) throw new LedgerError(400, 'تاريخ السريان لا يكون في المستقبل');
  const tenantId = await prisma.$transaction(async tx => {
    await lockAttribution(tx, id);
    const a = await tx.tenantAttribution.findUnique({ where: { id }, include: { commission: { select: { id: true } } } });
    if (!a) throw new LedgerError(404, 'الإسناد غير موجود');
    if (a.commission) throw new LedgerError(409, 'للإسناد عمولةٌ قائمة — لا تُعدَّل بدايته');
    if (a.status === 'void') throw new LedgerError(409, 'فعّل الإسناد أولاً');
    const t = await tx.tenant.findUnique({ where: { id: a.tenantId }, select: { createdAt: true } });
    const rules = await rulesFor(a.termsVersion, tx);
    const deadline = new Date(Math.max(
      a.firstPaymentDeadline.getTime(),
      Math.max(input.effectiveFrom.getTime(), (t?.createdAt ?? input.effectiveFrom).getTime()) + rules.firstPaymentWithinDays * DAY_MS,
    ));
    await tx.tenantAttribution.update({ where: { id }, data: { effectiveFrom: input.effectiveFrom, firstPaymentDeadline: deadline, reasonNote: input.reason, decidedBy: ownerId } });
    await logEvent(tx, { entity: 'attribution', entityId: id, action: 'window_adjusted', actorType: 'owner', actorId: ownerId, reason: input.reason, meta: { from: a.effectiveFrom.toISOString(), to: input.effectiveFrom.toISOString() } });
    return a.tenantId;
  });
  return { attributionId: id, accrual: await accrueForTenant(tenantId) };
}

/** الترشيح المعتمد الذي انقضى قفله دون أن يتحوّل ينتهي — يُحسم عند القراءة */
export async function expireStaleClaims(affiliateId?: string): Promise<void> {
  await prisma.affiliateClaim.updateMany({
    where: { status: 'approved', lockedUntil: { lt: new Date() }, ...(affiliateId ? { affiliateId } : {}) },
    data: { status: 'expired' },
  });
}

/**
 * ربط ترشيحٍ بشركة. «الأسبق يفوز»: إن كانت الشركة مُسندةً برمز تسجيلٍ لسفيرٍ
 * آخر، والترشيح معتمدٌ **قبل** تسجيلها وقفله سارٍ لحظتها، صار الإسناد متنازعاً
 * يحسمه المالك («إعادة إسناد»). وإلا فرمز التسجيل يغلب.
 *
 * يُقبل الترشيح المنتهي إن كانت الشركة سجّلت **داخل** قفله: السجلّ التجاري لا
 * يُطلب عند التسجيل، فقد يتأخّر ظهور المطابقة أسابيع بعد انتهاء القفل.
 */
export async function linkClaimToTenant(claimId: string, tenantId: string, ownerId: string) {
  const claim = await prisma.affiliateClaim.findUnique({ where: { id: claimId } });
  if (!claim) throw new LedgerError(404, 'الترشيح غير موجود');
  const t = await tenantBrief(tenantId);
  const signedUpInLock = !!claim.lockedUntil && t.createdAt.getTime() < claim.lockedUntil.getTime();
  if (!(claim.status === 'approved' || (claim.status === 'expired' && signedUpInLock))) {
    throw new LedgerError(409, claim.status === 'expired' ? 'انتهى قفل الترشيح قبل تسجيل الشركة' : 'اعتمد الترشيح قبل ربطه');
  }
  const aff = await prisma.affiliateUser.findUnique({ where: { id: claim.affiliateId }, select: { status: true, termsVersion: true } });
  if (!aff) throw new LedgerError(404, 'السفير غير موجود');
  const approvedAt = claim.reviewedAt ?? new Date();
  const rules = await rulesFor(aff.termsVersion);
  const head = await prisma.tenantAttribution.findUnique({ where: { tenantId }, select: { id: true, affiliateId: true } });

  if (head && head.affiliateId !== claim.affiliateId) {
    const claimHeldAtSignup = approvedAt.getTime() <= t.createdAt.getTime() && signedUpInLock;
    if (!claimHeldAtSignup) throw new LedgerError(409, 'الشركة مُسندة لسفيرٍ آخر، والترشيح لم يكن معتمداً سارياً عند تسجيلها');
    const conflict = await prisma.$transaction(async tx => {
      await lockAttribution(tx, head.id);
      const a = await tx.tenantAttribution.findUnique({ where: { id: head.id }, include: { commission: true } });
      if (!a) throw new LedgerError(409, 'تغيّر الإسناد — حدّث الصفحة');
      const c = a.commission ? (await lockCommission(tx, a.commission.id), await tx.affiliateCommission.findUnique({ where: { id: a.commission.id } })) : null;
      assertNotInDraft(c);
      if (a.status === 'active') {
        await tx.tenantAttribution.update({ where: { id: a.id }, data: { status: 'disputed', reasonNote: `ترشيحٌ معتمد سابق لسفيرٍ آخر (${claim.id})` } });
        await logEvent(tx, { entity: 'attribution', entityId: a.id, action: 'disputed', fromState: 'active', toState: 'disputed', actorType: 'owner', actorId: ownerId, meta: { claimId } });
      }
      let commissionHeld = false;
      if (c && (c.status === 'pending' || c.status === 'approved')) {
        await tx.affiliateCommission.update({ where: { id: c.id }, data: { status: 'on_hold', reasonNote: HOLD_DISPUTED } });
        commissionHeld = true;
      }
      await tx.affiliateClaim.update({ where: { id: claimId }, data: { tenantId } });
      await logEvent(tx, { entity: 'claim', entityId: claimId, action: 'conflict_linked', actorType: 'owner', actorId: ownerId, meta: { tenantId, attributionId: a.id } });
      return { attributionStatus: a.status === 'active' ? 'disputed' : a.status, commissionHeld, commission: c ? { id: c.id, status: commissionHeld ? 'on_hold' : c.status } : null };
    });
    return {
      attribution: { id: head.id, status: conflict.attributionStatus }, commission: conflict.commission,
      commissionCreated: false, accrualReason: null as string | null,
      conflict: { attributionStatus: conflict.attributionStatus, commissionHeld: conflict.commissionHeld },
    };
  }

  if (!head && aff.status !== 'approved') throw new LedgerError(409, 'حساب السفير ليس مقبولاً حالياً');

  const linked = await prisma.$transaction(async tx => {
    let attributionId = head?.id ?? '';
    let hasCommission = false;
    if (!head) {
      // البداية لحظة **تقديم** الترشيح لا اعتماده: دفعةٌ تمّت بين التقديم والمراجعة
      // كانت ستسقط «خارج النافذة» بلا طريق لاستعادتها
      const a = await tx.tenantAttribution.create({
        data: {
          tenantId, tenantNameSnapshot: t.name, affiliateId: claim.affiliateId, source: 'claim', claimId,
          status: 'active', flags: [], effectiveFrom: claim.submittedAt, rateBps: rules.rateBps, holdDays: rules.holdDays,
          firstPaymentDeadline: new Date(Math.max(approvedAt.getTime(), t.createdAt.getTime()) + rules.firstPaymentWithinDays * DAY_MS),
          termsVersion: aff.termsVersion, decidedBy: ownerId,
        },
      });
      attributionId = a.id;
      await logEvent(tx, { entity: 'attribution', entityId: a.id, action: 'created', toState: 'active', actorType: 'owner', actorId: ownerId, meta: { source: 'claim', claimId } });
    } else {
      // الإسناد نفسه للسفير نفسه (سجّلت الشركة برمزه): الترشيح أسبق، فتُسحب البداية إليه
      // إن لم تنشأ عمولة — وإلا خرجت دفعةٌ بين الترشيح والتسجيل من النافذة
      await lockAttribution(tx, head.id);
      const a = await tx.tenantAttribution.findUnique({ where: { id: head.id }, include: { commission: { select: { id: true } } } });
      hasCommission = !!a?.commission;
      if (a && !a.commission && claim.submittedAt.getTime() < a.effectiveFrom.getTime()) {
        await tx.tenantAttribution.update({
          where: { id: a.id },
          data: {
            effectiveFrom: claim.submittedAt,
            firstPaymentDeadline: new Date(Math.max(a.firstPaymentDeadline.getTime(), Math.max(claim.submittedAt.getTime(), t.createdAt.getTime()) + rules.firstPaymentWithinDays * DAY_MS)),
          },
        });
        await logEvent(tx, { entity: 'attribution', entityId: a.id, action: 'window_adjusted', actorType: 'owner', actorId: ownerId, meta: { via: 'claim', claimId, to: claim.submittedAt.toISOString() } });
      }
    }
    await tx.affiliateClaim.update({ where: { id: claimId }, data: { status: 'converted', tenantId, convertedAt: new Date() } });
    await logEvent(tx, { entity: 'claim', entityId: claimId, action: 'converted', fromState: claim.status, toState: 'converted', actorType: 'owner', actorId: ownerId, meta: { tenantId } });
    return { attributionId, hasCommission };
  });
  const accrual: AccrueResult | null = linked.hasCommission ? null : await accrueForTenant(tenantId);
  const a = await prisma.tenantAttribution.findUnique({ where: { id: linked.attributionId }, include: { commission: { select: { id: true, status: true } } } });
  return {
    attribution: { id: linked.attributionId, status: a?.status ?? 'active' }, commission: a?.commission ?? null,
    commissionCreated: !!accrual?.created, accrualReason: accrual && !accrual.created ? accrual.reason : null, conflict: null,
  };
}

// ───────────────────────────── الصرف ─────────────────────────────

export async function payoutCandidates() {
  const [commissions, adjustments] = await Promise.all([
    prisma.affiliateCommission.findMany({ where: { status: 'approved', payoutId: null }, select: { affiliateId: true, commissionHalalas: true } }),
    prisma.affiliateAdjustment.findMany({ where: { payoutId: null }, select: { affiliateId: true, amountHalalas: true } }),
  ]);
  const ids = [...new Set([...commissions.map(c => c.affiliateId), ...adjustments.map(a => a.affiliateId)])];
  if (!ids.length) return [];
  const [users, drafts] = await Promise.all([
    prisma.affiliateUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, code: true, email: true, ibanEnc: true, ibanLast4: true, ibanHolderName: true, status: true, termsVersion: true } }),
    prisma.affiliatePayout.findMany({ where: { affiliateId: { in: ids }, status: 'draft' }, select: { affiliateId: true } }),
  ]);
  const hasDraft = new Set(drafts.map(d => d.affiliateId));
  const rows = await Promise.all(users.map(async u => {
    const mine = commissions.filter(c => c.affiliateId === u.id);
    const rules = await rulesForCached(u.termsVersion);
    const t = payoutTotals(mine, adjustments.filter(a => a.affiliateId === u.id), rules.minPayoutHalalas);
    return {
      affiliate: { id: u.id, fullName: u.fullName, code: u.code, email: u.email },
      commissionsHalalas: t.commissionsHalalas, adjustmentsHalalas: t.adjustmentsHalalas, netHalalas: t.netHalalas,
      commissionCount: mine.length,
      // تصحيحٌ موجبٌ وحده يُصرف: رفض عمولةٍ خطأً لا علاج له غيره
      eligible: t.eligible && !!u.ibanEnc && u.status === 'approved' && !hasDraft.has(u.id),
      hasPayout: !!u.ibanEnc, ibanLast4: u.ibanLast4, holderName: u.ibanHolderName,
    };
  }));
  return rows.sort((a, b) => b.netHalalas - a.netHalalas);
}

export async function createPayout(affiliateId: string, ownerId: string) {
  const u = await prisma.affiliateUser.findUnique({ where: { id: affiliateId } });
  if (!u) throw new LedgerError(404, 'السفير غير موجود');
  if (u.status !== 'approved') throw new LedgerError(409, 'حساب السفير ليس مقبولاً حالياً');
  if (!u.ibanEnc || !u.ibanLast4 || !u.ibanHolderName) throw new LedgerError(409, 'لم يُدخل السفير بيانات الاستلام بعد');

  // مصالحةٌ قبل التجميع: عكسٌ أو استردادٌ جزئيّ فات خطافه لا يدخل دفعة
  const approved = await prisma.affiliateCommission.findMany({ where: { affiliateId, status: 'approved', payoutId: null }, select: { id: true } });
  for (const c of approved) await syncCommission(c.id, { type: 'owner', id: ownerId });
  const rules = await rulesFor(u.termsVersion);

  return prisma.$transaction(async tx => {
    // قفل البنود قبل قراءتها: استردادٌ يصل الآن ينتظر، فيرى المسودّة ويُقيَّد سالباً
    await tx.$queryRaw`SELECT id FROM affiliate_commissions WHERE "affiliateId" = ${affiliateId} AND status = 'approved' AND "payoutId" IS NULL FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM affiliate_adjustments WHERE "affiliateId" = ${affiliateId} AND "payoutId" IS NULL FOR UPDATE`;
    const draft = await tx.affiliatePayout.findFirst({ where: { affiliateId, status: 'draft' }, select: { id: true } });
    if (draft) throw new LedgerError(409, 'للسفير مسودّة دفعة قائمة — سجّلها أو ألغها أولاً');
    const commissions = await tx.affiliateCommission.findMany({ where: { affiliateId, status: 'approved', payoutId: null }, select: { id: true, commissionHalalas: true } });
    const adjustments = await tx.affiliateAdjustment.findMany({ where: { affiliateId, payoutId: null }, select: { id: true, amountHalalas: true } });
    const t = payoutTotals(commissions, adjustments, rules.minPayoutHalalas);
    if (!t.eligible) throw new LedgerError(409, `الصافي ${sar(t.netHalalas)} ريال — لا يبلغ الحدّ الأدنى للصرف`);
    const payout = await tx.affiliatePayout.create({
      data: {
        affiliateId, commissionsHalalas: t.commissionsHalalas, adjustmentsHalalas: t.adjustmentsHalalas, netHalalas: t.netHalalas,
        status: 'draft', ibanLast4: u.ibanLast4!, holderName: u.ibanHolderName!, createdBy: ownerId,
      },
    });
    if (commissions.length) await tx.affiliateCommission.updateMany({ where: { id: { in: commissions.map(x => x.id) } }, data: { payoutId: payout.id } });
    if (adjustments.length) await tx.affiliateAdjustment.updateMany({ where: { id: { in: adjustments.map(x => x.id) } }, data: { payoutId: payout.id } });
    await logEvent(tx, { entity: 'payout', entityId: payout.id, action: 'created', toState: 'draft', actorType: 'owner', actorId: ownerId, meta: { netHalalas: t.netHalalas, commissions: commissions.length, adjustments: adjustments.length } });
    return payout;
  });
}

/**
 * تسجيل التحويل — يُسجَّل **صافي المسودّة كما جُهِّز** لأنّه ما حُوِّل فعلاً. ما
 * استُردّ منذ التجهيز قُيِّد سالباً للدفعة القادمة، ولا يُرفض التسجيل بسببه:
 * الرفض بعد أن غادر المال الحساب يترك دفتراً لا يطابق البنك.
 */
export async function recordPayout(id: string, ownerId: string, bankReference: string, transferredAt: Date) {
  const updated = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM affiliate_commissions WHERE "payoutId" = ${id} FOR UPDATE`;
    const won = await tx.affiliatePayout.updateMany({ where: { id, status: 'draft' }, data: { status: 'recorded', bankReference, transferredAt, recordedBy: ownerId } });
    if (won.count !== 1) {
      const p = await tx.affiliatePayout.findUnique({ where: { id }, select: { status: true } });
      throw new LedgerError(p ? 409 : 404, p ? 'الدفعة ليست مسودّة' : 'الدفعة غير موجودة');
    }
    await tx.affiliateCommission.updateMany({ where: { payoutId: id, status: 'approved' }, data: { status: 'paid' } });
    const p = await tx.affiliatePayout.findUniqueOrThrow({ where: { id } });
    await logEvent(tx, { entity: 'payout', entityId: id, action: 'recorded', fromState: 'draft', toState: 'recorded', actorType: 'owner', actorId: ownerId, meta: { bankReference, netHalalas: p.netHalalas } });
    return p;
  });
  // استردادٌ فات خطافَه: العمولة الآن مدفوعة، فيُقيَّد سالباً
  const rows = await prisma.affiliateCommission.findMany({ where: { payoutId: id }, select: { id: true } });
  for (const r of rows) await syncCommission(r.id, { type: 'owner', id: ownerId });
  return updated;
}

/**
 * إلغاء مسودّة لم تُحوَّل. تعود عمولاتها «معتمدة»، وتُحذف قيود الاسترداد التي نشأت
 * لها أثناء المسودّة، ثمّ تُصالَح كلٌّ مع دفعتها داخل المعاملة نفسها (عكسٌ أو
 * تخفيض) — حفاظاً على الثابت: لا قيد استرداد لعمولةٍ غير ملتزَمٍ بها.
 */
export async function voidPayout(id: string, ownerId: string, reason: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM affiliate_commissions WHERE "payoutId" = ${id} FOR UPDATE`;
    const won = await tx.affiliatePayout.updateMany({ where: { id, status: 'draft' }, data: { status: 'void', voidReason: reason } });
    if (won.count !== 1) throw new LedgerError(409, 'تُلغى المسودّات فقط');
    const commissions = await tx.affiliateCommission.findMany({ where: { payoutId: id }, select: { id: true } });
    await tx.affiliateAdjustment.updateMany({ where: { payoutId: id }, data: { payoutId: null } });
    for (const c of commissions) {
      await tx.affiliateAdjustment.deleteMany({ where: { commissionId: c.id, kind: 'clawback_refund', payoutId: null } });
      await tx.affiliateCommission.update({ where: { id: c.id }, data: { payoutId: null } });
      await syncCommissionTx(tx, c.id, { type: 'owner', id: ownerId });
    }
    await logEvent(tx, { entity: 'payout', entityId: id, action: 'void', fromState: 'draft', toState: 'void', actorType: 'owner', actorId: ownerId, reason });
    return tx.affiliatePayout.findUniqueOrThrow({ where: { id } });
  });
}
