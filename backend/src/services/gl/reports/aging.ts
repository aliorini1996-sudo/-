/**
 * «ربط الدفاتر» L8 — أعمار الذمم المدينة والدائنة من الدفاتر (عقد §6.2، Odoo Aged Receivable/Payable). **صرف تماماً**.
 *
 * المدخل: البنود المفتوحة (متبقّي ≠ 0 بعد المطابقات الجزئية) على حسابات الذمة، والمخرج صفّ لكل شريك:
 * - العمر بالأيام = asOf − تاريخ المرجع؛ والمرجع = الاستحقاق (basis=due، وإلا تاريخ السطر) أو تاريخ السطر (basis=date).
 * - العمر ≤ 0 ⇒ «غير مستحق»، ثم الأعمدة [1..b1] و[b1+1..b2] و[b2+1..b3] و[b3+1..b4] ثم «أقدم».
 * - البند المفتوح على **الجانب المعاكس** (دائن لعميل، أو مدين لمورد: سند غير مخصّص، مرتجع غير مطبّق، دفعة مقدمة)
 *   لا يُعمَّر: يدخل `unappliedCredits` **سالباً** (Odoo يعرضه كذلك)، فيبقى الإجمالي = صافي رصيد الشريك المفتوح.
 *
 * المبالغ موجبة على الجانب الطبيعي: الذمم المدينة بقاعدة مدين − دائن، والدائنة بقاعدة دائن − مدين.
 */
import { fromMilli } from '../money';
import { diffDays, isLocalDate } from '../dates';
import type { LocalDate, Milli } from '../types';

export const AGING_BASES = ['due', 'date'] as const;
export type AgingBasis = (typeof AGING_BASES)[number];
export const DEFAULT_AGING_BUCKETS: readonly number[] = [30, 60, 90, 120];
export const AGING_BUCKET_KEYS = ['notDue', 'b1', 'b2', 'b3', 'b4', 'older'] as const;
export type AgingBucketKey = (typeof AGING_BUCKET_KEYS)[number];

export function isAgingBasis(v: unknown): v is AgingBasis {
  return typeof v === 'string' && (AGING_BASES as readonly string[]).includes(v);
}

/**
 * `buckets=30,60,90,120` ⇒ أربعة أعداد صحيحة موجبة متزايدة تماماً (≤ 3650). غيابها ⇒ الافتراضي، وغير ذلك ⇒ null (400).
 */
export function parseAgingBuckets(raw: unknown): number[] | null {
  if (raw === undefined || raw === null || raw === '') return [...DEFAULT_AGING_BUCKETS];
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(',');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!/^\d{1,4}$/.test(t)) return null;
    const n = Number(t);
    if (n <= 0 || n > 3650) return null;
    if (out.length > 0 && n <= out[out.length - 1]) return null;
    out.push(n);
  }
  return out;
}

export interface AgingItem {
  partnerId: string;
  lineId?: string | null;
  moveId?: string | null;
  moveNumber?: string | null;
  date: LocalDate;
  dueDate: LocalDate | null;
  /** المتبقّي بقاعدة مدين − دائن (موقَّع) — مجمّعاً أو لسطر واحد */
  residualMilli: Milli;
}

export interface AgingRow {
  partnerId: string;
  name: string | null;
  notDue: Milli;
  b1: Milli;
  b2: Milli;
  b3: Milli;
  b4: Milli;
  older: Milli;
  /** سالب: البنود المفتوحة على الجانب المعاكس (أرصدة دائنة غير مخصّصة للعميل، دفعات مقدمة للمورد) */
  unappliedCredits: Milli;
  total: Milli;
}

export interface AgingDetail {
  partnerId: string;
  lineId: string | null;
  moveId: string | null;
  moveNumber: string | null;
  date: LocalDate;
  dueDate: LocalDate | null;
  daysOverdue: number;
  /** على الجانب الطبيعي: موجب يُعمَّر، وسالب = غير مخصّص */
  residualMilli: Milli;
  bucket: AgingBucketKey | 'unapplied';
}

export interface AgingInput {
  kind: 'AR' | 'AP';
  asOf: LocalDate;
  basis: AgingBasis;
  buckets: readonly number[];
  items: readonly AgingItem[];
  names: ReadonlyMap<string, string | null>;
  /** يعيد البنود مفصّلة (لشريك واحد) */
  detail?: boolean;
}

export interface AgingReport {
  kind: 'AR' | 'AP';
  asOf: LocalDate;
  basis: AgingBasis;
  buckets: number[];
  rows: AgingRow[];
  totals: Omit<AgingRow, 'partnerId' | 'name'>;
  detail?: AgingDetail[];
}

/** العمود من عدد الأيام بعد تاريخ المرجع */
export function agingBucketOf(days: number, buckets: readonly number[]): AgingBucketKey {
  if (days <= 0) return 'notDue';
  if (days <= buckets[0]) return 'b1';
  if (days <= buckets[1]) return 'b2';
  if (days <= buckets[2]) return 'b3';
  if (days <= buckets[3]) return 'b4';
  return 'older';
}

const zeroCols = (): Omit<AgingRow, 'partnerId' | 'name'> => ({
  notDue: 0n, b1: 0n, b2: 0n, b3: 0n, b4: 0n, older: 0n, unappliedCredits: 0n, total: 0n,
});

export function buildAging(input: AgingInput): AgingReport {
  if (!isLocalDate(input.asOf)) throw new RangeError(`asOf غير صالح: ${input.asOf}`);
  if (input.buckets.length !== 4) throw new RangeError('أعمدة الأعمار أربعة');
  const sign = input.kind === 'AR' ? 1n : -1n;
  const byPartner = new Map<string, AgingRow>();
  const detail: AgingDetail[] = [];
  for (const it of input.items) {
    const amount = it.residualMilli * sign;
    if (amount === 0n) continue;
    let row = byPartner.get(it.partnerId);
    if (!row) {
      row = { partnerId: it.partnerId, name: input.names.get(it.partnerId) ?? null, ...zeroCols() };
      byPartner.set(it.partnerId, row);
    }
    const ref = input.basis === 'due' ? (it.dueDate ?? it.date) : it.date;
    const days = diffDays(ref, input.asOf);
    let bucket: AgingBucketKey | 'unapplied';
    if (amount < 0n) {
      bucket = 'unapplied';
      row.unappliedCredits += amount;
    } else {
      bucket = agingBucketOf(days, input.buckets);
      row[bucket] += amount;
    }
    row.total += amount;
    if (input.detail) {
      detail.push({
        partnerId: it.partnerId, lineId: it.lineId ?? null, moveId: it.moveId ?? null, moveNumber: it.moveNumber ?? null,
        date: it.date, dueDate: it.dueDate, daysOverdue: days, residualMilli: amount, bucket,
      });
    }
  }
  const rows = [...byPartner.values()]
    .filter((r) => r.total !== 0n || r.unappliedCredits !== 0n)
    .sort((a, b) => {
      const na = a.name ?? '';
      const nb = b.name ?? '';
      if (na !== nb) return na < nb ? -1 : 1;
      return a.partnerId < b.partnerId ? -1 : a.partnerId > b.partnerId ? 1 : 0;
    });
  const totals = zeroCols();
  for (const r of rows) {
    for (const k of [...AGING_BUCKET_KEYS, 'unappliedCredits', 'total'] as const) totals[k] += r[k];
  }
  const out: AgingReport = { kind: input.kind, asOf: input.asOf, basis: input.basis, buckets: [...input.buckets], rows, totals };
  if (input.detail) {
    out.detail = detail.sort((a, b) => {
      const ra = input.basis === 'due' ? (a.dueDate ?? a.date) : a.date;
      const rb = input.basis === 'due' ? (b.dueDate ?? b.date) : b.date;
      if (ra !== rb) return ra < rb ? -1 : 1;
      return (a.moveNumber ?? '') < (b.moveNumber ?? '') ? -1 : (a.moveNumber ?? '') > (b.moveNumber ?? '') ? 1 : 0;
    });
  }
  return out;
}

const colsJson = (c: Omit<AgingRow, 'partnerId' | 'name'>) => ({
  notDue: fromMilli(c.notDue), b1: fromMilli(c.b1), b2: fromMilli(c.b2), b3: fromMilli(c.b3), b4: fromMilli(c.b4),
  older: fromMilli(c.older), unappliedCredits: fromMilli(c.unappliedCredits), total: fromMilli(c.total),
});

/** الردّ: أرقام بوحدة العملة */
export function serializeAging(r: AgingReport): Record<string, unknown> {
  return {
    kind: r.kind,
    asOf: r.asOf,
    basis: r.basis,
    buckets: r.buckets,
    rows: r.rows.map((x) => ({ partnerId: x.partnerId, name: x.name, ...colsJson(x) })),
    totals: colsJson(r.totals),
    ...(r.detail ? {
      detail: r.detail.map((d) => ({
        lineId: d.lineId, moveId: d.moveId, moveNumber: d.moveNumber, date: d.date, dueDate: d.dueDate,
        daysOverdue: d.daysOverdue, residual: fromMilli(d.residualMilli), bucket: d.bucket,
      })),
    } : {}),
  };
}
