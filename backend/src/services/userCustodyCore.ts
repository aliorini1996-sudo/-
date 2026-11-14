/**
 * عهدة تحصيلات مستخدم الشركة — الدالة الصرفة الوحيدة («ربط الدفاتر» L5، العقد §3.4، القرار D6 وقرار المالك OD5).
 *
 * لماذا ملف صرف خارج services/gl؟ لأن ثلاثة مستهلكين يجب أن يقرؤوا التعريف نفسه حرفاً: شاشة مستخدمي الشركة
 * (services/userCustody.ts — مسارات تشغيلية لا تستورد services/gl)، وبنّاء قيد التوريد في الدفاتر المربوطة
 * (userDeliverySplitBefore)، والفحص C4u (111004 لكل مستخدم = outstanding). نسختان من الطيّ تعنيان انحرافاً صامتاً في المال.
 *
 * التعريف (OD5): العهدة نقدٌ وشيكات وحدها.
 *  - المستلَم من المناديب بطريقة CASH|CHEQUE يدخل العهدة. وBANK_TRANSFER|POS لا يدخلها: المال في البنك أصلاً (P7 يرحّله
 *    إلى حساب الطريقة لا إلى 111004)، فيدخل «وعاءً غير نقدي» للعرض والتمرير وحده.
 *  - التوريد بطريقة غير نقدية يصفّي الوعاء أولاً «مروراً» (pass-through: لا قيد، فالمال لم يمرّ بيد المستخدم)، والزائد
 *    عن الوعاء يُنقص العهدة النقدية (نقدٌ أودعه المستخدم في البنك). والتوريد النقدي (CASH|CHEQUE) من العهدة النقدية أولاً،
 *    وما زاد عنها لحظتَه يمرّ من الوعاء (التاريخ القديم — انظر أدناه).
 *  - استرداد إلغاء سندٍ من عهدة المستخدم (Receipt.cancelRefundFrom = USER_CUSTODY) يُنقص العهدة.
 * وهذا التعريف يحفظ التاريخ القديم بلا أرصدة سالبة: من استلم تحويلاً قديماً وورّده تحويلاً يمرّ بلا أثر على نقده.
 * ولماذا يمرّ زائد التوريد النقدي من الوعاء: سقف التوريد قبل OD5 كان «المستلَم كله − المورَّد كله» بلا نظرٍ إلى الطريقة، وحوار
 * الاستلام طريقته الافتراضية CASH — فتاريخٌ حقيقيّ فيه «استلم 1000 تحويلاً ثم ورّدها نقداً». لو بقي النقدي pass=0 لصارت عهدته
 * −1000 دائمة: لا يورِّد نقداً بعدها ولا يُحذف استلامه ولا حسابه (مراجعة ١٤ نوفمبر). بالمرور لا سالب ما دام كل توريدٍ قديم ضمن
 * سقفه القديم (العهدة + الوعاء = المستلَم − المورَّد قبل OD5 بالضبط). والجديد لا يبلغ هذا الفرع: سقف النقدي العهدةُ وحدها
 * (userHandoverCapMilli)، فلا يمرّ إلا ما تجاوز العهدة بهامش الكسور.
 *  - outsideCustody (منظور الدفاتر وحده): استلامٌ لم يدخل 111004 قطّ — استلام مندوبٍ محذوف لا يرحّله المُطابِق (SETTLEMENT_HAS_REP)
 *    لأن سنداته OUTSIDE في 111001 أصلاً. يدخل الوعاء لا العهدة، فتوريد ماله يمرّ بلا قيدٍ ثانٍ على 111001 ولا سالبٍ على 111004.
 *
 * المبالغ ملّي BigInt (المُستدعي يقرّب كل مستند نصف-لأعلى قبل التمرير). لا قاعدة ولا I/O ولا استيراد.
 */

/** طرق العهدة النقدية (OD5) */
export const USER_CUSTODY_CASHLIKE_METHODS = ['CASH', 'CHEQUE'] as const;

/**
 * الطرق غير النقدية المعروفة. ما عداها يُعامل نقداً: افتراضي RepSettlement.method هو CASH، وP7 القائم يعامل الطريقة
 * المجهولة نقداً (builders/custody.ts) — فالحكم هنا يطابقه كي لا يرى الطيّ نقداً ويراه القيد بنكاً.
 */
const NON_CASH_METHODS: ReadonlySet<string> = new Set(['BANK_TRANSFER', 'POS', 'ONLINE', 'CARD']);

/** نقدٌ أو شيك؟ null/مجهول ⇒ true (افتراضي الاستلام CASH) */
export function isCashLikeMethod(method: string | null | undefined): boolean {
  if (method == null || method === '') return true;
  return !NON_CASH_METHODS.has(method);
}

type Instant = Date | string;

/** RepSettlement بمستلِمٍ هو المستخدم (receivedByUserId) — reversedAt = حذف الاستلام (الدفاتر: حدث SETTLEMENT REVERSE) */
export interface UserCustodyReceivedRow {
  id: string;
  amountMilli: bigint;
  method: string;
  at: Instant;
  createdAt: Instant;
  reversedAt?: Instant | null;
  /** منظور الدفاتر: مالٌ لم يدخل 111004 (استلام مندوبٍ محذوف) — يدخل الوعاء لا العهدة أياً كانت طريقته. الغائب = حكم الطريقة */
  outsideCustody?: boolean;
}

/** UserSettlement (توريد المستخدم). storedPassThroughMilli = ما حفظه المُرحِّل على الحدث (nonCustodyClearedMilli) — يُقرأ ولا يُعاد اشتقاقه */
export interface UserCustodyDeliveredRow {
  id: string;
  amountMilli: bigint;
  method: string;
  at: Instant;
  createdAt: Instant;
  reversedAt?: Instant | null;
  storedPassThroughMilli?: bigint | null;
}

/** سند أُلغي ورُدّ ماله من عهدة المستخدم (cancelRefundFrom = USER_CUSTODY، cancelRefundUserId = المستخدم) */
export interface UserCustodyRefundRow {
  id: string;
  amountMilli: bigint;
  at: Instant;
  createdAt: Instant;
}

export interface UserCustodyInputs {
  userId: string;
  received: UserCustodyReceivedRow[];
  delivered: UserCustodyDeliveredRow[];
  refunds: UserCustodyRefundRow[];
}

/** تقسيم توريدٍ واحد: passThrough (مرور من الوعاء بلا قيد) + custody (من العهدة النقدية: قيد على 111004) = amount */
export interface UserDeliverySplit {
  id: string;
  amountMilli: bigint;
  passThroughMilli: bigint;
  custodyMilli: bigint;
  /** قُرئ التقسيم من القيمة المخزّنة على الحدث */
  stored: boolean;
  /** حُذف التوريد لاحقاً فاستُعيد أثره */
  reversed: boolean;
}

export interface UserCustodyFold {
  userId: string;
  /** Σ المستلَم نقداً وشيكات (غير المحذوف) */
  receivedCashMilli: bigint;
  /** Σ المستلَم تحويلاً ونقطة بيع (غير المحذوف) — لا يدخل العهدة */
  receivedNonCashMilli: bigint;
  /** Σ مبالغ التوريدات غير المحذوفة (نقدي وغير نقدي) */
  deliveredMilli: bigint;
  /** Σ ما مرّ من الوعاء في التوريدات غير المحذوفة */
  passThroughMilli: bigint;
  refundsMilli: bigint;
  /** الوعاء غير النقدي المتبقّي = receivedNonCash − passThrough */
  nonCashPoolMilli: bigint;
  /** = receivedCash − Σ custodyMilli(المسلَّمة غير المعكوسة) − refunds */
  outstandingMilli: bigint;
  deliveries: UserDeliverySplit[];
}

// ═══ الطيّ ═══

// الترتيب عند تساوي اللحظة: الاستلام < التوريد < الاسترداد < العكس — فتوريدٌ في لحظة استلامٍ يجد ما استُلم
const RANK = { RECEIVED: 0, DELIVERED: 1, REFUND: 2, REVERSAL: 3 } as const;

type Step =
  | { kind: 'RECEIVED'; row: UserCustodyReceivedRow; sign: 1n | -1n }
  | { kind: 'DELIVERED'; row: UserCustodyDeliveredRow; sign: 1n | -1n }
  | { kind: 'REFUND'; row: UserCustodyRefundRow; sign: 1n };

interface TimedStep { at: number; created: number; rank: number; id: string; seq: number; step: Step }

function ms(v: Instant, what: string): number {
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  if (!Number.isFinite(t)) throw new RangeError(`لحظة غير صالحة في عهدة المستخدم (${what}): ${String(v)}`);
  return t;
}

const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function assertAmount(m: bigint, id: string): void {
  if (m < 0n) throw new RangeError(`مبلغ سالب في عهدة المستخدم: ${id}`);
}

/**
 * مرور التوريد النقدي: ما زاد عن العهدة النقدية القائمة لحظتَه يُؤخذ من الوعاء الموجب — pass = min(max(0, amount − max(0, cash)), max(0, pool)).
 * توريدٌ ضمن عهدته (كل جديدٍ بعد OD5) ⇒ صفر، فالتعريف كما هو حرفاً؛ والقديم الذي تجاوز النقد بسقفه القديم يمرّ بلا سالب.
 */
export function cashExcessPassMilli(amountMilli: bigint, cashOutstandingMilli: bigint, poolMilli: bigint): bigint {
  return minBig(maxBig(0n, amountMilli - maxBig(0n, cashOutstandingMilli)), maxBig(0n, poolMilli));
}

/**
 * طيّ زمني: at ثم createdAt ثم (الاستلام < التوريد < الاسترداد < العكس) ثم id. التوريد غير النقدي:
 * pass = min(amount, max(0, pool))، custody = amount − pass؛ والنقدي pass = cashExcessPassMilli (صفرٌ ما دام ضمن العهدة
 * النقدية لحظتَه). القيمة المخزّنة تُقرأ ولا يُعاد اشتقاقها.
 * عكس الاستلام (حذفه) يُسقط أثره بالقيمة نفسها، وعكس التوريد يستعيد pass إلى الوعاء وcustody إلى العهدة كما حُسبا لحظته.
 */
export function foldUserCustody(inputs: UserCustodyInputs): UserCustodyFold {
  const steps: TimedStep[] = [];
  let seq = 0;
  for (const row of inputs.received) {
    assertAmount(row.amountMilli, row.id);
    steps.push({ at: ms(row.at, row.id), created: ms(row.createdAt, row.id), rank: RANK.RECEIVED, id: row.id, seq: seq++, step: { kind: 'RECEIVED', row, sign: 1n } });
    if (row.reversedAt != null) {
      const t = ms(row.reversedAt, row.id);
      steps.push({ at: t, created: t, rank: RANK.REVERSAL, id: row.id, seq: seq++, step: { kind: 'RECEIVED', row, sign: -1n } });
    }
  }
  for (const row of inputs.delivered) {
    assertAmount(row.amountMilli, row.id);
    steps.push({ at: ms(row.at, row.id), created: ms(row.createdAt, row.id), rank: RANK.DELIVERED, id: row.id, seq: seq++, step: { kind: 'DELIVERED', row, sign: 1n } });
    if (row.reversedAt != null) {
      const t = ms(row.reversedAt, row.id);
      steps.push({ at: t, created: t, rank: RANK.REVERSAL, id: row.id, seq: seq++, step: { kind: 'DELIVERED', row, sign: -1n } });
    }
  }
  for (const row of inputs.refunds) {
    assertAmount(row.amountMilli, row.id);
    steps.push({ at: ms(row.at, row.id), created: ms(row.createdAt, row.id), rank: RANK.REFUND, id: row.id, seq: seq++, step: { kind: 'REFUND', row, sign: 1n } });
  }
  steps.sort((a, b) => a.at - b.at || a.created - b.created || a.rank - b.rank
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.seq - b.seq);

  let receivedCash = 0n;
  let receivedNonCash = 0n;
  let delivered = 0n;
  let pass = 0n;
  let custodyOut = 0n;
  let refunds = 0n;
  const splits = new Map<string, UserDeliverySplit>();
  const reversedReceived = new Set<string>();

  for (const { step } of steps) {
    switch (step.kind) {
      case 'RECEIVED': {
        if (step.sign === -1n) {
          if (reversedReceived.has(step.row.id)) break;
          reversedReceived.add(step.row.id);
        }
        const amt = step.row.amountMilli * step.sign;
        if (isCashLikeMethod(step.row.method) && step.row.outsideCustody !== true) receivedCash += amt;
        else receivedNonCash += amt;
        break;
      }
      case 'DELIVERED': {
        const row = step.row;
        if (step.sign === 1n) {
          if (splits.has(row.id)) break; // صفّ مكرّر بالمعرّف نفسه: يُطوى مرة واحدة
          const pool = receivedNonCash - pass;
          let p: bigint;
          const stored = row.storedPassThroughMilli != null;
          if (stored) {
            p = row.storedPassThroughMilli as bigint;
            if (p < 0n || p > row.amountMilli) {
              throw new RangeError(`تقسيم مخزَّن غير صالح لتوريد ${row.id}: المرور ${p} من ${row.amountMilli}`);
            }
          } else if (isCashLikeMethod(row.method)) {
            // النقدي من العهدة النقدية لحظتَه أولاً، وما زاد عنها يمرّ من الوعاء (التاريخ القديم قبل OD5 — رأس الملف)
            p = cashExcessPassMilli(row.amountMilli, receivedCash - custodyOut - refunds, pool);
          } else {
            p = minBig(row.amountMilli, maxBig(0n, pool));
          }
          const c = row.amountMilli - p;
          splits.set(row.id, { id: row.id, amountMilli: row.amountMilli, passThroughMilli: p, custodyMilli: c, stored, reversed: false });
          delivered += row.amountMilli;
          pass += p;
          custodyOut += c;
        } else {
          const s = splits.get(row.id);
          if (!s || s.reversed) break;
          s.reversed = true;
          delivered -= s.amountMilli;
          pass -= s.passThroughMilli;
          custodyOut -= s.custodyMilli;
        }
        break;
      }
      case 'REFUND':
        refunds += step.row.amountMilli;
        break;
    }
  }

  return {
    userId: inputs.userId,
    receivedCashMilli: receivedCash,
    receivedNonCashMilli: receivedNonCash,
    deliveredMilli: delivered,
    passThroughMilli: pass,
    refundsMilli: refunds,
    nonCashPoolMilli: receivedNonCash - pass,
    outstandingMilli: receivedCash - custodyOut - refunds,
    deliveries: [...splits.values()],
  };
}

/**
 * تقسيم توريدٍ واحد على مدخلاتٍ «قبله» — مدخل builder التوريد (buildUserSettlementMove).
 * الطيّ زمني، فتقسيم التوريد لا يتأثر بما بعده: يكفي طيّ المدخلات كاملةً وقراءة تقسيمه.
 */
export function userDeliverySplitBefore(inputs: UserCustodyInputs, deliveryId: string): { passThroughMilli: bigint; custodyMilli: bigint } {
  const s = foldUserCustody(inputs).deliveries.find((d) => d.id === deliveryId);
  if (!s) throw new RangeError(`التوريد ${deliveryId} غائب عن مدخلات عهدة المستخدم ${inputs.userId}`);
  return { passThroughMilli: s.passThroughMilli, custodyMilli: s.custodyMilli };
}

/** سقف التوريد الجديد: نقدي ⇒ outstanding، غير نقدي ⇒ outstanding + الوعاء الموجب (يمرّ منه أولاً) */
export function userHandoverCapMilli(fold: UserCustodyFold, method: string): bigint {
  return isCashLikeMethod(method) ? fold.outstandingMilli : fold.outstandingMilli + maxBig(0n, fold.nonCashPoolMilli);
}

/**
 * هل يبقى تقسيم كل توريدٍ آخر كما هو لو حُذف التوريد `deliveryId`؟
 *
 * لماذا: الدفاتر المربوطة تعكس التوريد المحذوف بتقسيمه المخزَّن وتُبقي تقسيم ما بعده مخزَّناً (لا إعادة ترحيل)، أما الشاشة
 * فتعيد الطيّ بلا المحذوف. فإن كان توريدٌ غير نقديّ لاحقٌ قد استنفد الوعاء بسبب المحذوف، تغيّر تقسيمه في الشاشة وحدها
 * فتنحرف العهدة عن 111004 (C4u أحمر) بلا قيدٍ يصلحها. الحلّ: يُحذف اللاحق أولاً — كترتيب حذف الاستلام قبل توريده.
 */
export function deliveryRemovalKeepsSplits(inputs: UserCustodyInputs, deliveryId: string): boolean {
  const before = foldUserCustody(inputs);
  if (!before.deliveries.some((d) => d.id === deliveryId)) return true;
  const after = foldUserCustody({ ...inputs, delivered: inputs.delivered.filter((d) => d.id !== deliveryId) });
  const was = new Map(before.deliveries.map((d) => [d.id, d]));
  return after.deliveries.every((d) => {
    const w = was.get(d.id);
    return !!w && w.passThroughMilli === d.passThroughMilli && w.custodyMilli === d.custodyMilli;
  });
}

/**
 * هل يبقى كل شيء سليماً لو حُذف استلامٌ (RepSettlement) من مدخلات المستخدم؟ — بلا عهدة سالبة، وبلا تغيّر تقسيم أي
 * توريد (السبب نفسه أعلاه: الدفاتر تُبقي التقسيم المخزَّن). استلامٌ نقديٌّ يُفحص بالعهدة وحدها، وغير النقدي بالتقسيم.
 * لحارس حذف استلام المندوب (routes/salesReps.ts) في الشركة المربوطة.
 */
export function receivedRemovalKeepsCustodySane(inputs: UserCustodyInputs, receivedId: string, epsMilli = 0n): boolean {
  const before = foldUserCustody(inputs);
  const after = foldUserCustody({ ...inputs, received: inputs.received.filter((r) => r.id !== receivedId) });
  if (after.outstandingMilli < -epsMilli) return false;
  const was = new Map(before.deliveries.map((d) => [d.id, d]));
  return after.deliveries.every((d) => {
    const w = was.get(d.id);
    return !!w && w.passThroughMilli === d.passThroughMilli && w.custodyMilli === d.custodyMilli;
  });
}
