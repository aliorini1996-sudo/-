/**
 * «ربط الدفاتر» L8 — مخطِّط المطابقة الجزئية (صرف تماماً، عقد §3.7).
 *
 * قواعد ثابتة لكل خطة:
 * - لا يُطابَق سطرا ذمة إلا على **الحساب نفسه** و**الشريك نفسه** (Odoo: لا مطابقة بين حسابين أو شريكين).
 * - المدين بالأقدم استحقاقاً (dueDate، وإلا التاريخ) ثم التاريخ ثم seq ثم المعرّف — حتمي، فالأقساط تُسقط بترتيبها.
 * - لا مبلغ فوق متبقّي أيٍّ من الطرفين، ولا فوق المبلغ المطلوب (null = بحدّ المفتوح من الجهتين).
 * - المبالغ ملّي BigInt، والناتج موجب دائماً؛ وΣ الخطة ≤ المطلوب حرفاً.
 */
import type { OpenControlLine, PartialInsert } from './types';

/** تاريخ الاستحقاق الفعلي: الاستحقاق المخزَّن، وإلا تاريخ السطر */
export function effectiveDueDate(l: Pick<OpenControlLine, 'dueDate' | 'date'>): string {
  return l.dueDate ?? l.date;
}

/** ترتيب «الأقدم استحقاقاً»: dueDate ثم date ثم seq ثم moveId ثم lineId */
export function compareOpenLines(a: OpenControlLine, b: OpenControlLine): number {
  const da = effectiveDueDate(a);
  const db = effectiveDueDate(b);
  if (da !== db) return da < db ? -1 : 1;
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.moveId !== b.moveId) return a.moveId < b.moveId ? -1 : 1;
  return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
}

const sameBook = (d: OpenControlLine, c: OpenControlLine): boolean =>
  d.accountId === c.accountId && d.partnerId === c.partnerId && d.kind === c.kind;

/**
 * يوزّع `amountMilli` على سطور المدين بالأقدم استحقاقاً مقابل سطور الدائن بالترتيب نفسه، بحدود المتبقّي.
 * `amountMilli = null` ⇒ بلا سقف (كل ما يمكن مطابقته). مبلغ ≤ 0 ⇒ لا شيء.
 */
export function planMatches(
  debits: readonly OpenControlLine[],
  credits: readonly OpenControlLine[],
  amountMilli: bigint | null,
  sourceRef: string,
): PartialInsert[] {
  if (amountMilli !== null && amountMilli <= 0n) return [];
  const ds = debits.filter((l) => l.side === 'DEBIT' && l.residualMilli > 0n).sort(compareOpenLines);
  const cs = credits.filter((l) => l.side === 'CREDIT' && l.residualMilli > 0n).sort(compareOpenLines);
  const left = new Map<string, bigint>();
  for (const l of [...ds, ...cs]) left.set(l.lineId, l.residualMilli);
  let remaining = amountMilli;
  const out: PartialInsert[] = [];
  for (const d of ds) {
    if (remaining !== null && remaining <= 0n) break;
    for (const c of cs) {
      if (remaining !== null && remaining <= 0n) break;
      // سطر واحد في الجهتين مستحيل (debit وcredit معاً)، والدفاع رخيص
      if (c.lineId === d.lineId || !sameBook(d, c)) continue;
      const dl = left.get(d.lineId) as bigint;
      if (dl <= 0n) break;
      const cl = left.get(c.lineId) as bigint;
      if (cl <= 0n) continue;
      let take = dl < cl ? dl : cl;
      if (remaining !== null && remaining < take) take = remaining;
      if (take <= 0n) continue;
      out.push({ debitLineId: d.lineId, creditLineId: c.lineId, debitMoveId: d.moveId, creditMoveId: c.moveId, amountMilli: take, sourceRef });
      left.set(d.lineId, dl - take);
      left.set(c.lineId, cl - take);
      if (remaining !== null) remaining -= take;
    }
  }
  return out;
}

/**
 * القيد الأصلي مع قيد عكسه: كل سطر أصلي مع **مرآته** في العكس (الجانب المقابل، والحساب والشريك والمبلغ نفسه،
 * والاستحقاق نفسه إن وُجد) أولاً، ثم ما بقي بالأقدم فالأقدم. فيصير الأصل وعكسه مطابَقين كلياً سطراً بسطر.
 *
 * حالة keepCashLeg: الأصل مدين ودائن (ساق النقد) والعكس دائن وحده ⇒ يُطابَق المدين بالعكس ويبقى دائن ساق النقد
 * مفتوحاً (رصيد العميل الدائن، Q1).
 */
export function planReversalMatches(
  original: readonly OpenControlLine[],
  reversal: readonly OpenControlLine[],
  sourceRef: string,
): PartialInsert[] {
  const left = new Map<string, bigint>();
  for (const l of [...original, ...reversal]) left.set(l.lineId, l.residualMilli);
  const out: PartialInsert[] = [];
  const push = (d: OpenControlLine, c: OpenControlLine, amt: bigint) => {
    out.push({ debitLineId: d.lineId, creditLineId: c.lineId, debitMoveId: d.moveId, creditMoveId: c.moveId, amountMilli: amt, sourceRef });
    left.set(d.lineId, (left.get(d.lineId) as bigint) - amt);
    left.set(c.lineId, (left.get(c.lineId) as bigint) - amt);
  };
  const orig = [...original].sort((a, b) => a.seq - b.seq || (a.lineId < b.lineId ? -1 : 1));
  const rev = [...reversal].sort((a, b) => a.seq - b.seq || (a.lineId < b.lineId ? -1 : 1));
  // ١) المرآة الدقيقة: مبلغ مطابق وحساب وشريك واحد، والأقرب ترتيباً
  for (const o of orig) {
    const ol = left.get(o.lineId) as bigint;
    if (ol <= 0n) continue;
    const mirror = rev.find((r) => r.side !== o.side && sameBook(o, r) && r.amountMilli === o.amountMilli
      && (left.get(r.lineId) as bigint) > 0n && (o.dueDate === null || r.dueDate === null || o.dueDate === r.dueDate));
    if (!mirror) continue;
    const rl = left.get(mirror.lineId) as bigint;
    const take = ol < rl ? ol : rl;
    if (o.side === 'DEBIT') push(o, mirror, take); else push(mirror, o, take);
  }
  // ٢) الباقي (سطور دُمجت أو قُسّمت): الأقدم فالأقدم في الجهتين
  const live = (ls: readonly OpenControlLine[]) => ls.map((l) => ({ ...l, residualMilli: left.get(l.lineId) as bigint }));
  const rest = [
    ...planMatches(live(orig.filter((l) => l.side === 'DEBIT')), live(rev.filter((l) => l.side === 'CREDIT')), null, sourceRef),
    ...planMatches(live(rev.filter((l) => l.side === 'DEBIT')), live(orig.filter((l) => l.side === 'CREDIT')), null, sourceRef),
  ];
  return mergeInserts([...out, ...rest]);
}

/** يدمج سطري خطة على الزوج نفسه والمرجع نفسه (القيد الفريد لا يقبل صفّين) */
export function mergeInserts(rows: readonly PartialInsert[]): PartialInsert[] {
  const byKey = new Map<string, PartialInsert>();
  for (const r of rows) {
    const k = `${r.sourceRef}|${r.debitLineId}|${r.creditLineId}`;
    const prev = byKey.get(k);
    byKey.set(k, prev ? { ...prev, amountMilli: prev.amountMilli + r.amountMilli } : { ...r });
  }
  return [...byKey.values()];
}

/** يطبّق خطةً على نسخ السطور محلياً (المتبقّي بعدها) — لخطط متتالية داخل الحدث نفسه */
export function consumePlan(lines: readonly OpenControlLine[], plan: readonly PartialInsert[]): OpenControlLine[] {
  const used = new Map<string, bigint>();
  for (const p of plan) {
    used.set(p.debitLineId, (used.get(p.debitLineId) ?? 0n) + p.amountMilli);
    used.set(p.creditLineId, (used.get(p.creditLineId) ?? 0n) + p.amountMilli);
  }
  return lines.map((l) => (used.has(l.lineId) ? { ...l, residualMilli: l.residualMilli - (used.get(l.lineId) as bigint) } : l));
}

/** Σ مطابقات كل مرجع — لتساوي الأثر: المطلوب للمرجع = مبلغه − ما طوبق به قبلاً */
export function matchedByRef(rows: readonly { sourceRef: string | null; amountMilli: bigint }[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const r of rows) {
    if (!r.sourceRef) continue;
    out.set(r.sourceRef, (out.get(r.sourceRef) ?? 0n) + r.amountMilli);
  }
  return out;
}
