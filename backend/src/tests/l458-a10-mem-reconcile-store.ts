// «ربط الدفاتر» L8 (A10) — مخزن مطابقة في الذاكرة لاختبارات المطابقة والتقارير: قيود بسطور، ومفاتيح مصادر، ومطابقات
// جزئية بقيد فريد (sourceRef, debitLineId, creditLineId) كالقاعدة. ليس اختباراً بذاته.
import type {
  OpenControlLine, PartialInsert, PartialRow, PendingAllocation, ReconcileKind, ReconcileSide, ReconcileStore,
} from '../services/gl/reconcile/types';

export interface MemLine {
  id: string;
  moveId: string;
  accountId: string;
  /** AR/AP للحسابات الرقابية، وnull لغيرها */
  kind: ReconcileKind | null;
  partnerId: string | null;
  debit: bigint;
  credit: bigint;
  date: string;
  dueDate: string | null;
  seq: number;
}

export interface MemMove { id: string; number: string; date: string; reversedMoveId: string | null; lines: MemLine[] }

export interface MemPartial extends PartialInsert { id: string }

export interface MemPending { invoiceId: string; sourceRef: string; creditMoveId: string; amountMilli: bigint }

export class MemReconcileStore implements ReconcileStore {
  moves = new Map<string, MemMove>();
  /** مفتاح POST الأساس ⇒ القيد الحيّ */
  live = new Map<string, string>();
  partials: MemPartial[] = [];
  pending: MemPending[] = [];
  private seq = 0;
  calls: string[] = [];
  /** false ⇒ بلا openLinesOfPartner (كالمخزن المزيّف القديم) */
  withFifo = true;

  addMove(m: {
    id: string; number?: string; date: string; reversedMoveId?: string | null;
    lines: (Omit<MemLine, 'moveId' | 'seq' | 'date' | 'dueDate'> & { date?: string; dueDate?: string | null })[];
  }): MemMove {
    const move: MemMove = {
      id: m.id, number: m.number ?? m.id, date: m.date, reversedMoveId: m.reversedMoveId ?? null,
      lines: m.lines.map((l, i) => ({ ...l, moveId: m.id, seq: i, date: l.date ?? m.date, dueDate: l.dueDate ?? null })),
    };
    this.moves.set(m.id, move);
    return move;
  }

  allLines(): MemLine[] { return [...this.moves.values()].flatMap((m) => m.lines); }

  residual(lineId: string): bigint {
    const l = this.allLines().find((x) => x.id === lineId);
    if (!l) throw new Error(`سطر مجهول ${lineId}`);
    const amt = l.debit > 0n ? l.debit : l.credit;
    return amt - this.partials.filter((p) => p.debitLineId === lineId || p.creditLineId === lineId).reduce((a, p) => a + p.amountMilli, 0n);
  }

  private open(l: MemLine): OpenControlLine | null {
    if (!l.kind || !l.partnerId) return null;
    const debit = l.debit > 0n;
    const amountMilli = debit ? l.debit : l.credit;
    if (amountMilli === 0n) return null;
    return {
      lineId: l.id, moveId: l.moveId, accountId: l.accountId, kind: l.kind, partnerId: l.partnerId,
      side: debit ? 'DEBIT' : 'CREDIT', amountMilli, residualMilli: this.residual(l.id), date: l.date, dueDate: l.dueDate, seq: l.seq,
    };
  }

  async controlLinesOfMove(moveId: string, kind: ReconcileKind): Promise<OpenControlLine[]> {
    this.calls.push(`controlLinesOfMove:${moveId}:${kind}`);
    const m = this.moves.get(moveId);
    if (!m) return [];
    return m.lines.filter((l) => l.kind === kind).map((l) => this.open(l)).filter((x): x is OpenControlLine => !!x);
  }
  async liveMoveIdOf(baseKey: string): Promise<string | null> {
    this.calls.push(`liveMoveIdOf:${baseKey}`);
    return this.live.get(baseKey) ?? null;
  }
  async pendingAllocationsForInvoice(invoiceId: string): Promise<PendingAllocation[]> {
    this.calls.push(`pending:${invoiceId}`);
    return this.pending
      .filter((p) => p.invoiceId === invoiceId)
      .map((p) => ({
        sourceRef: p.sourceRef, creditMoveId: p.creditMoveId,
        amountMilli: p.amountMilli - this.partials.filter((x) => x.sourceRef === p.sourceRef).reduce((a, x) => a + x.amountMilli, 0n),
      }))
      .filter((p) => p.amountMilli > 0n);
  }
  async partialsOfMoves(moveIds: string[]): Promise<PartialRow[]> {
    const ids = new Set(moveIds);
    return this.partials
      .filter((p) => ids.has(p.debitMoveId) || ids.has(p.creditMoveId))
      .map((p) => ({ id: p.id, debitLineId: p.debitLineId, creditLineId: p.creditLineId, amountMilli: p.amountMilli, sourceRef: p.sourceRef }));
  }
  async insertPartials(rows: readonly PartialInsert[]): Promise<number> {
    let n = 0;
    for (const r of rows) {
      if (r.amountMilli <= 0n) throw new Error('مطابقة بمبلغ غير موجب');
      if (this.partials.some((p) => p.sourceRef === r.sourceRef && p.debitLineId === r.debitLineId && p.creditLineId === r.creditLineId)) continue;
      // ثابت القاعدة: لا يتجاوز مجموع المطابقات مبلغ أيّ سطر
      this.partials.push({ id: `p${++this.seq}`, ...r });
      if (this.residual(r.debitLineId) < 0n || this.residual(r.creditLineId) < 0n) throw new Error(`مطابقة فوق المتبقّي ${r.sourceRef}`);
      n++;
    }
    return n;
  }
  async deletePartials(ids: readonly string[]): Promise<number> {
    const s = new Set(ids);
    const before = this.partials.length;
    this.partials = this.partials.filter((p) => !s.has(p.id));
    return before - this.partials.length;
  }
  openLinesOfPartner?: (kind: ReconcileKind, partnerId: string, side: ReconcileSide) => Promise<OpenControlLine[]> =
    async (kind, partnerId, side) => {
      if (!this.withFifo) return [];
      return this.allLines()
        .map((l) => (l.kind === kind && l.partnerId === partnerId ? this.open(l) : null))
        .filter((x): x is OpenControlLine => !!x && x.side === side && x.residualMilli > 0n)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
    };
}

export const M = (x: number | string): bigint => {
  const s = typeof x === 'number' ? x.toFixed(3) : x;
  const [i, f = ''] = s.split('.');
  const neg = i.startsWith('-');
  const v = BigInt(i.replace('-', '')) * 1000n + BigInt((f + '000').slice(0, 3));
  return neg ? -v : v;
};
