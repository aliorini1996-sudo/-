// «ربط الدفاتر» L1 (B3a) — قاعدة مزيّفة في الذاكرة لاختبارات services/suppliers/payments.ts وstatement.ts.
// جداول صفوفاً، وwhere/orderBy/select/aggregate/groupBy بدلالة Prisma (ومنها { not: X } يستبعد NULL كما في SQL)، والقيد الفريد
// [tenantId, number] على السندات يرمي P2002، و$queryRaw يجيب أقفال FOR UPDATE من الصفوف نفسها مرتّبةً بالمعرّف، و$executeRaw يسجّل
// الأقفال الاستشارية. tx() معاملةٌ تُستعاد لقطتها عند الرمي (لا نصف سند). لا قاعدة ولا شبكة. ليس ملف اختبار: يستورده الملفان.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;

export interface Call { op: string; sql?: string; values?: unknown[] }

const TABLES = [
  'glVendor', 'salesRep', 'warehouseEntry', 'supplierPayment', 'supplierPaymentAllocation', 'supplierLedgerEntry',
  'warehouseEntryAttachment', 'glSettings', 'companySettings',
] as const;
type Table = (typeof TABLES)[number];

const DEFAULTS: Partial<Record<Table, Row>> = {
  supplierPayment: { status: 'POSTED', salesRepId: null, reference: null, note: null, cancelledAt: null, cancelledBy: null, cancelReason: null, autoForEntryId: null, clientRef: null, createdBy: null },
  supplierLedgerEntry: { netMilli: null, taxMilli: null, warehouseEntryId: null, supplierPaymentId: null, reversesId: null, dueDate: null, ref: null, note: null, createdBy: null },
  warehouseEntry: { type: 'RECEIVE', vendorId: null, paymentMode: null, status: 'POSTED', supplierRef: null, billDate: null, dueDate: null, totalMilli: null, returnOfEntryId: null },
  glVendor: { nameEn: null, code: null, vatNumber: null, crNumber: null, phone: null, email: null, address: null, city: null, countryCode: 'SA', iban: null, bankName: null, paymentDays: null, isActive: true, notes: null },
};

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function cmp(a: any, b: any): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

export function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (k === 'OR') { if (!(cond as Row[]).some((w) => matchWhere(row, w))) return false; continue; }
    if (k === 'AND') { if (!(cond as Row[]).every((w) => matchWhere(row, w))) return false; continue; }
    if (k === 'NOT') { if (matchWhere(row, cond as Row)) return false; continue; }
    const v = row[k];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date || typeof cond === 'bigint') {
      if (cond === null ? v != null : !eq(v, cond)) return false;
      continue;
    }
    const c = cond as Row;
    if ('equals' in c && !eq(v, c.equals)) return false;
    if ('in' in c && !(c.in as unknown[]).some((x) => eq(v, x))) return false;
    if ('notIn' in c && (v == null || (c.notIn as unknown[]).some((x) => eq(v, x)))) return false;
    if ('not' in c) {
      if (c.not === null) { if (v == null) return false; } else if (v == null || eq(v, c.not)) return false;
    }
    for (const [op, test] of [['lt', (r: number) => r < 0], ['lte', (r: number) => r <= 0], ['gt', (r: number) => r > 0], ['gte', (r: number) => r >= 0]] as const) {
      if (op in c && (v == null || !test(cmp(v, c[op])))) return false;
    }
  }
  return true;
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const r = cmp(a[k], b[k]);
      if (r) return dir === 'desc' ? -r : r;
    }
    return 0;
  });
}

export class SupplierFakeDb {
  t: Record<Table, Row[]> = Object.fromEntries(TABLES.map((n) => [n, []])) as unknown as Record<Table, Row[]>;
  calls: Call[] = [];
  private clock = Date.parse('2026-11-01T08:00:00Z');
  private seq = 0;

  now(): Date { this.clock += 1000; return new Date(this.clock); }
  id(prefix: string): string { this.seq += 1; return `${prefix}-${String(this.seq).padStart(4, '0')}`; }

  /** يضيف صفاً كما هو (بقيم الجدول الافتراضية) — للبذور */
  seed(table: Table, row: Row): Row {
    const r: Row = { ...(DEFAULTS[table] ?? {}), createdAt: this.now(), ...row };
    if (!r.id && table !== 'glSettings' && table !== 'companySettings') r.id = this.id(table);
    this.t[table].push(r);
    return r;
  }

  private relations(table: Table, row: Row, key: string, sel: Row): unknown {
    if (table === 'supplierPayment' && key === 'allocations') {
      return this.t.supplierPaymentAllocation.filter((a) => a.paymentId === row.id).map((a) => this.project('supplierPaymentAllocation', a, sel.select));
    }
    throw new Error(`fake: علاقة غير مدعومة ${table}.${key}`);
  }

  private project(table: Table, row: Row, select: Row | undefined): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (v === true) out[k] = row[k];
      else if (v && typeof v === 'object') out[k] = this.relations(table, row, k, v as Row);
    }
    return out;
  }

  private delegate(table: Table) {
    const log = (op: string, args: unknown) => this.calls.push({ op: `${table}.${op}`, values: [args] });
    return {
      findMany: async (args: Row = {}) => {
        log('findMany', args);
        let rows = sortRows(this.t[table].filter((r) => matchWhere(r, args.where)), args.orderBy);
        if (args.skip) rows = rows.slice(args.skip);
        if (args.take) rows = rows.slice(0, args.take);
        return rows.map((r) => this.project(table, r, args.select));
      },
      findFirst: async (args: Row = {}) => {
        log('findFirst', args);
        const r = sortRows(this.t[table].filter((x) => matchWhere(x, args.where)), args.orderBy)[0];
        return r ? this.project(table, r, args.select) : null;
      },
      findUnique: async (args: Row = {}) => {
        log('findUnique', args);
        const r = this.t[table].find((x) => matchWhere(x, args.where));
        return r ? this.project(table, r, args.select) : null;
      },
      create: async (args: Row) => {
        log('create', args);
        const row: Row = { ...(DEFAULTS[table] ?? {}), id: this.id(table), createdAt: this.now(), ...args.data };
        if (table === 'supplierPayment' && this.t.supplierPayment.some((p) => p.tenantId === row.tenantId && p.number === row.number)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['tenantId', 'number'] } });
        }
        this.t[table].push(row);
        return this.project(table, row, args.select);
      },
      createMany: async (args: Row) => {
        log('createMany', args);
        for (const d of args.data as Row[]) this.t[table].push({ ...(DEFAULTS[table] ?? {}), id: this.id(table), createdAt: this.now(), ...d });
        return { count: (args.data as Row[]).length };
      },
      updateMany: async (args: Row) => {
        log('updateMany', args);
        let count = 0;
        for (const r of this.t[table]) if (matchWhere(r, args.where)) { Object.assign(r, args.data); count++; }
        return { count };
      },
      aggregate: async (args: Row) => {
        log('aggregate', args);
        const rows = this.t[table].filter((r) => matchWhere(r, args.where));
        const _sum: Row = {};
        for (const k of Object.keys(args._sum ?? {})) _sum[k] = rows.length ? rows.reduce((s, r) => s + (r[k] ?? 0n), 0n) : null;
        return { _sum };
      },
      groupBy: async (args: Row) => {
        log('groupBy', args);
        const by = args.by as string[];
        const groups = new Map<string, Row[]>();
        for (const r of this.t[table].filter((x) => matchWhere(x, args.where))) {
          const key = JSON.stringify(by.map((k) => r[k]));
          groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        return [...groups.values()].map((rows) => {
          const g: Row = {};
          for (const k of by) g[k] = rows[0][k];
          if (args._sum) { g._sum = {}; for (const k of Object.keys(args._sum)) g._sum[k] = rows.reduce((s, r) => s + (r[k] ?? 0n), 0n); }
          if (args._count) g._count = { _all: rows.length };
          return g;
        });
      },
    };
  }

  glVendor = this.delegate('glVendor');
  salesRep = this.delegate('salesRep');
  warehouseEntry = this.delegate('warehouseEntry');
  supplierPayment = this.delegate('supplierPayment');
  supplierPaymentAllocation = this.delegate('supplierPaymentAllocation');
  supplierLedgerEntry = this.delegate('supplierLedgerEntry');
  warehouseEntryAttachment = this.delegate('warehouseEntryAttachment');
  glSettings = this.delegate('glSettings');
  companySettings = this.delegate('companySettings');

  $executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    this.calls.push({ op: '$executeRaw', sql: strings.join('?'), values });
    return 1;
  };

  $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    this.calls.push({ op: '$queryRaw', sql, values });
    if (sql.includes('FROM warehouse_entries') && sql.includes('FOR UPDATE')) {
      const [tenantId, ids] = values as [string, string[]];
      return this.t.warehouseEntry.filter((e) => e.tenantId === tenantId && ids.includes(e.id)).map((e) => ({ id: e.id })).sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    if (sql.includes('FROM supplier_payments') && sql.includes('FOR UPDATE')) {
      const [id, tenantId] = values as [string, string];
      return this.t.supplierPayment.filter((p) => p.id === id && p.tenantId === tenantId).map((p) => ({ id: p.id }));
    }
    throw new Error(`fake: SQL غير متوقّع ${sql}`);
  };

  /** معاملة: تُستعاد اللقطة عند الرمي */
  async tx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const snap = Object.fromEntries(TABLES.map((n) => [n, this.t[n].map((r) => ({ ...r }))])) as Record<Table, Row[]>;
    this.calls.push({ op: 'tx.begin' });
    try {
      const out = await fn(this);
      this.calls.push({ op: 'tx.commit' });
      return out;
    } catch (e) {
      this.t = snap;
      this.calls.push({ op: 'tx.rollback' });
      throw e;
    }
  }

  /** عدد استعلامات القراءة/الكتابة (لا N+1) */
  queryCount(): number {
    return this.calls.filter((c) => c.op !== 'tx.begin' && c.op !== 'tx.commit' && c.op !== 'tx.rollback').length;
  }
}

export const day = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
/** وحدة عملة ⇐ ملّي */
export const m = (x: number): bigint => BigInt(Math.round(x * 1000));
