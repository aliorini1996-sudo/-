// M1 — الدالة المشتركة لعهدة المندوب (DESIGN.md §5.5 «الدالة المشتركة للعهدة»، P5/P7/P8/P27، §5.8، §5.9 C4/C4b، §10.3 D3/D9).
// صرفة بلا قاعدة ولا I/O: يستعملها المُرحِّل (مدخلات P7)، ورصيد العهدة الافتتاحي، وC4 وC4b، وبطاقة «عهدة المناديب».
//
// D3 (الخيار ب، المعتمد): الشاشة التشغيلية تبقى كما هي (السندات النشطة بكل الطرق ومنها ONLINE ناقص الاستلامات)،
// والأستاذ يتكيّف: نقد الفواتير النقدية إلى 111001 افتراضاً، وONLINE إلى 112005، وP7 بـcovered/recovered/r.
// المتطابقة (C4b): opsOutstanding = ledgerCustody + onlineUncleared + custodyExpenses + openShortage + shortagesExpensed
// وتصحّ بالبناء ما دام cashInvoiceRouting=MAIN_CASH ولا افتتاح خارج الإعادة.
// «ربط الدفاتر» L5: المختومة (OD2) تدخل الشاشة وتدخل 111003 بالختم في المربوطة، والإلغاء بردٍّ من خارج العهدة (C11)
// يُطرح من الطرف الأيمن (− cancelRefundOutside)؛ وcustodyExplain يفصّل ops − ledger بنوداً بلا باقٍ (OD3).
import { maxMilli, minMilli } from './money';
import type {
  CashInvoiceRouting, Milli, PaymentMethod, ReceiptRouting,
} from './types';

// ═══ تصنيف السند بالنسبة للعهدة (P5) — مصدر واحد للـbuilder والدالة ═══

/**
 * CUSTODY: إلى 111003 (مندوب + receiptRouting[method]=CUSTODY)
 * ONLINE:  سند إلكتروني (112005 أو 911001) — يعدّه المندوب في الشاشة التشغيلية
 * OUTSIDE: سند غير إلكتروني موجّه مباشرة (111001/112001/112004/112003)
 */
export type ReceiptCustodyClass = 'CUSTODY' | 'ONLINE' | 'OUTSIDE';

export function receiptCustodyClass(input: {
  paymentMethod: string;
  salesRepId: string | null | undefined;
  routing: ReceiptRouting | null | undefined;
}): ReceiptCustodyClass {
  if (input.paymentMethod === 'ONLINE') return 'ONLINE';
  const method = input.paymentMethod as Exclude<PaymentMethod, 'ONLINE'>;
  if (input.salesRepId && input.routing && input.routing[method] === 'CUSTODY') return 'CUSTODY';
  return 'OUTSIDE';
}

// ═══ قاعدة P7: covered ثم recovered ثم r ثم عتبة 911001 ═══

export interface SettlementSplitInput {
  /** مبلغ الاستلام */
  amountMilli: Milli;
  /** رصيد 111003 للمندوب تحت القفل (قد يكون سالباً ⇒ يُعامل صفراً) */
  custodyBalanceMilli: Milli;
  /** عجزه المفتوح على 113003 = Σ P27 − Σ المسترد (من M4؛ صفر قبلها) */
  openShortageMilli?: Milli;
  /** Σ r لاستلامات المندوب السابقة منذ بدء الشركة (بدون هذا الاستلام) */
  cumulativeNonCustodyClearedMilli?: Milli;
  /** Σ suspense لاستلامات المندوب السابقة غير المحذوفة — ما قُيد فعلاً على 911001 فلا يُقيد ثانية */
  priorSuspenseMilli?: Milli;
  /** العتبة: Σ ONLINE النشطة + Σ السندات الموجّهة خارج العهدة + Σ الفواتير النقدية خارج العهدة + Σ مصروفات العهدة */
  nonCustodyAllowanceMilli: Milli;
}

export interface SettlementSplit {
  coveredMilli: Milli;
  recoveredMilli: Milli;
  /** r = amount − covered − recovered — يُحفظ على الحدث nonCustodyClearedMilli (ويشمل suspenseMilli) */
  nonCustodyClearedMilli: Milli;
  /** الجزء من r الزائد على العتبة: مدين حساب الطريقة / دائن 911001 مع needsAttention */
  suspenseMilli: Milli;
}

export function settlementSplit(input: SettlementSplitInput): SettlementSplit {
  const amount = input.amountMilli;
  if (amount < 0n) throw new RangeError('مبلغ الاستلام سالب');
  const covered = minMilli(amount, maxMilli(0n, input.custodyBalanceMilli));
  const recovered = minMilli(amount - covered, maxMilli(0n, input.openShortageMilli ?? 0n));
  const r = amount - covered - recovered;
  // الزائد الإجمالي تراكمي (P7): max(0, Σr − العتبة)، ويُقيد منه ما لم يُقيد سابقاً فقط ⇒ لا يتغير بترتيب الأحداث
  const prev = input.cumulativeNonCustodyClearedMilli ?? 0n;
  const priorSusp = input.priorSuspenseMilli ?? 0n;
  const excessTotal = maxMilli(0n, prev + r - input.nonCustodyAllowanceMilli);
  const suspense = minMilli(r, maxMilli(0n, excessTotal - priorSusp));
  return { coveredMilli: covered, recoveredMilli: recovered, nonCustodyClearedMilli: r, suspenseMilli: suspense };
}

// ═══ custodyComponents ═══

export type CustodyInstant = Date | string | number;

/** بند زمني لمندوب: أثره عند effectAt، وعكسه (إلغاء/حذف) عند reversedAt إن وُجد */
export interface CustodyItem {
  id: string;
  salesRepId: string;
  amountMilli: Milli;
  effectAt: CustodyInstant;
  createdAt?: CustodyInstant | null;
  reversedAt?: CustodyInstant | null;
  /** «ربط الدفاتر» L5 (OD2): فاتورة نقدية مختومة cashCollectedByRep (لعناصر cashInvoices وحدها) */
  stamped?: boolean;
  /** «ربط الدفاتر» L5 (C11): عكسٌ رُدّ ماله من خارج عهدة المندوب (Receipt.cancelRefundFrom ∉ {REP_CUSTODY, null}) — للسندات CUSTODY وحدها */
  reversalOutsideCustody?: boolean;
}

/**
 * «عجز عهدة» P27. chargedTo: EMPLOYEE (مدين 113003، الافتراضي) أو EXPENSE (تحميل العجز على الشركة بحساب مصروف).
 * المُستدعي (M4) يشتقّه من GlCustodyShortage.counterAccountId: 113003 ⇒ EMPLOYEE، غيره ⇒ EXPENSE.
 */
export interface CustodyShortageItem extends CustodyItem {
  chargedTo?: 'EMPLOYEE' | 'EXPENSE';
}

/** استلام تحصيل (P7). reversedAt = حذف الاستلام (P8). القيم المخزّنة تُقرأ في C4/C4b ولا يُعاد الاشتقاق */
export interface CustodySettlementItem extends CustodyItem {
  nonCustodyClearedMilli?: Milli | null;
  shortageRecoveredMilli?: Milli | null;
}

export interface CustodyRouting {
  cashInvoice: CashInvoiceRouting;
  /** للتوثيق/التصنيف المسبق بـreceiptCustodyClass؛ القوائم تصل مصنّفة */
  receipt?: ReceiptRouting | null;
  /** «ربط الدفاتر» L5 (OD2/D5): true للمربوطة — الفاتورة النقدية المختومة تدخل 111003 أياً كان cashInvoice */
  stampDrivesCustody?: boolean;
}

/** حالة افتتاحية لكل مندوب (مجاميع ما قبل نافذة الإعادة)؛ الغائب صفر */
export interface CustodyOpening {
  ledgerCustodyMilli?: Milli;
  onlineActiveMilli?: Milli;
  outsideActiveMilli?: Milli;
  cashSalesOutsideMilli?: Milli;
  custodyExpensesMilli?: Milli;
  shortagesMilli?: Milli;
  /** Σ العجز المحمَّل على مصروف الشركة (لا يدخل 113003) */
  shortagesExpensedMilli?: Milli;
  shortageRecoveredMilli?: Milli;
  nonCustodyClearedMilli?: Milli;
  /** Σ suspense المقيد على 911001 لاستلامات ما قبل النافذة */
  suspenseMilli?: Milli;
  /** Σ السندات النشطة بكل الطرق (للشاشة التشغيلية) */
  activeReceiptsMilli?: Milli;
  settledMilli?: Milli;
  /** «ربط الدفاتر» L5 (C11): Σ السندات CUSTODY المعكوسة بردٍّ من خارج العهدة قبل النافذة */
  cancelRefundOutsideMilli?: Milli;
}

export interface CustodyComponentsInput {
  /** السندات الموجّهة للعهدة (receiptCustodyClass = CUSTODY) مع آثار إلغائها */
  receipts: readonly CustodyItem[];
  /** سندات ONLINE للمندوب */
  onlineReceipts: readonly CustodyItem[];
  /** سندات المندوب غير الإلكترونية الموجّهة إلى غير العهدة */
  outsideReceipts: readonly CustodyItem[];
  /** فواتير المندوب النقدية (amountMilli = total) */
  cashInvoices: readonly CustodyItem[];
  settlements: readonly CustodySettlementItem[];
  /** «عجز عهدة» P27 (reversedAt = إلغاؤه) */
  shortages: readonly CustodyShortageItem[];
  /** مصروفات العهدة P21 paidFrom=REP_CUSTODY */
  custodyExpenses: readonly CustodyItem[];
  routing: CustodyRouting;
  opening?: Readonly<Record<string, CustodyOpening>>;
}

export interface CustodySettlementOutcome extends SettlementSplit {
  id: string;
  amountMilli: Milli;
  /** true إن قُرئت r/recovered من القيم المخزّنة على الحدث */
  stored: boolean;
  /** حُذف لاحقاً (P8) فاستُعيدت آثاره */
  reversed: boolean;
}

export interface CustodyComponents {
  salesRepId: string;
  /** = Σ(111003) للمندوب (C4) */
  ledgerCustody: Milli;
  /** Σ ONLINE النشطة + Σ الموجّهة خارج العهدة − Σ r (قد يكون سالباً) */
  onlineUncleared: Milli;
  /** Σ الفواتير النقدية خارج العهدة (معلومة C4b: ما قد يصفّيه r من نقد 111001) */
  cashSalesOutsideCustody: Milli;
  custodyExpenses: Milli;
  /** Σ P27 المحمَّل على المندوب (113003) − Σ shortageRecovered */
  openShortage: Milli;
  /** Σ العجز المحمَّل على مصروف الشركة (لا يُسترد عبر P7) */
  shortagesExpensed: Milli;
  /** Σ r التراكمي */
  nonCustodyCleared: Milli;
  /** Σ suspense المقيد على 911001 للاستلامات غير المحذوفة */
  suspenseCleared: Milli;
  shortageRecovered: Milli;
  /** صيغة repCollection: Σ السندات النشطة بكل الطرق − Σ الاستلامات */
  opsOutstanding: Milli;
  /** مجموع العتبة الحالي لـ911001 في P7 */
  nonCustodyAllowance: Milli;
  /** «ربط الدفاتر» L5 (C11): Σ أصل السندات CUSTODY المعكوسة بردٍّ من خارج العهدة — تنقص الشاشة ولا تنقص 111003 */
  cancelRefundOutside: Milli;
  settlements: CustodySettlementOutcome[];
}

type Kind = 'CUSTODY_RECEIPT' | 'ONLINE' | 'OUTSIDE' | 'CASH_INVOICE' | 'SHORTAGE' | 'EXPENSE' | 'SETTLEMENT';

interface TimelineEvent {
  at: number;
  created: number;
  rank: number; // POST=0، الاستلام=1، العكس=2
  index: number;
  kind: Kind;
  sign: 1n | -1n;
  item: CustodyItem | CustodySettlementItem;
}

interface RepState {
  ledger: Milli;
  onlineActive: Milli;
  outsideActive: Milli;
  cashOutside: Milli;
  expenses: Milli;
  shortages: Milli;
  shortagesExpensed: Milli;
  recovered: Milli;
  rCum: Milli;
  suspenseCum: Milli;
  activeReceipts: Milli;
  settled: Milli;
  cancelRefundOutside: Milli;
  outcomes: Map<string, CustodySettlementOutcome>;
}

function instantMs(v: CustodyInstant): number {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(ms)) throw new RangeError(`لحظة غير صالحة في بيانات العهدة: ${String(v)}`);
  return ms;
}

function newState(o: CustodyOpening | undefined): RepState {
  return {
    ledger: o?.ledgerCustodyMilli ?? 0n,
    onlineActive: o?.onlineActiveMilli ?? 0n,
    outsideActive: o?.outsideActiveMilli ?? 0n,
    cashOutside: o?.cashSalesOutsideMilli ?? 0n,
    expenses: o?.custodyExpensesMilli ?? 0n,
    shortages: o?.shortagesMilli ?? 0n,
    shortagesExpensed: o?.shortagesExpensedMilli ?? 0n,
    recovered: o?.shortageRecoveredMilli ?? 0n,
    rCum: o?.nonCustodyClearedMilli ?? 0n,
    suspenseCum: o?.suspenseMilli ?? 0n,
    activeReceipts: o?.activeReceiptsMilli ?? 0n,
    settled: o?.settledMilli ?? 0n,
    cancelRefundOutside: o?.cancelRefundOutsideMilli ?? 0n,
    outcomes: new Map(),
  };
}

// العجز المحمَّل على المصروف يُعامل كمصروف العهدة: المندوب لم يعد مديناً بنقده ⇒ يدخل العتبة
const allowanceOf = (s: RepState): Milli =>
  s.onlineActive + s.outsideActive + s.cashOutside + s.expenses + s.shortagesExpensed;

/**
 * يعيد تشغيل آثار العهدة بترتيب (effectAt, createdAt) لكل مندوب بقاعدة P7 نفسها.
 * الناتج سجل بمعرّف المندوب. الاستلام بقيم مخزّنة (nonCustodyClearedMilli) لا يُعاد اشتقاقه.
 */
export function custodyComponents(input: CustodyComponentsInput): Record<string, CustodyComponents> {
  const events: TimelineEvent[] = [];
  let index = 0;
  const push = (kind: Kind, list: readonly (CustodyItem | CustodySettlementItem)[]) => {
    for (const item of list) {
      const at = instantMs(item.effectAt);
      const created = item.createdAt != null ? instantMs(item.createdAt) : at;
      events.push({ at, created, rank: kind === 'SETTLEMENT' ? 1 : 0, index: index++, kind, sign: 1n, item });
      if (item.reversedAt != null) {
        const rAt = instantMs(item.reversedAt);
        events.push({ at: rAt, created: rAt, rank: 2, index: index++, kind, sign: -1n, item });
      }
    }
  };
  push('CUSTODY_RECEIPT', input.receipts);
  push('ONLINE', input.onlineReceipts);
  push('OUTSIDE', input.outsideReceipts);
  push('CASH_INVOICE', input.cashInvoices);
  push('SHORTAGE', input.shortages);
  push('EXPENSE', input.custodyExpenses);
  push('SETTLEMENT', input.settlements);
  events.sort((a, b) => a.at - b.at || a.created - b.created || a.rank - b.rank || a.index - b.index);

  const states = new Map<string, RepState>();
  const stateOf = (repId: string): RepState => {
    let s = states.get(repId);
    if (!s) {
      s = newState(input.opening?.[repId]);
      states.set(repId, s);
    }
    return s;
  };
  for (const repId of Object.keys(input.opening ?? {})) stateOf(repId);

  const cashToCustody = input.routing.cashInvoice === 'CUSTODY';
  const stampDrivesCustody = input.routing.stampDrivesCustody === true;

  for (const ev of events) {
    const s = stateOf(ev.item.salesRepId);
    const amt = ev.item.amountMilli * ev.sign;
    switch (ev.kind) {
      case 'CUSTODY_RECEIPT':
        // C11: عكسٌ رُدّ ماله من خارج العهدة (صندوق رئيسي، بنك، عهدة مستخدم) لا يمسّ 111003 — الشاشة تنقص وحدها
        if (ev.sign === -1n && ev.item.reversalOutsideCustody === true) {
          s.activeReceipts += amt;
          s.cancelRefundOutside -= amt;
          break;
        }
        s.ledger += amt;
        s.activeReceipts += amt;
        break;
      case 'ONLINE':
        s.onlineActive += amt;
        s.activeReceipts += amt;
        break;
      case 'OUTSIDE':
        s.outsideActive += amt;
        s.activeReceipts += amt;
        break;
      case 'CASH_INVOICE':
        // OD2/D5: المختومة تعدّها الشاشة تحصيلاً (REP_COLLECTED_CASH_SALE)، فتدخل 111003 حين يوجّهها الختم (المربوطة) أو
        // التوجيه العام CUSTODY، وإلا فهي «خارج العهدة» كسندٍ موجَّه مباشرة. وغير المختومة كما كانت حرفاً.
        if (ev.item.stamped === true) {
          if (stampDrivesCustody || cashToCustody) s.ledger += amt;
          else s.outsideActive += amt;
          s.activeReceipts += amt;
          break;
        }
        if (cashToCustody) s.ledger += amt;
        else s.cashOutside += amt;
        break;
      case 'SHORTAGE':
        s.ledger -= amt;
        if ((ev.item as CustodyShortageItem).chargedTo === 'EXPENSE') s.shortagesExpensed += amt;
        else s.shortages += amt;
        break;
      case 'EXPENSE':
        s.ledger -= amt;
        s.expenses += amt;
        break;
      case 'SETTLEMENT': {
        const st = ev.item as CustodySettlementItem;
        if (ev.sign === 1n) {
          let outcome: CustodySettlementOutcome;
          if (st.nonCustodyClearedMilli != null) {
            const r = st.nonCustodyClearedMilli;
            const rec = st.shortageRecoveredMilli ?? 0n;
            const excessTotal = maxMilli(0n, s.rCum + r - allowanceOf(s));
            outcome = {
              id: st.id, amountMilli: st.amountMilli, stored: true, reversed: false,
              coveredMilli: st.amountMilli - r - rec, recoveredMilli: rec,
              nonCustodyClearedMilli: r, suspenseMilli: minMilli(r, maxMilli(0n, excessTotal - s.suspenseCum)),
            };
          } else {
            outcome = {
              id: st.id, amountMilli: st.amountMilli, stored: false, reversed: false,
              ...settlementSplit({
                amountMilli: st.amountMilli,
                custodyBalanceMilli: s.ledger,
                openShortageMilli: s.shortages - s.recovered,
                cumulativeNonCustodyClearedMilli: s.rCum,
                priorSuspenseMilli: s.suspenseCum,
                nonCustodyAllowanceMilli: allowanceOf(s),
              }),
            };
          }
          s.ledger -= outcome.coveredMilli;
          s.recovered += outcome.recoveredMilli;
          s.rCum += outcome.nonCustodyClearedMilli;
          s.suspenseCum += outcome.suspenseMilli;
          s.settled += st.amountMilli;
          s.outcomes.set(st.id, outcome);
        } else {
          // P8: عكس الاستلام يستعيد covered وrecovered وr كما حُسبت لحظة ترحيله
          const outcome = s.outcomes.get(st.id);
          if (!outcome || outcome.reversed) break;
          s.ledger += outcome.coveredMilli;
          s.recovered -= outcome.recoveredMilli;
          s.rCum -= outcome.nonCustodyClearedMilli;
          s.suspenseCum -= outcome.suspenseMilli;
          s.settled -= outcome.amountMilli;
          outcome.reversed = true;
        }
        break;
      }
    }
  }

  const out: Record<string, CustodyComponents> = {};
  for (const [repId, s] of states) {
    out[repId] = {
      salesRepId: repId,
      ledgerCustody: s.ledger,
      onlineUncleared: s.onlineActive + s.outsideActive - s.rCum,
      cashSalesOutsideCustody: s.cashOutside,
      custodyExpenses: s.expenses,
      openShortage: s.shortages - s.recovered,
      shortagesExpensed: s.shortagesExpensed,
      nonCustodyCleared: s.rCum,
      suspenseCleared: s.suspenseCum,
      shortageRecovered: s.recovered,
      opsOutstanding: s.activeReceipts - s.settled,
      nonCustodyAllowance: allowanceOf(s),
      cancelRefundOutside: s.cancelRefundOutside,
      settlements: [...s.outcomes.values()],
    };
  }
  return out;
}

/** مكوّنات مندوب واحد (صفرية إن لم يكن له أثر) */
export function custodyComponentsForRep(input: CustodyComponentsInput, salesRepId: string): CustodyComponents {
  const all = custodyComponents(input);
  return all[salesRepId] ?? {
    salesRepId, ledgerCustody: 0n, onlineUncleared: 0n, cashSalesOutsideCustody: 0n, custodyExpenses: 0n,
    openShortage: 0n, shortagesExpensed: 0n, nonCustodyCleared: 0n, suspenseCleared: 0n, shortageRecovered: 0n,
    opsOutstanding: 0n,
    nonCustodyAllowance: 0n, cancelRefundOutside: 0n, settlements: [],
  };
}

/** مدخلات builder P7 من المكوّنات الحالية للمندوب (قبل الاستلام الجديد) */
export function settlementInputsFrom(c: CustodyComponents): {
  custodyBalanceMilli: Milli; openShortageMilli: Milli;
  cumulativeNonCustodyClearedMilli: Milli; priorSuspenseMilli: Milli; nonCustodyAllowanceMilli: Milli;
} {
  return {
    custodyBalanceMilli: c.ledgerCustody,
    openShortageMilli: c.openShortage,
    cumulativeNonCustodyClearedMilli: c.nonCustodyCleared,
    priorSuspenseMilli: c.suspenseCleared,
    nonCustodyAllowanceMilli: c.nonCustodyAllowance,
  };
}

/** C4: رصيد 111003 في الأستاذ − ledgerCustody (صفر = أخضر) */
export function custodyC4Gap(ledgerBalanceMilli: Milli, c: Pick<CustodyComponents, 'ledgerCustody'>): Milli {
  return ledgerBalanceMilli - c.ledgerCustody;
}

/**
 * C4b: opsOutstanding − (ledgerCustody + onlineUncleared + custodyExpenses + openShortage + shortagesExpensed − cancelRefundOutside)
 * (صفر = متطابق). cancelRefundOutside (C11) يغيب عن المكوّنات القديمة ⇒ صفر، فالصيغة القائمة حرفاً.
 */
export function custodyC4bGap(
  c: Pick<CustodyComponents,
    'opsOutstanding' | 'ledgerCustody' | 'onlineUncleared' | 'custodyExpenses' | 'openShortage' | 'shortagesExpensed'>
    & Partial<Pick<CustodyComponents, 'cancelRefundOutside'>>,
  opsOutstandingMilli: Milli = c.opsOutstanding,
): Milli {
  return opsOutstandingMilli
    - (c.ledgerCustody + c.onlineUncleared + c.custodyExpenses + c.openShortage + c.shortagesExpensed - (c.cancelRefundOutside ?? 0n));
}

// ═══ «ربط الدفاتر» L5 — تفسير فرق العهدة بنداً بنداً (OD3) ═══

/**
 * أنواع بنود التفسير. كل بند أثرُه الموقَّع على (الشاشة − 111003):
 * OPENING (فرق الافتتاح)، ONLINE وOUTSIDE (سندات تعدّها الشاشة ولا تدخل العهدة)، STAMPED_OUTSIDE (فاتورة نقدية مختومة
 * قُيّد نقدها خارج العهدة)، EXPENSE وSHORTAGE وSHORTAGE_EXPENSED (تنقص 111003 ولا تنقص الشاشة؛ والمسترد من العجز
 * بند SHORTAGE سالب على الاستلام)، SETTLEMENT_R (ما صفّاه الاستلام خارج العهدة: سالب)، CANCEL_REFUND_OUTSIDE (إلغاء
 * رُدّ ماله من خارج العهدة: سالب)، CASH_INVOICE_CUSTODY (فاتورة نقدية غير مختومة في العهدة بالتوجيه العام لا تعدّها
 * الشاشة: سالب).
 */
export type CustodyExplainKind =
  | 'OPENING' | 'ONLINE' | 'OUTSIDE' | 'STAMPED_OUTSIDE' | 'EXPENSE' | 'SHORTAGE' | 'SHORTAGE_EXPENSED' | 'SETTLEMENT_R'
  | 'CANCEL_REFUND_OUTSIDE' | 'CASH_INVOICE_CUSTODY';

/** OD3: بند من قائمة r المفصّلة — ops − ledger بنداً بنداً بلا باقٍ غير مفسَّر */
export interface CustodyExplainItem {
  kind: CustodyExplainKind;
  refId: string;
  /** ISO للحظة الأثر (لحظة العكس لـCANCEL_REFUND_OUTSIDE)؛ فارغ لبند الافتتاح */
  at: string;
  /** موقَّع: موجب يرفع الشاشة على الأستاذ */
  amountMilli: Milli;
}

export interface CustodyExplanation {
  opsMilli: Milli;
  ledgerMilli: Milli;
  items: CustodyExplainItem[];
  totalMilli: Milli;
  /** = ops − ledger − total — صفر دائماً حين تتسق المدخلات */
  unexplainedMilli: Milli;
}

const isoOf = (v: CustodyInstant): string => new Date(instantMs(v)).toISOString();

/**
 * يفسّر فرق الشاشة التشغيلية (opsOutstanding) عن 111003 لمندوب واحد بنوداً موقَّعة. البنود تُشتق من القوائم مباشرةً
 * (لا من المكوّنات)، والفرق يُحسب من custodyComponents — فـunexplainedMilli = 0 شاهدٌ على اتساق المسارين لا تحصيل حاصل.
 * البند المعكوس كلّه (أثره الصافي صفر) لا يُدرج.
 */
export function custodyExplain(input: CustodyComponentsInput, salesRepId: string): CustodyExplanation {
  const c = custodyComponentsForRep(input, salesRepId);
  const items: CustodyExplainItem[] = [];
  const add = (kind: CustodyExplainKind, refId: string, at: string, amountMilli: Milli) => {
    if (amountMilli !== 0n) items.push({ kind, refId, at, amountMilli });
  };
  const mine = <T extends CustodyItem>(list: readonly T[]): T[] => list.filter((i) => i.salesRepId === salesRepId);
  const live = (i: CustodyItem) => i.reversedAt == null;

  const o = input.opening?.[salesRepId];
  if (o) {
    add('OPENING', salesRepId, '',
      (o.activeReceiptsMilli ?? 0n) - (o.settledMilli ?? 0n) - (o.ledgerCustodyMilli ?? 0n));
  }
  for (const r of mine(input.receipts)) {
    if (!live(r) && r.reversalOutsideCustody === true) add('CANCEL_REFUND_OUTSIDE', r.id, isoOf(r.reversedAt!), -r.amountMilli);
  }
  for (const r of mine(input.onlineReceipts)) if (live(r)) add('ONLINE', r.id, isoOf(r.effectAt), r.amountMilli);
  for (const r of mine(input.outsideReceipts)) if (live(r)) add('OUTSIDE', r.id, isoOf(r.effectAt), r.amountMilli);
  const cashToCustody = input.routing.cashInvoice === 'CUSTODY';
  const stampDrives = input.routing.stampDrivesCustody === true;
  for (const inv of mine(input.cashInvoices)) {
    if (!live(inv)) continue;
    if (inv.stamped === true) {
      if (!(stampDrives || cashToCustody)) add('STAMPED_OUTSIDE', inv.id, isoOf(inv.effectAt), inv.amountMilli);
    } else if (cashToCustody) {
      add('CASH_INVOICE_CUSTODY', inv.id, isoOf(inv.effectAt), -inv.amountMilli);
    }
  }
  for (const sh of mine(input.shortages)) {
    if (live(sh)) add(sh.chargedTo === 'EXPENSE' ? 'SHORTAGE_EXPENSED' : 'SHORTAGE', sh.id, isoOf(sh.effectAt), sh.amountMilli);
  }
  for (const e of mine(input.custodyExpenses)) if (live(e)) add('EXPENSE', e.id, isoOf(e.effectAt), e.amountMilli);
  const settledAt = new Map(mine(input.settlements).map((s) => [s.id, s.effectAt] as const));
  for (const out of c.settlements) {
    if (out.reversed) continue;
    const at = settledAt.get(out.id);
    const iso = at != null ? isoOf(at) : '';
    add('SHORTAGE', out.id, iso, -out.recoveredMilli);
    add('SETTLEMENT_R', out.id, iso, -out.nonCustodyClearedMilli);
  }

  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
    || (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0));
  const total = items.reduce((s, i) => s + i.amountMilli, 0n);
  return {
    opsMilli: c.opsOutstanding,
    ledgerMilli: c.ledgerCustody,
    items,
    totalMilli: total,
    unexplainedMilli: c.opsOutstanding - c.ledgerCustody - total,
  };
}
