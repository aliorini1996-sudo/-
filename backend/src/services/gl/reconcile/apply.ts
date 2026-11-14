/**
 * «ربط الدفاتر» L8 — تطبيق قواعد المطابقة الجزئية بعد كل قيد ذمة (عقد §6.1، D7، D8).
 *
 * يُستدعى داخل معاملة الترحيل نفسها (المُرحِّل بعد postMove/reverseMove، ومسار M4، ومسار التسوية الموجّهة)، فيُكتب
 * القيد ومطابقته معاً أو لا يُكتب شيء. **للمربوطة وحدها**: المستدعي يحرس ذلك (المُرحِّل بـlinkedPosting).
 *
 * الإدراج:
 * | القيد                       | sourceRef               | القاعدة |
 * |-----------------------------|-------------------------|---------|
 * | INVOICE:POST (CASH)         | CASH:<moveId>           | ساقا الذمة في القيد نفسه |
 * | INVOICE:POST (غير المرتجع)  | RI:<id> / CA:<id>       | ما ينتظر من سندات وشطب مرحّلة (pendingAllocationsForInvoice) |
 * | INVOICE:POST بـappliesTo    | RET:<id> / CN:<id>      | دائن المرتجع مقابل مدين البيع الحيّ بحدّ المبلغ؛ الإشعار الدائن بحدّ المفتوح (D8) |
 * | RECEIPT:POST                | RI:<allocId>            | لكل تخصيص: دائن السند مقابل مدين الفاتورة الحيّة بالأقدم استحقاقاً |
 * | CUSTOMER_ADJUSTMENT (شطب)   | CA:<allocId>            | دائن الشطب مقابل مدين الفاتورة الحيّة |
 * | CUSTOMER_ADJUSTMENT (ردّ)   | FIFO:<lineId>           | مدين الاسترداد مقابل الأرصدة الدائنة المفتوحة للعميل، الأقدم أولاً |
 * | INVOICE:POST (بيع)          | RET:<id> / CN:<id>      | مرتجعات وإشعارات دائنة رُحّلت قبله (pendingReturnsForInvoice): RET بباقيه ثم CN بالمفتوح |
 * | أيٌّ مما سبق وأصله افتتاحي  | المرجع نفسه             | فاتورة حدثها SKIPPED(OPENING) لا قيد حيّ لها أبداً: يُطابَق بسطر افتتاح العميل المدين |
 * | REVERSE بلا أصل حيّ (افتتاح) | REV:<reversalMoveId>    | ساقا العكس ببعضهما، ودائنه الباقي بمدين افتتاح العميل (لا keepCashLeg) |
 *
 * الفكّ عند أي REVERSE: تُحذف المطابقات التي تمسّ سطور ذمة القيد الأصلي (فتتحرّر الأطراف المقابلة)، ثم يُطابَق كل سطر
 * أصلي بسطر عكسه REV:<reversalMoveId>. **لا FIFO** للأرصدة الدائنة غير المخصّصة (D7): السند غير المخصّص يبقى رصيداً دائناً.
 *
 * تساوي الأثر: المطلوب لكل مرجع = مبلغه − ما طوبق به قبلاً، والإدراج skipDuplicates — فإعادة الاستدعاء لا تضاعف شيئاً.
 */
import { toMilli, MAX_CURRENCY_DECIMALS } from '../money';
import { invoiceKey } from '../sync/keys';
import { postKeyOf } from '../sync/keys';
import type { InvoicePayload } from '../builders/invoice';
import {
  adjustmentAllocationRef, cashRef, creditNoteRef, fifoRef, receiptAllocationRef, returnRef, reversalRef,
  supplierAllocationRef,
  type CustomerAdjustmentReconcilePayload, type OpenControlLine, type PartialInsert, type ReconcileEventInput,
  type ReconcileKind, type ReconcileOutcome, type ReconcileStore,
} from './types';
import { consumePlan, matchedByRef, mergeInserts, planMatches, planReversalMatches } from './planner';

const NONE: ReconcileOutcome = { created: 0, removed: 0 };

/** مبلغ نصّي من الحمولة ⇐ ملّي حرفاً (الحمولة بمنازل العملة ≤ 3، فلا تقريب) */
function payloadMilli(v: string | number | null | undefined): bigint | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    return toMilli(v, MAX_CURRENCY_DECIMALS);
  } catch {
    return null;
  }
}

const debitsOf = (ls: readonly OpenControlLine[]) => ls.filter((l) => l.side === 'DEBIT');
const creditsOf = (ls: readonly OpenControlLine[]) => ls.filter((l) => l.side === 'CREDIT');

/** القيود الحيّة لعدة مفاتيح: دفعةً واحدة إن وفّرها المخزن، وإلا واحداً واحداً */
async function liveMoves(store: ReconcileStore, baseKeys: readonly string[]): Promise<Map<string, string>> {
  const keys = [...new Set(baseKeys)];
  if (keys.length === 0) return new Map();
  if (store.liveMoveIdsOf) return store.liveMoveIdsOf(keys);
  const out = new Map<string, string>();
  for (const k of keys) {
    const id = await store.liveMoveIdOf(k);
    if (id) out.set(k, id);
  }
  return out;
}

/** سطور الذمة لعدة قيود: دفعةً واحدة إن وفّرها المخزن */
async function linesOfMoves(store: ReconcileStore, moveIds: readonly string[], kind: ReconcileKind): Promise<Map<string, OpenControlLine[]>> {
  const ids = [...new Set(moveIds)];
  if (ids.length === 0) return new Map();
  if (store.controlLinesOfMoves) return store.controlLinesOfMoves(ids, kind);
  const out = new Map<string, OpenControlLine[]>();
  for (const id of ids) out.set(id, await store.controlLinesOfMove(id, kind));
  return out;
}

async function insert(store: ReconcileStore, plan: readonly PartialInsert[]): Promise<number> {
  const rows = mergeInserts(plan).filter((p) => p.amountMilli > 0n);
  return rows.length > 0 ? store.insertPartials(rows) : 0;
}

type AnyPayload = Record<string, unknown> | null;

function adjustmentPayloadOf(input: ReconcileEventInput): CustomerAdjustmentReconcilePayload | null {
  const p = input.payload as AnyPayload;
  if (!p) return null;
  const kind = p.kind;
  if (kind !== 'BAD_DEBT_WRITEOFF' && kind !== 'CREDIT_REFUND') return null;
  if (input.sourceType === 'AR_ENTRY' && p.origin !== 'CUSTOMER_ADJUSTMENT') return null;
  return p as unknown as CustomerAdjustmentReconcilePayload;
}

/**
 * المطابقة بعد قيدٍ مرحَّل (POST أو REVERSE). حدث لا قاعدة له ⇒ لا شيء.
 * الاستثناء يُرمى للمستدعي (المُرحِّل يُسقط المعاملة كلها: اتساق الدفتر مع مطابقته).
 */
export async function reconcileAfterPost(store: ReconcileStore, input: ReconcileEventInput): Promise<ReconcileOutcome> {
  if (input.event === 'REVERSE') return reconcileReversal(store, input);
  if (input.event !== 'POST') return NONE;
  switch (input.sourceType) {
    case 'INVOICE': return reconcileInvoicePost(store, input);
    case 'RECEIPT': return reconcileReceiptPost(store, input);
    case 'CUSTOMER_ADJUSTMENT':
    case 'AR_ENTRY': {
      const p = adjustmentPayloadOf(input);
      return p ? reconcileAdjustmentPost(store, input, p) : NONE;
    }
    default: return NONE;
  }
}

// ═══ الفاتورة ═══

async function reconcileInvoicePost(store: ReconcileStore, input: ReconcileEventInput): Promise<ReconcileOutcome> {
  const p = input.payload as (Partial<InvoicePayload> & Record<string, unknown>) | null;
  let lines = await store.controlLinesOfMove(input.moveId, 'AR');
  if (lines.length === 0) return NONE;
  let created = 0;
  const existing = matchedByRef(await store.partialsOfMoves([input.moveId]));

  // ١) النقدية: ساق الذمة المدينة مع ساق التحصيل الدائنة في القيد نفسه. بلا حمولة: القيد الذي فيه الجانبان لعميل واحد
  const hasBoth = debitsOf(lines).length > 0 && creditsOf(lines).length > 0;
  if (p?.type === 'CASH' || (!p?.type && hasBoth)) {
    const plan = planMatches(debitsOf(lines), creditsOf(lines), null, cashRef(input.moveId));
    created += await insert(store, plan);
    lines = consumePlan(lines, plan);
  }

  // ٢) المرتجع المرتبط (RET بحدّ المبلغ) أو الإشعار الدائن (CN بحدّ المفتوح، D8): دائن هذا القيد مقابل مدين البيع الحيّ
  const applies = p?.appliesTo;
  if (applies && applies.invoiceId && applies.invoiceId !== input.sourceId) {
    const live = await store.liveMoveIdOf(invoiceKey(applies.invoiceId, 'POST'));
    if (live && live !== input.moveId) {
      const ref = applies.amount === null || applies.amount === undefined ? creditNoteRef(input.sourceId) : returnRef(input.sourceId);
      const target = debitsOf(await store.controlLinesOfMove(live, 'AR'));
      let want: bigint | null = null;
      if (applies.amount !== null && applies.amount !== undefined) {
        const amt = payloadMilli(applies.amount);
        want = amt === null ? 0n : amt - (existing.get(ref) ?? 0n);
      }
      if (want === null || want > 0n) {
        const plan = planMatches(target, creditsOf(lines), want, ref);
        created += await insert(store, plan);
        lines = consumePlan(lines, plan);
      }
    }
    // البيع مشمول بالافتتاح (حدثه SKIPPED(OPENING)) فلا قيد حيّ له أبداً: دائن المرتجع مقابل مدين افتتاح العميل نفسه
    if (!live) {
      const opened = await matchAppliesToOpening(store, input, lines, applies, existing);
      created += opened.created;
      lines = opened.lines;
    }
  }

  // ٣) سندات وشطب سبقت ترحيل الفاتورة (فاتورة آجلة كانت معلّقة): النقدية مسدّدة بساقها والمرتجع لا يُخصَّص له سند —
  //    فلا قراءة لجداول التخصيص لهما (القاعدة 0.1 نواة)
  if (!p?.type || p.type === 'CREDIT') {
    const pending = (await store.pendingAllocationsForInvoice(input.sourceId))
      .filter((a) => a.amountMilli > 0n && a.creditMoveId !== input.moveId);
    const creditLines = await linesOfMoves(store, pending.map((a) => a.creditMoveId), 'AR');
    for (const a of pending) {
      const credits = creditsOf(creditLines.get(a.creditMoveId) ?? []);
      const plan = planMatches(debitsOf(lines), credits, a.amountMilli, a.sourceRef);
      created += await insert(store, plan);
      lines = consumePlan(lines, plan);
      creditLines.set(a.creditMoveId, consumePlan(creditLines.get(a.creditMoveId) ?? [], plan));
    }
  }

  // ٣ب) مرتجعات وإشعارات دائنة رُحّلت قبل فاتورة بيعها (أو فُكّت مطابقتها بإعادة ترحيل البيع)
  if (p?.type !== 'RETURN') created += await matchPendingReturns(store, input, lines);
  return { created, removed: 0 };
}

// ═══ السند ═══

async function reconcileReceiptPost(store: ReconcileStore, input: ReconcileEventInput): Promise<ReconcileOutcome> {
  const p = input.payload as { allocations?: readonly { id: string; invoiceId: string; amount: string | number }[] } | null;
  const allocations = p?.allocations ?? [];
  if (allocations.length === 0) return NONE; // D7: سند غير مخصّص يبقى رصيداً دائناً
  let credits = creditsOf(await store.controlLinesOfMove(input.moveId, 'AR'));
  if (credits.length === 0) return NONE;
  const existing = matchedByRef(await store.partialsOfMoves([input.moveId]));
  let created = 0;
  // دفعةً واحدة: القيود الحيّة لفواتير التخصيصات المطلوبة، ثم سطور ذممها (لا استعلام لكل تخصيص)
  const wanted = allocations
    .map((a) => ({ a, ref: receiptAllocationRef(a.id), amt: payloadMilli(a.amount) }))
    .filter((w): w is { a: typeof w.a; ref: string; amt: bigint } => w.amt !== null && w.amt - (existing.get(w.ref) ?? 0n) > 0n);
  const live = await liveMoves(store, wanted.map((w) => invoiceKey(w.a.invoiceId, 'POST')));
  const invoiceLines = await linesOfMoves(
    store, [...live.values()].filter((id) => id !== input.moveId), 'AR',
  );
  // فاتورة مشمولة بالافتتاح (SKIPPED(OPENING)) لن تُرحَّل أبداً: التخصيص يُطابَق بمدين افتتاح العميل نفسه
  const opening = await openingDebitsFor(store, wanted.map((w) => invoiceKey(w.a.invoiceId, 'POST')).filter((k) => !live.has(k)), credits);
  for (const { a, ref, amt } of wanted) {
    const moveId = live.get(invoiceKey(a.invoiceId, 'POST'));
    if (!moveId && opening.keys.has(invoiceKey(a.invoiceId, 'POST'))) {
      const plan = planMatches(opening.debits, credits, amt - (existing.get(ref) ?? 0n), ref);
      created += await insert(store, plan);
      credits = consumePlan(credits, plan);
      opening.debits = consumePlan(opening.debits, plan);
      continue;
    }
    if (!moveId || moveId === input.moveId) continue; // فاتورة لم تُرحَّل بعد: تلتقطها INVOICE:POST لاحقاً
    const debits = debitsOf(invoiceLines.get(moveId) ?? []);
    const plan = planMatches(debits, credits, amt - (existing.get(ref) ?? 0n), ref);
    created += await insert(store, plan);
    credits = consumePlan(credits, plan);
    invoiceLines.set(moveId, consumePlan(invoiceLines.get(moveId) ?? [], plan));
  }
  return { created, removed: 0 };
}

// ═══ تسوية ذمم العميل (M4) ═══

async function reconcileAdjustmentPost(
  store: ReconcileStore, input: ReconcileEventInput, p: CustomerAdjustmentReconcilePayload,
): Promise<ReconcileOutcome> {
  const lines = await store.controlLinesOfMove(input.moveId, 'AR');
  if (lines.length === 0) return NONE;
  let created = 0;
  if (p.kind === 'BAD_DEBT_WRITEOFF') {
    let credits = creditsOf(lines);
    const existing = matchedByRef(await store.partialsOfMoves([input.moveId]));
    const wanted = (p.allocations ?? [])
      .map((a) => ({ a, ref: adjustmentAllocationRef(a.id), amt: payloadMilli(a.amount) }))
      .filter((w): w is { a: typeof w.a; ref: string; amt: bigint } => w.amt !== null && w.amt - (existing.get(w.ref) ?? 0n) > 0n);
    const live = await liveMoves(store, wanted.map((w) => invoiceKey(w.a.invoiceId, 'POST')));
    const invoiceLines = await linesOfMoves(store, [...live.values()].filter((id) => id !== input.moveId), 'AR');
    const opening = await openingDebitsFor(store, wanted.map((w) => invoiceKey(w.a.invoiceId, 'POST')).filter((k) => !live.has(k)), credits);
    for (const { a, ref, amt } of wanted) {
      const moveId = live.get(invoiceKey(a.invoiceId, 'POST'));
      if (!moveId && opening.keys.has(invoiceKey(a.invoiceId, 'POST'))) {
        const plan = planMatches(opening.debits, credits, amt - (existing.get(ref) ?? 0n), ref);
        created += await insert(store, plan);
        credits = consumePlan(credits, plan);
        opening.debits = consumePlan(opening.debits, plan);
        continue;
      }
      if (!moveId || moveId === input.moveId) continue;
      const plan = planMatches(debitsOf(invoiceLines.get(moveId) ?? []), credits, amt - (existing.get(ref) ?? 0n), ref);
      created += await insert(store, plan);
      credits = consumePlan(credits, plan);
      invoiceLines.set(moveId, consumePlan(invoiceLines.get(moveId) ?? [], plan));
    }
    return { created, removed: 0 };
  }
  // CREDIT_REFUND: مدين الاسترداد (113001) يُسقط الأرصدة الدائنة المفتوحة للعميل الأقدم فالأقدم
  if (!store.openLinesOfPartner) return NONE;
  for (const d of debitsOf(lines)) {
    if (d.residualMilli <= 0n) continue;
    const open = (await store.openLinesOfPartner('AR', d.partnerId, 'CREDIT')).filter((c) => c.moveId !== input.moveId);
    created += await insert(store, planMatches([d], open, null, fifoRef(d.lineId)));
  }
  return { created, removed: 0 };
}

// ═══ العكس ═══

/**
 * فكّ مطابقات الأصل ثم مطابقته بعكسه. القيد الأصلي غائب (عكسٌ من المستند لأصلٍ في الافتتاح) ⇒ لا شيء:
 * سطور العكس تبقى مفتوحة مقابل رصيد الافتتاح للعميل.
 */
const RECONCILE_KINDS: readonly ReconcileKind[] = ['AR', 'AP'];

async function reconcileReversal(store: ReconcileStore, input: ReconcileEventInput): Promise<ReconcileOutcome> {
  const originalId = input.reversedMoveId ?? null;
  if (!originalId) return reconcileOpeningReversal(store, input);
  if (!originalId || originalId === input.moveId) return NONE;
  const ref = reversalRef(input.moveId);
  const kinds: ReconcileKind[] = [];
  const ids = new Set<string>();
  for (const kind of RECONCILE_KINDS) {
    const ls = await store.controlLinesOfMove(originalId, kind);
    if (ls.length === 0) continue;
    kinds.push(kind);
    for (const l of ls) ids.add(l.lineId);
  }
  if (kinds.length === 0) return NONE;
  // مطابقات سطور الذمة في الأصل وحدها (لا مطابقات التسوية الموجّهة على الحسابات الوسيطة) — ما عدا مطابقة هذا العكس نفسه
  const touching = (await store.partialsOfMoves([originalId]))
    .filter((r) => r.sourceRef !== ref && (ids.has(r.debitLineId) || ids.has(r.creditLineId)));
  const removed = touching.length > 0 ? await store.deletePartials(touching.map((r) => r.id)) : 0;
  let created = 0;
  for (const kind of kinds) {
    // بعد الحذف: متبقّي الأصل كاملٌ إلا ما طابقه هذا العكس سابقاً (إعادة الاستدعاء متساوية الأثر)
    const orig = await store.controlLinesOfMove(originalId, kind);
    const rev = await store.controlLinesOfMove(input.moveId, kind);
    if (rev.length === 0) continue;
    created += await insert(store, planReversalMatches(orig, rev, ref));
  }
  return { created, removed };
}

// ═══ «ربط الدفاتر» L8 — ما لا قيد حيّ له وقت المطابقة: المرتجع الذي سبق بيعه، والمستند المشمول بالافتتاح ═══

/** مرجع المرتجع أو الإشعار الدائن وحدّه: RET بحدّ المبلغ ناقصاً ما طوبق به (مبلغ غير مقروء ⇐ صفر)، وCN بحدّ المفتوح (null) */
function appliesBound(
  applies: { amount?: string | number | null }, sourceId: string, existing: ReadonlyMap<string, bigint>,
): { ref: string; want: bigint | null } {
  if (applies.amount === null || applies.amount === undefined) return { ref: creditNoteRef(sourceId), want: null };
  const ref = returnRef(sourceId);
  const amt = payloadMilli(applies.amount);
  return { ref, want: amt === null ? 0n : amt - (existing.get(ref) ?? 0n) };
}

/** سطور الافتتاح المدينة لشركاء الدائن (عميل السند غالباً) — قراءة لكل شريك، والسند لعميل واحد */
async function openingDebitsOfPartners(store: ReconcileStore, credits: readonly OpenControlLine[]): Promise<OpenControlLine[]> {
  if (!store.openingLinesOfPartner) return [];
  const out: OpenControlLine[] = [];
  for (const partnerId of new Set(credits.filter((c) => c.residualMilli > 0n).map((c) => c.partnerId))) {
    out.push(...debitsOf(await store.openingLinesOfPartner('AR', partnerId)));
  }
  return out;
}

/**
 * مفاتيح POST بلا قيد حيّ مشمولة بالافتتاح (حدثها SKIPPED(OPENING))، وسطور افتتاح العميل المدينة التي تضمّنتها. الفاتورة
 * المشمولة بالافتتاح لا تُرحَّل أبداً، فتخصيصها (RI أو CA) أو مرتجعها يُطابَق بسطر افتتاح العميل نفسه بحدّ المبلغ، وإلا بقي
 * مدين الافتتاح كاملاً في أقدم عمود ودائن السند غير مخصّص، وأظهر C16 فرقاً زائفاً لكل عميل سدّد فاتورة من قبل التفعيل.
 * لا قراءة إلا حين يوجد مفتاح بلا قيد حيّ.
 */
async function openingDebitsFor(
  store: ReconcileStore, baseKeys: readonly string[], credits: readonly OpenControlLine[],
): Promise<{ keys: Set<string>; debits: OpenControlLine[] }> {
  const keys = [...new Set(baseKeys)];
  if (keys.length === 0 || !store.openingKeysOf || !store.openingLinesOfPartner) return { keys: new Set(), debits: [] };
  const opening = await store.openingKeysOf(keys);
  if (opening.size === 0) return { keys: opening, debits: [] };
  return { keys: opening, debits: await openingDebitsOfPartners(store, credits) };
}

/** مرتجع أو إشعار دائن على بيعٍ مشمول بالافتتاح: دائنه مقابل مدين افتتاح عميله بالحدّ نفسه (RET بالمبلغ، CN بالمفتوح) */
async function matchAppliesToOpening(
  store: ReconcileStore, input: ReconcileEventInput, lines: OpenControlLine[],
  applies: { invoiceId: string; amount?: string | number | null }, existing: ReadonlyMap<string, bigint>,
): Promise<{ created: number; lines: OpenControlLine[] }> {
  const key = invoiceKey(applies.invoiceId, 'POST');
  const credits = creditsOf(lines);
  const opening = await openingDebitsFor(store, [key], credits);
  if (!opening.keys.has(key)) return { created: 0, lines };
  const { ref, want } = appliesBound(applies, input.sourceId, existing);
  if (want !== null && want <= 0n) return { created: 0, lines };
  const plan = planMatches(opening.debits, credits, want, ref);
  return { created: await insert(store, plan), lines: consumePlan(lines, plan) };
}

/**
 * مرتجعات وإشعارات دائنة رُحّلت قبل فاتورة بيعها (فشلٌ عابر أو HELD للبيع والمُرحِّل يكمل غيره)، أو فُكّت مطابقتها بإعادة
 * ترحيل البيع: المرتجع بحدّ باقيه أولاً، ثم الإشعار الدائن بحدّ المفتوح (D8) فلا يأكل ما يخصّ غيره. الفحص الرخيص قبل أي
 * قراءة: لا مدين مفتوح (نقدية سُدّدت بساقها، أو طوبقت كلها) ⇒ لا شيء (القاعدة 0.1 نواة).
 */
async function matchPendingReturns(store: ReconcileStore, input: ReconcileEventInput, lines: readonly OpenControlLine[]): Promise<number> {
  if (!store.pendingReturnsForInvoice || !debitsOf(lines).some((l) => l.residualMilli > 0n)) return 0;
  const rets = (await store.pendingReturnsForInvoice(input.sourceId))
    .filter((r) => r.creditMoveId !== input.moveId && (r.amountMilli === null || r.amountMilli > 0n));
  if (rets.length === 0) return 0;
  const ordered = [...rets.filter((r) => r.amountMilli !== null), ...rets.filter((r) => r.amountMilli === null)];
  const creditLines = await linesOfMoves(store, ordered.map((r) => r.creditMoveId), 'AR');
  let debits = debitsOf(lines);
  let created = 0;
  for (const r of ordered) {
    const plan = planMatches(debits, creditsOf(creditLines.get(r.creditMoveId) ?? []), r.amountMilli, r.sourceRef);
    created += await insert(store, plan);
    debits = consumePlan(debits, plan);
    creditLines.set(r.creditMoveId, consumePlan(creditLines.get(r.creditMoveId) ?? [], plan));
  }
  return created;
}

/**
 * عكسٌ بلا قيد أصلي: مستند مشمول بالافتتاح أُلغي بعد التفعيل (BUILD_FROM_SOURCE). ساقا الذمة في العكس نفسه (فاتورة نقدية
 * عُكست كاملة) تُطابَق ببعضهما، ودائنه الباقي (فاتورة آجلة أُلغيت) يُسقط مدين افتتاح العميل الذي تضمّنها — إلا العكس الجزئي
 * keepCashLeg: دائنه رصيد العميل الدائن (Q1) فيبقى مفتوحاً. ومدين العكس (سند أو مرتجع أُلغي) ذمةٌ جديدة صحيحة فيبقى مفتوحاً
 * (لا FIFO للأرصدة الدائنة، D7). مصدر لم يُشمل بالافتتاح ⇒ لا شيء كما كان.
 */
async function reconcileOpeningReversal(store: ReconcileStore, input: ReconcileEventInput): Promise<ReconcileOutcome> {
  if (!store.openingKeysOf || !store.openingLinesOfPartner) return NONE;
  let rev = await store.controlLinesOfMove(input.moveId, 'AR');
  if (rev.length === 0) return NONE;
  const base = postKeyOf(input.sourceType, input.sourceId);
  if (!(await store.openingKeysOf([base])).has(base)) return NONE;
  const ref = reversalRef(input.moveId);
  const own = planMatches(debitsOf(rev), creditsOf(rev), null, ref);
  let created = await insert(store, own);
  rev = consumePlan(rev, own);
  const credits = creditsOf(rev).filter((l) => l.residualMilli > 0n);
  if (credits.length > 0 && (input.payload as AnyPayload)?.keepCashLeg !== true) {
    created += await insert(store, planMatches(await openingDebitsOfPartners(store, credits), credits, null, ref));
  }
  return { created, removed: 0 };
}

// ═══ الموردون (L6) ═══

/**
 * تخصيص دفعة مورد على فاتورته (SupplierPaymentAllocation ⇒ SPA:<id>): مدين الدفعة مقابل دائن الفاتورة بالأقدم
 * استحقاقاً. جاهز الآن بلا مستدعٍ حتى يُرحَّل AP في L6. يعيد عدد المطابقات المُدرجة.
 */
export async function reconcileSupplierAllocation(
  store: ReconcileStore,
  a: { allocationId: string; billMoveId: string; paymentMoveId: string; amountMilli: bigint },
): Promise<number> {
  if (a.amountMilli <= 0n || a.billMoveId === a.paymentMoveId) return 0;
  const ref = supplierAllocationRef(a.allocationId);
  const existing = matchedByRef(await store.partialsOfMoves([a.paymentMoveId]));
  const want = a.amountMilli - (existing.get(ref) ?? 0n);
  if (want <= 0n) return 0;
  const [payment, bill] = await Promise.all([
    store.controlLinesOfMove(a.paymentMoveId, 'AP'),
    store.controlLinesOfMove(a.billMoveId, 'AP'),
  ]);
  return insert(store, planMatches(debitsOf(payment), creditsOf(bill), want, ref));
}
