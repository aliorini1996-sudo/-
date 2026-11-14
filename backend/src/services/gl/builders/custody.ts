// M1 — وصفتا استلام تحصيل المندوب وحذفه (DESIGN.md §5.5 P7 وP8، P27 الاسترداد، §5.3، §5.8، §10.3 D3).
// دوال صرفة: حمولة الحدث + مدخلات العهدة المحسوبة تحت القفل + BuildContext ⇒ MoveDraft أو NO_MOVE.
//
// P7 (دفتر CUST، moveType=CUSTODY_SETTLEMENT):
//    مدين حساب الطريقة = covered + recovered + suspense
//    دائن 111003 = covered (المندوب)
//    دائن 113003 = recovered (عجز العهدة المسترد، المندوب)
//    دائن 911001 = suspense (زيادة r على العتبة) مع needsAttention
//    r = amount − covered − recovered بلا مدين نقد أو بنك (يُحفظ على الحدث nonCustodyClearedMilli)
// P8 حذف استلام واحد: عكس سطور القيد الأصلي الحيّ (والحدث يستعيد r بحذف قيمه من التراكمي).
import { localDate } from '../dates';
import { toMilli } from '../money';
import { settlementSplit, type SettlementSplit } from '../custody';
import { linkedMethodAccount, methodAccountKey, methodLabel } from './receipt';
import { USER_CUSTODY_CODE } from '../coa/linkedAccounts';
import { isCashLikeMethod } from '../../userCustodyCore';
import {
  JOURNAL_CODE_BY_SYSTEM_KEY, noMove,
  type BuildContext, type BuildResult, type LineDraft, type LocalDate, type Milli, type MoveDraft,
} from '../types';

type Amount = string | number;

/** رمز حساب سُلف وذمم الموظفين (بلا مفتاح ربط في §4.5) */
export const EMPLOYEE_ADVANCES_CODE = '113003';

/** مفتاح حدث الاستلام (§5.2، §5.3): SETTLEMENT:<id>:POST | SETTLEMENT:<id>:REVERSE */
export const settlementKey = (settlementId: string, event: 'POST' | 'REVERSE'): string =>
  `SETTLEMENT:${settlementId}:${event}`;

/** حمولة SETTLEMENT (§5.2): {amount, method, salesRepId, settledAt, createdAt} */
export interface SettlementPayload {
  amount: Amount;
  method: string;
  salesRepId: string;
  settledAt: Date | string;
  createdAt?: Date | string | null;
  note?: string | null;
  /** «ربط الدفاتر» L5 (C12): مستخدم الشركة الذي استلم (RepSettlement.receivedByUserId) — يُكتب للمربوطة وحدها وحين يحمل قيمة */
  receivedByUserId?: string | null;
  /** لقطة اسم المستلِم (G6 (ز)) */
  receivedByName?: string | null;
}

export interface SettlementPostInput {
  settlementId: string;
  payload: SettlementPayload;
  /** لقطة اسم المندوب (G6 (ز)) */
  salesRepName?: string | null;
  /** الافتراضي: localDate(settledAt, timezone) */
  date?: LocalDate;
  /** رصيد 111003 للمندوب تحت القفل */
  custodyBalanceMilli: Milli;
  /** العجز المفتوح على 113003 (من M4؛ صفر قبلها) */
  openShortageMilli?: Milli;
  /** Σ r السابقة منذ بدء الشركة (custodyComponents) */
  cumulativeNonCustodyClearedMilli: Milli;
  /** Σ suspense السابقة غير المحذوفة (custodyComponents.suspenseCleared) */
  priorSuspenseMilli?: Milli;
  /** مجموع العتبة (custodyComponents.nonCustodyAllowance) */
  nonCustodyAllowanceMilli: Milli;
  /**
   * «ربط الدفاتر» L5 (P7 نقداً أو شيكاً إلى عهدة مستخدم): ما قيّدته عمليات المندوب **في حساب طريقة الاستلام نفسه** خارج
   * عهدته ولم تنقله استلامات سابقة — نقد فواتير نقدية غير مختومة وسندات نقدية موجّهة مباشرة (للنقد)، أو شيكات موجّهة مباشرة
   * (للشيك). هو وحده ما يُنقل من حساب الطريقة إلى 111004؛ وما بقي من r المبرَّر (إلكتروني وتحويل وبطاقة ونقطة بيع لم تدخل
   * يد المستخدم نقداً) يُقيَّد معلّقاً 911001 مع needsAttention بدل دائنٍ صامت لحساب لم يدخله المال قط. الغائب = صفر.
   */
  methodReclassAllowanceMilli?: Milli | null;
}

export interface SettlementBuild {
  result: BuildResult;
  /** ما يحفظه المُرحِّل على الحدث: nonCustodyClearedMilli = split.nonCustodyClearedMilli، shortageRecoveredMilli = split.recoveredMilli */
  split: SettlementSplit;
}

/** سطر من القيد الأصلي الحيّ لـP7 */
export type SettlementOriginalLine = Pick<
  LineDraft,
  'accountId' | 'accountCode' | 'accountKey' | 'label' | 'debitMilli' | 'creditMilli' | 'salesRepId' | 'partnerName'
  | 'analyticAccountId'
  | 'adminUserId'
>;

export interface SettlementReverseInput {
  settlementId: string;
  payload: SettlementPayload;
  salesRepName?: string | null;
  /** تاريخ العكس (المُرحِّل: autoReversalDate) */
  date: LocalDate;
  /** سطور قيد P7 الحيّ؛ null ⇒ لم يُرحَّل قيد (NETTED أو لم يتحقق) */
  originalLines: readonly SettlementOriginalLine[] | null;
  /** قيم الحدث الأصلي المخزّنة — تُعاد كما هي لإعلام المُرحِّل بما يُستعاد */
  nonCustodyClearedMilli?: Milli | null;
  shortageRecoveredMilli?: Milli | null;
}

export interface SettlementReverseBuild {
  result: BuildResult;
  /** ما يُطرح من التراكمي باستعادة الاستلام (P8 يستعيد r) */
  restoredNonCustodyClearedMilli: Milli;
  restoredShortageRecoveredMilli: Milli;
}

const repName = (n: string | null | undefined): string => (n && n.trim() ? n.trim() : 'مندوب');

function custJournalCode(ctx: BuildContext): string {
  return ctx.journals.bySystemKey('CUSTODY')?.code ?? JOURNAL_CODE_BY_SYSTEM_KEY.CUSTODY;
}

function baseMove(
  ctx: BuildContext, settlementId: string, event: 'POST' | 'REVERSE', date: LocalDate, salesRepId: string,
  narration: string,
): Omit<MoveDraft, 'lines' | 'needsAttention' | 'attentionReason'> {
  return {
    kind: 'MOVE',
    journalCode: custJournalCode(ctx),
    journalSystemKey: 'CUSTODY',
    moveType: 'CUSTODY_SETTLEMENT',
    origin: 'AUTO',
    date,
    ref: null,
    narration,
    salesRepId,
    sourceType: 'SETTLEMENT',
    sourceId: settlementId,
    sourceKey: settlementKey(settlementId, event),
    sourceEvent: event,
    currencyCode: ctx.settings.currency,
    currencyDecimals: ctx.settings.currencyDecimals,
  };
}

/** P7 — قيد استلام التحصيل من المندوب */
export function buildSettlementMove(input: SettlementPostInput, ctx: BuildContext): SettlementBuild {
  const { payload } = input;
  const amount = toMilli(payload.amount, ctx.settings.currencyDecimals);
  if (amount < 0n) throw new RangeError(`استلام بمبلغ سالب غير متوقع (${String(payload.amount)})`);
  const split = settlementSplit({
    amountMilli: amount,
    custodyBalanceMilli: input.custodyBalanceMilli,
    openShortageMilli: input.openShortageMilli ?? 0n,
    cumulativeNonCustodyClearedMilli: input.cumulativeNonCustodyClearedMilli,
    priorSuspenseMilli: input.priorSuspenseMilli ?? 0n,
    nonCustodyAllowanceMilli: input.nonCustodyAllowanceMilli,
  });
  if (amount === 0n) return { result: noMove('ZERO_VALUE', 'استلام بمبلغ صفري'), split };
  // «ربط الدفاتر» L5 (§5.4): المربوطة وحدها — وغيرها يكمل أدناه حرفياً كما كان
  if (ctx.settings.linkedPosting === true) return { result: buildLinkedSettlementMove(input, split, ctx), split };

  const debit = split.coveredMilli + split.recoveredMilli + split.suspenseMilli;
  if (debit === 0n) {
    // كل المبلغ r ضمن العتبة: لا مدين نقد أو بنك ولا قيد؛ الحدث يحفظ r وحده
    return { result: noMove('NETTED', 'الاستلام صفّى جزءاً غير مقيد في العهدة بالكامل (r ضمن العتبة)'), split };
  }

  // طريقة غير معروفة تُعامل نقداً كما في مسار الاستلام القائم (salesReps.ts)
  const method = methodAccountKey(payload.method) ? payload.method : 'CASH';
  const methodKey = methodAccountKey(method)!;
  const name = repName(input.salesRepName);
  const rep = { salesRepId: payload.salesRepId, partnerName: name };
  const date = input.date ?? localDate(payload.settledAt, ctx.settings.timezone);

  const lines: LineDraft[] = [
    {
      accountKey: methodKey, label: `استلام تحصيل ${methodLabel(method)} من المندوب ${name}`,
      debitMilli: debit, creditMilli: 0n, ...rep,
    },
  ];
  if (split.coveredMilli > 0n) {
    lines.push({
      accountKey: 'REP_CUSTODY', label: `تصفية عهدة المندوب ${name}`,
      debitMilli: 0n, creditMilli: split.coveredMilli, ...rep,
    });
  }
  if (split.recoveredMilli > 0n) {
    lines.push({
      accountCode: EMPLOYEE_ADVANCES_CODE, label: `استرداد عجز عهدة المندوب ${name}`,
      debitMilli: 0n, creditMilli: split.recoveredMilli, ...rep,
    });
  }
  let needsAttention = false;
  let attentionReason: string | null = null;
  if (split.suspenseMilli > 0n) {
    needsAttention = true;
    attentionReason = 'استلام يتجاوز عهدة المندوب وما يبرره (إلكتروني وخارج العهدة ونقد فواتير ومصروفات) — الزائد معلّق';
    lines.push({
      accountKey: 'POSTING_SUSPENSE', label: `زيادة استلام على عهدة المندوب ${name} — معلّق`,
      debitMilli: 0n, creditMilli: split.suspenseMilli, ...rep,
    });
  }

  const move: MoveDraft = {
    ...baseMove(ctx, input.settlementId, 'POST', date, payload.salesRepId,
      `استلام تحصيل (${methodLabel(method)}) من المندوب ${name}${payload.note ? ` — ${payload.note}` : ''}`),
    needsAttention,
    attentionReason,
    lines,
  };
  return { result: move, split };
}

/** P8 — عكس استلام واحد محذوف من سطور قيده الأصلي */
export function buildSettlementReversalMove(input: SettlementReverseInput, ctx: BuildContext): SettlementReverseBuild {
  const restored = {
    restoredNonCustodyClearedMilli: input.nonCustodyClearedMilli ?? 0n,
    restoredShortageRecoveredMilli: input.shortageRecoveredMilli ?? 0n,
  };
  const lines = input.originalLines ?? [];
  if (lines.length === 0) {
    return { result: noMove('NETTED', 'لا قيد أصلي لاستلام صُفّي كله بلا أثر في الأستاذ'), ...restored };
  }
  const name = repName(input.salesRepName);
  const move: MoveDraft = {
    ...baseMove(ctx, input.settlementId, 'REVERSE', input.date, input.payload.salesRepId,
      `حذف استلام تحصيل من المندوب ${name}`),
    needsAttention: false,
    attentionReason: null,
    lines: lines.map((l) => ({ ...l, label: `عكس: ${l.label}`, debitMilli: l.creditMilli, creditMilli: l.debitMilli })),
  };
  return { result: move, ...restored };
}

// ═══ «ربط الدفاتر» L5 — P7 في الدفاتر المربوطة (§5.4، الفجوة C12، قرارا المالك OD5 وOD14) ═══

/**
 * P7 للمربوطة: التقسيم (covered ثم recovered ثم r ثم المعلّق) هو نفسه حرفاً، ويتغيّر الطرف المدين وحده:
 *  - مستلِمٌ من مستخدمي الشركة ونقدٌ أو شيك ⇒ مدين 111004 بالمستخدم (adminUserId) **بلا salesRepId** (ثابت D2).
 *  - طريقة غير نقدية (ولو بمستلِم) ⇒ حساب الطريقة المربوط (111101 أو 112004 أو المخصّص) — أبداً لا 111004 (OD5).
 *  - بلا مستلِم ⇒ حساب الطريقة المربوط، والنقد إلى 111001.
 *
 * ولماذا يدخل الاستلامُ النقديُّ عهدةَ المستخدم بمبلغه كاملاً (لا covered + recovered + المعلّق وحدها)؟ لأن r في
 * استلامٍ نقديٍّ مالٌ في يد المستخدم فعلاً قيّده الأستاذ سلفاً خارج عهدة المندوب (فاتورة نقدية غير مختومة، أو سند نقدي
 * موجَّه مباشرة) — والمستخدم سيورّده كاملاً. فلو بقي r بلا سطر لصارت 111004 سالبة بمقداره عند التوريد ولتضاعف النقد
 * في 111001، ولانحرفت 111004 عن عهدة الشاشة (C4u وR4). فيُنقل من حساب الطريقة إلى عهدة المستخدم ما قيّدته عمليات المندوب
 * فيه فعلاً (methodReclassAllowanceMilli)، وما عداه من r المبرَّر — إلكتروني وتحويل وبطاقة ونقطة بيع لم تدخل حساب الطريقة —
 * معلّقٌ 911001 مع needsAttention لا دائنٌ صامت يجعل الصندوق سالباً (linkedSettlementReclass). وقيم الحدث المخزّنة (r
 * والمسترد) لا تتغيّر فلا يتغيّر C4 ولا C4b للمندوب.
 */
function buildLinkedSettlementMove(input: SettlementPostInput, split: SettlementSplit, ctx: BuildContext): BuildResult {
  const { payload } = input;
  const name = repName(input.salesRepName);
  const rep = { salesRepId: payload.salesRepId, partnerName: name };
  const date = input.date ?? localDate(payload.settledAt, ctx.settings.timezone);
  // طريقة غير معروفة تُعامل نقداً كما في P7 القائم
  const known = linkedMethodAccount({ method: payload.method }, ctx);
  const method = known ? payload.method : 'CASH';
  const methodTarget = known ?? linkedMethodAccount({ method: 'CASH' }, ctx);
  if (!methodTarget) throw new RangeError('تعذّر تحديد حساب الصندوق لاستلام التحصيل');

  const toUser = !!payload.receivedByUserId && isCashLikeMethod(payload.method);
  const userLabel = (payload.receivedByName && payload.receivedByName.trim()) ? payload.receivedByName.trim() : 'مستخدم';
  // r المبرَّر (r − المعلّق) يدخل عهدة المستخدم في الاستلام النقدي، ولا سطر له في غيره كما كان. ومصدره نوعان: ما قُيّد في
  // حساب الطريقة نفسه (يُنقل منه) وما عداه (معلّق 911001 للمراجعة) — linkedSettlementReclass
  const { reclass, unbacked } = linkedSettlementReclass(input, split, toUser);
  const debit = split.coveredMilli + split.recoveredMilli + split.suspenseMilli + reclass + unbacked;
  if (debit === 0n) {
    return noMove('NETTED', 'الاستلام صفّى جزءاً غير مقيد في العهدة بالكامل (r ضمن العتبة)');
  }

  const lines: LineDraft[] = [
    toUser
      ? {
        accountCode: USER_CUSTODY_CODE, label: `استلام تحصيل ${methodLabel(method)} من المندوب ${name} في عهدة المستخدم ${userLabel}`,
        debitMilli: debit, creditMilli: 0n, adminUserId: payload.receivedByUserId, partnerName: userLabel,
      }
      : {
        ...methodTarget, label: `استلام تحصيل ${methodLabel(method)} من المندوب ${name}`,
        debitMilli: debit, creditMilli: 0n, ...rep,
      },
  ];
  if (split.coveredMilli > 0n) {
    lines.push({
      accountKey: 'REP_CUSTODY', label: `تصفية عهدة المندوب ${name}`,
      debitMilli: 0n, creditMilli: split.coveredMilli, ...rep,
    });
  }
  if (split.recoveredMilli > 0n) {
    lines.push({
      accountCode: EMPLOYEE_ADVANCES_CODE, label: `استرداد عجز عهدة المندوب ${name}`,
      debitMilli: 0n, creditMilli: split.recoveredMilli, ...rep,
    });
  }
  let needsAttention = false;
  let attentionReason: string | null = null;
  if (split.suspenseMilli > 0n) {
    needsAttention = true;
    attentionReason = 'استلام يتجاوز عهدة المندوب وما يبرره (إلكتروني وخارج العهدة ونقد فواتير ومصروفات) — الزائد معلّق';
    lines.push({
      accountKey: 'POSTING_SUSPENSE', label: `زيادة استلام على عهدة المندوب ${name} — معلّق`,
      debitMilli: 0n, creditMilli: split.suspenseMilli, ...rep,
    });
  }
  if (reclass > 0n) {
    lines.push({
      ...methodTarget, label: `نقل ${methodLabel(method)} مقيد خارج عهدة المندوب ${name} إلى عهدة المستخدم ${userLabel}`,
      debitMilli: 0n, creditMilli: reclass, ...rep,
    });
  }
  if (unbacked > 0n) {
    needsAttention = true;
    attentionReason = attentionReason ? `${attentionReason}؛ ${UNBACKED_RECLASS_REASON}` : UNBACKED_RECLASS_REASON;
    lines.push({
      accountKey: 'POSTING_SUSPENSE',
      label: `تحصيلات خارج عهدة المندوب ${name} لم تُقيَّد في حساب الاستلام (${methodLabel(method)}) واستلمها المستخدم ${userLabel} — معلّق`,
      debitMilli: 0n, creditMilli: unbacked, ...rep,
    });
  }

  return {
    ...baseMove(ctx, input.settlementId, 'POST', date, payload.salesRepId,
      `استلام تحصيل (${methodLabel(method)}) من المندوب ${name}${toUser ? ` إلى عهدة المستخدم ${userLabel}` : ''}${payload.note ? ` — ${payload.note}` : ''}`),
    needsAttention,
    attentionReason,
    lines,
  };
}

/** سبب التنبيه لجزء r المبرَّر غير المسنود بمالٍ في حساب الطريقة (P7 إلى مستخدم في المربوطة) */
export const UNBACKED_RECLASS_REASON =
  'استلام نقدي إلى عهدة مستخدم يشمل تحصيلات خارج عهدة المندوب لم تُقيَّد في حساب الطريقة (إلكتروني أو تحويل أو بطاقة أو نقطة بيع) — الفرق معلّق للمراجعة';

/**
 * تقسيم r المبرَّر في P7 إلى عهدة مستخدم (المربوطة): r − المعلّق مالٌ دخل عهدة المستخدم (طيّ OD5 يعدّ الاستلام النقدي كله
 * نقداً بيده)، لكن العتبة التي تبرّره خليط: نقدٌ قُيّد في حساب الطريقة نفسه (فاتورة نقدية غير مختومة، سند نقدي موجّه مباشرة)
 * فيُنقل منه، وإلكتروني وتحويل وبطاقة ونقطة بيع قُيّدت في 112005/111101/112007/112004 ولم تدخل حساب الطريقة قط — ودائنه
 * منه كان يُسلب الصندوق 111001 (أو 112003 فيُرفض تحصيل الشيك) مالاً لم يدخله ويُثبت للمستخدم نقداً وهمياً. فيُنقل
 * min(المبرَّر، methodReclassAllowanceMilli) ويُعلَّق الباقي على 911001 مع needsAttention. الحل الجذري (استبعاد ذلك الجزء من
 * «المستلَم النقدي» في طيّ D6) قرار تصميم مؤجّل. ليس إلى مستخدم ⇒ صفران (لا سطر لـr كما كان).
 */
export function linkedSettlementReclass(
  input: Pick<SettlementPostInput, 'methodReclassAllowanceMilli'>, split: SettlementSplit, toUser: boolean,
): { reclass: Milli; unbacked: Milli } {
  if (!toUser) return { reclass: 0n, unbacked: 0n };
  const justified = split.nonCustodyClearedMilli - split.suspenseMilli;
  if (justified <= 0n) return { reclass: 0n, unbacked: 0n };
  const allowance = input.methodReclassAllowanceMilli ?? 0n;
  const reclass = allowance <= 0n ? 0n : allowance < justified ? allowance : justified;
  return { reclass, unbacked: justified - reclass };
}

/**
 * مدخلات إعادة بناء P7 مرحَّل حرفياً (إعادة الترحيل من المصدر) في المربوطة، من سطور القيد الحيّ لا من Σ مدينه: P7 إلى
 * مستخدم يُدين 111004 بالمبلغ كاملاً (سطر النقل وr غير المسنود داخله)، فاشتقاق المعلّق من «Σ المدين − covered − recovered»
 * يعطي r كلّه فيُنقل r من حساب الطريقة إلى 911001. المعلّق كما رُحّل = Σ دائن 911001 (الزيادة على العتبة + غير المسنود)،
 * والباقي من r نُقل من حساب الطريقة فيُسمح بنقله كما كان.
 * يعيد postedDebitMilli لـsettlementRebuildInputs (covered + recovered + المعلّق) وسقف النقل.
 */
export function linkedSettlementRebuildFromLines(
  outcome: { amountMilli: Milli; nonCustodyClearedMilli: Milli; recoveredMilli: Milli },
  lines: readonly { accountId: string; debitMilli: Milli; creditMilli: Milli }[],
  ctx: BuildContext,
): { postedDebitMilli: Milli; methodReclassAllowanceMilli: Milli } {
  const r = outcome.nonCustodyClearedMilli;
  const suspenseId = ctx.accounts.byKey('POSTING_SUSPENSE')?.id ?? null;
  let posted = 0n;
  for (const l of lines) if (suspenseId !== null && l.accountId === suspenseId) posted += l.creditMilli - l.debitMilli;
  const suspense = posted < 0n ? 0n : posted > r ? r : posted;
  return { postedDebitMilli: outcome.amountMilli - r + suspense, methodReclassAllowanceMilli: r - suspense };
}
