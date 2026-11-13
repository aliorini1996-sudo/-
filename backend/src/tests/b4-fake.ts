// «ربط الدفاتر» L1 (B4) — قاعدة مزيّفة في الذاكرة لاختبارات الشراء النقدي/الآجل في المستودع (b4-*.test.ts): جداول المستودع
// والموردين وسندات الصرف وكشف المورّد صفوفاً، وفلاتر Prisma التي تستعملها المسارات والخدمات (المساواة، in، not، المقارنات، OR)،
// وselect/include بالعلاقات. المعاملة لقطةٌ تُستعاد عند الرمي (لا نصف حركة). والأقفال الخام تُسجَّل وتُجاب من الصفوف. لا قاعدة
// ولا شبكة. ليس ملف اختبار (لا .test.ts).
import { Prisma } from '@prisma/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;

type Table = 'tenant' | 'admin' | 'companySettings' | 'product' | 'productUnit' | 'salesRep' | 'glVendor' | 'warehouseEntry'
  | 'warehouseEntryItem' | 'warehouseEntryAttachment' | 'supplierLedgerEntry' | 'supplierPayment' | 'supplierPaymentAllocation' | 'importBatch';

/** أعمدة الافتراض لكل جدول كما في schema.prisma — ما لا يُكتب يُقرأ بافتراضه */
const DEFAULTS: Partial<Record<Table, () => Row>> = {
  warehouseEntry: () => ({
    type: 'RECEIVE', note: null, zeroRunId: null, supplier: null, vendorId: null, source: 'MANUAL', paymentMode: null, paidAccountRef: null,
    supplierRef: null, billDate: null, dueDate: null, costsIncludeTax: false, vatTreatment: null, reason: null, status: 'POSTED',
    returnOfEntryId: null, netMilli: null, taxMilli: null, totalMilli: null, createdBy: null, clientRef: null,
  }),
  warehouseEntryItem: () => ({ unitName: null, unitFactor: 1, baseQty: null, unitCost: null, taxPct: null, enteredUnitCost: null, expiresAt: null, lotId: null, lineRef: null }),
  supplierLedgerEntry: () => ({ netMilli: null, taxMilli: null, warehouseEntryId: null, supplierPaymentId: null, reversesId: null, dueDate: null, ref: null, note: null, createdBy: null }),
  supplierPayment: () => ({ salesRepId: null, reference: null, note: null, status: 'POSTED', cancelledAt: null, cancelledBy: null, cancelReason: null, autoForEntryId: null, clientRef: null, createdBy: null }),
  glVendor: () => ({ nameEn: null, code: null, vatNumber: null, paymentDays: null, isActive: true, countryCode: 'SA' }),
  product: () => ({ code: null, unit: 'حبة', taxPct: 15, status: 'ACTIVE', deletedAt: null, baseConvertedAt: null, primaryUnitId: null, lotTracked: false, lotTrackedSince: null, shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null }),
};

const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
const cmp = (a: any, b: any): number => (a instanceof Date ? a.getTime() : a) - (b instanceof Date ? b.getTime() : b);

/** شرط عمودٍ واحد كما في Prisma: قيمة، أو {in, notIn, not, lt, lte, gt, gte, startsWith} */
function fieldMatch(v: unknown, cond: unknown): boolean {
  if (!isObj(cond)) return cond === null ? v == null : same(v, cond);
  for (const [op, x] of Object.entries(cond)) {
    if (x === undefined) continue;
    switch (op) {
      case 'in': if (!(x as unknown[]).some((y) => same(v, y))) return false; break;
      case 'notIn': if ((x as unknown[]).some((y) => same(v, y))) return false; break;
      case 'not': if (isObj(x) ? fieldMatch(v, x) : x === null ? v == null : same(v, x)) return false; break;
      case 'lt': if (!(v != null && cmp(v, x) < 0)) return false; break;
      case 'lte': if (!(v != null && cmp(v, x) <= 0)) return false; break;
      case 'gt': if (!(v != null && cmp(v, x) > 0)) return false; break;
      case 'gte': if (!(v != null && cmp(v, x) >= 0)) return false; break;
      case 'startsWith': if (!(typeof v === 'string' && v.startsWith(String(x)))) return false; break;
      // علاقة متعدّدة مزروعة مصفوفةً في الصفّ (نطاق المستخدم: salesRep.adminScopes) — صفٌّ واحد يطابق شروطه المسطّحة
      case 'some': if (!(Array.isArray(v) && v.some((y) => isObj(y) && Object.entries(x as Row).every(([k, c]) => fieldMatch((y as Row)[k], c))))) return false; break;
      default: throw new Error(`فلتر غير مدعوم في القاعدة المزيّفة: ${op}`);
    }
  }
  return true;
}

export interface Call { op: string; sql?: string; values?: unknown[]; args?: unknown }

export class Store {
  t: Record<Table, Row[]> = {
    tenant: [], admin: [], companySettings: [], product: [], productUnit: [], salesRep: [], glVendor: [], warehouseEntry: [],
    warehouseEntryItem: [], warehouseEntryAttachment: [], supplierLedgerEntry: [], supplierPayment: [], supplierPaymentAllocation: [], importBatch: [],
  };
  calls: Call[] = [];
  private clock = Date.parse('2026-11-13T07:00:00Z');
  private seq = 0;

  /** عالمٌ فارغ بالعميل نفسه (المسار مقيَّدٌ بـdb واحد عبر stub) */
  reset(): void {
    for (const k of Object.keys(this.t) as Table[]) this.t[k] = [];
    this.calls = [];
    this.clock = Date.parse('2026-11-13T07:00:00Z');
    this.seq = 0;
  }

  now(): Date { this.clock += 1000; return new Date(this.clock); }
  id(p: string): string { return `${p}${++this.seq}`; }

  add(table: Table, row: Row): Row {
    const r: Row = { ...(DEFAULTS[table]?.() ?? {}), id: row.id ?? this.id(table.slice(0, 2)), ...row };
    if (!('createdAt' in r) && table !== 'tenant' && table !== 'companySettings') r.createdAt = this.now();
    if (table === 'warehouseEntry' || table === 'supplierPayment') r.updatedAt = r.updatedAt ?? r.createdAt;
    this.t[table].push(r);
    return r;
  }

  /** علاقات كل جدول: الاسم ⇒ (الصفّ) ⇒ صفوف أو صفّ */
  private rel(table: Table, name: string, row: Row): { table: Table; rows: Row[]; many: boolean } {
    const T = this.t;
    switch (`${table}.${name}`) {
      case 'warehouseEntry.items': return { table: 'warehouseEntryItem', rows: T.warehouseEntryItem.filter((i) => i.entryId === row.id), many: true };
      case 'warehouseEntry.vendor': return { table: 'glVendor', rows: T.glVendor.filter((v) => v.id === row.vendorId), many: false };
      case 'warehouseEntry.attachments': return { table: 'warehouseEntryAttachment', rows: T.warehouseEntryAttachment.filter((a) => a.entryId === row.id), many: true };
      case 'warehouseEntryItem.product': return { table: 'product', rows: T.product.filter((p) => p.id === row.productId), many: false };
      case 'warehouseEntryItem.lot': return { table: 'product', rows: [], many: false };
      case 'warehouseEntryItem.entry': return { table: 'warehouseEntry', rows: T.warehouseEntry.filter((e) => e.id === row.entryId), many: false };
      case 'product.units': return { table: 'productUnit', rows: T.productUnit.filter((u) => u.productId === row.id), many: true };
      case 'supplierPayment.allocations': return { table: 'supplierPaymentAllocation', rows: T.supplierPaymentAllocation.filter((a) => a.paymentId === row.id), many: true };
      default: throw new Error(`علاقة غير معروفة: ${table}.${name}`);
    }
  }

  match(table: Table, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === 'OR') { if (!(cond as Row[]).some((w) => this.match(table, row, w))) return false; continue; }
      if (k === 'AND') { if (!(cond as Row[]).every((w) => this.match(table, row, w))) return false; continue; }
      if (k === 'NOT') { if (this.match(table, row, cond as Row)) return false; continue; }
      if (!(k in row) && isObj(cond) && !('in' in cond || 'not' in cond || 'lt' in cond || 'lte' in cond || 'gt' in cond || 'gte' in cond)) {
        // فلتر علاقة: entry: { tenantId } — صفّ العلاقة الواحد يطابق
        const r = this.rel(table, k, row);
        if (!r.rows.some((x) => this.match(r.table, x, cond))) return false;
        continue;
      }
      if (!fieldMatch(row[k], cond)) return false;
    }
    return true;
  }

  project(table: Table, row: Row, args: { select?: Row; include?: Row }): Row {
    if (args.select) {
      const out: Row = {};
      for (const [k, v] of Object.entries(args.select)) {
        if (!v) continue;
        if (k === '_count') { out._count = this.count(table, row, (v as Row).select); continue; }
        if (this.isRel(table, k)) out[k] = this.relValue(table, k, row, v === true ? {} : v as Row);
        else out[k] = row[k] ?? null;
      }
      return out;
    }
    const out: Row = { ...row };
    for (const [k, v] of Object.entries(args.include ?? {})) {
      if (!v) continue;
      if (k === '_count') { out._count = this.count(table, row, (v as Row).select); continue; }
      out[k] = this.relValue(table, k, row, v === true ? {} : v as Row);
    }
    return out;
  }

  private isRel(table: Table, k: string): boolean {
    try { this.rel(table, k, {}); return true; } catch { return false; }
  }

  private relValue(table: Table, k: string, row: Row, a: Row): unknown {
    const r = this.rel(table, k, row);
    const rows = r.rows.filter((x) => this.match(r.table, x, a.where));
    const proj = rows.map((x) => this.project(r.table, x, a));
    return r.many ? proj : proj[0] ?? null;
  }

  private count(table: Table, row: Row, sel: Row): Row {
    const out: Row = {};
    for (const k of Object.keys(sel)) out[k] = this.rel(table, k, row).rows.length;
    return out;
  }

  private order(rows: Row[], orderBy: unknown): Row[] {
    const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Row[];
    if (!keys.length) return rows;
    return [...rows].sort((a, b) => {
      for (const o of keys) {
        const [k, dir] = Object.entries(o)[0];
        const c = a[k] == null && b[k] == null ? 0 : a[k] == null ? -1 : b[k] == null ? 1 : typeof a[k] === 'string' ? (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) : cmp(a[k], b[k]);
        if (c) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  private createRow(table: Table, data: Row): Row {
    const scalars: Row = {};
    const nested: [string, Row][] = [];
    for (const [k, v] of Object.entries(data)) {
      if (isObj(v) && 'create' in v) nested.push([k, v]);
      else if (v !== undefined) scalars[k] = v;
    }
    const row = this.add(table, scalars);
    for (const [k, v] of nested) {
      if (`${table}.${k}` !== 'warehouseEntry.items') throw new Error(`إنشاء متداخل غير مدعوم: ${table}.${k}`);
      for (const it of v.create as Row[]) this.add('warehouseEntryItem', { ...it, entryId: row.id });
    }
    return row;
  }

  /** عميل القاعدة/المعاملة المزيّف */
  get db(): Row {
    const s = this;
    const log = (op: string, extra: Omit<Call, 'op'> = {}) => { s.calls.push({ op, ...extra }); };
    const delegate = (table: Table): Row => ({
      findFirst: async (a: Row = {}) => {
        log(`${table}.findFirst`, { args: a });
        const r = s.order(s.t[table].filter((x) => s.match(table, x, a.where)), a.orderBy)[0];
        return r ? s.project(table, r, a) : null;
      },
      findUnique: async (a: Row = {}) => {
        log(`${table}.findUnique`, { args: a });
        const r = s.t[table].find((x) => s.match(table, x, a.where));
        return r ? s.project(table, r, a) : null;
      },
      findMany: async (a: Row = {}) => {
        log(`${table}.findMany`, { args: a });
        let rows = s.order(s.t[table].filter((x) => s.match(table, x, a.where)), a.orderBy);
        if (a.take) rows = rows.slice(0, a.take);
        return rows.map((r) => s.project(table, r, a));
      },
      count: async (a: Row = {}) => { log(`${table}.count`, { args: a }); return s.t[table].filter((x) => s.match(table, x, a.where)).length; },
      create: async (a: Row) => {
        log(`${table}.create`, { args: a });
        const row = s.createRow(table, a.data);
        return s.project(table, row, a);
      },
      createMany: async (a: Row) => {
        log(`${table}.createMany`, { args: a });
        for (const d of a.data as Row[]) s.createRow(table, d);
        return { count: (a.data as Row[]).length };
      },
      update: async (a: Row) => {
        log(`${table}.update`, { args: a });
        const r = s.t[table].find((x) => s.match(table, x, a.where));
        if (!r) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
        Object.assign(r, a.data);
        if ('updatedAt' in r) r.updatedAt = s.now();
        return s.project(table, r, a);
      },
      updateMany: async (a: Row) => {
        log(`${table}.updateMany`, { args: a });
        const rows = s.t[table].filter((x) => s.match(table, x, a.where));
        for (const r of rows) { Object.assign(r, a.data); if ('updatedAt' in r) r.updatedAt = s.now(); }
        return { count: rows.length };
      },
      aggregate: async (a: Row) => {
        const rows = s.t[table].filter((x) => s.match(table, x, a.where));
        const sum: Row = {};
        for (const k of Object.keys(a._sum ?? {})) sum[k] = rows.reduce((acc, r) => acc + (r[k] ?? 0n), 0n);
        return { _sum: sum };
      },
      groupBy: async (a: Row) => {
        const rows = s.t[table].filter((x) => s.match(table, x, a.where));
        const g = new Map<string, Row[]>();
        for (const r of rows) { const k = (a.by as string[]).map((b) => r[b]).join('|'); g.set(k, [...(g.get(k) ?? []), r]); }
        return [...g.values()].map((rs) => ({
          ...Object.fromEntries((a.by as string[]).map((b) => [b, rs[0][b]])),
          ...(a._sum && { _sum: Object.fromEntries(Object.keys(a._sum).map((k) => [k, rs.reduce((acc, r) => acc + (r[k] ?? 0n), 0n)])) }),
          ...(a._count && { _count: { _all: rs.length } }),
        }));
      },
    });
    const render = (strings: TemplateStringsArray, values: unknown[]) => {
      const q = Prisma.sql(strings, ...(values as Prisma.Sql[]));
      return { sql: q.text.replace(/\s+/g, ' ').trim(), values: q.values };
    };
    const client: Row = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const r = render(strings, values);
        log('query', r);
        if (r.sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '0' }];
        if (r.sql.includes('FROM products') && r.sql.includes('FOR KEY SHARE')) {
          const ids = (r.values.find((v) => Array.isArray(v)) ?? []) as string[];
          return s.t.product.filter((p) => p.tenantId === r.values[0] && ids.includes(p.id))
            .map((p) => ({ id: p.id, unit: p.unit, lotTracked: p.lotTracked, lotTrackedSince: p.lotTrackedSince }));
        }
        if (r.sql.includes('FROM warehouse_entries WHERE id =')) {
          return s.t.warehouseEntry.filter((e) => e.id === r.values[0] && e.tenantId === r.values[1]).map((e) => ({ id: e.id }));
        }
        if (r.sql.includes('FROM warehouse_entries WHERE "tenantId" =')) {
          const ids = r.values[1] as string[];
          return s.t.warehouseEntry.filter((e) => e.tenantId === r.values[0] && ids.includes(e.id)).map((e) => ({ id: e.id })).sort((a, b) => (a.id < b.id ? -1 : 1));
        }
        if (r.sql.includes('FROM supplier_payments WHERE id =')) {
          return s.t.supplierPayment.filter((p) => p.id === r.values[0] && p.tenantId === r.values[1]).map((p) => ({ id: p.id }));
        }
        throw new Error(`استعلامٌ غير متوقَّع: ${r.sql}`);
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { log('exec', render(strings, values)); return 1; },
      $transaction: async (fn: (tx: Row) => Promise<unknown>) => {
        log('tx.begin');
        const snap = structuredClone(s.t);
        try {
          const out = await fn(client);
          log('tx.commit');
          return out;
        } catch (e) {
          s.t = snap;
          log('tx.rollback');
          throw e;
        }
      },
      glSettings: { findUnique: async () => null },
    };
    for (const table of Object.keys(s.t) as Table[]) client[table] = delegate(table);
    return client;
  }

  // ═══ قراءات الاختبار ═══
  entries(where: Row = {}): Row[] { return this.t.warehouseEntry.filter((e) => this.match('warehouseEntry', e, where)); }
  itemsOf(entryId: string): Row[] { return this.t.warehouseEntryItem.filter((i) => i.entryId === entryId); }
  ledger(where: Row = {}): Row[] { return this.t.supplierLedgerEntry.filter((l) => this.match('supplierLedgerEntry', l, where)); }
  balanceMilli(vendorId: string): bigint { return this.ledger({ vendorId }).reduce((a, l) => a + (l.amountMilli as bigint), 0n); }
}
