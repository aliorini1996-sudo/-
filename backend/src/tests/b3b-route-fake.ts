// «ربط الدفاتر» L1 (B3b) — عميل Prisma مزيّف في الذاكرة لاختبارات مسارَي /api/suppliers و/api/supplier-payments عبر Express الحقيقي.
// جداول صفوفاً، وwhere/orderBy/skip/take/select (بعلاقات السند والمفتاح) وcount/aggregate/groupBy بدلالة Prisma: { not: X } يستبعد
// NULL كما في SQL، وmode:'insensitive' في equals/contains، و{ some } على حقول مصفوفة (نطاق المستخدم). القيد الفريد [tenantId, number]
// على السندات يرمي P2002، وحذف مورّدٍ يشير إليه صفٌّ بمفتاحٍ أجنبي يرمي P2003 (NoAction)، و$queryRaw يجيب أقفال FOR UPDATE من الصفوف
// نفسها، و$executeRaw يسجّل الأقفال الاستشارية، و$transaction يستعيد لقطته عند الرمي (لا نصف كتابة). لا قاعدة ولا شبكة.
// ليس ملف اختبار: يستورده b3b-supplier-routes.test.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;

export interface Call { op: string; args?: unknown; inTx: boolean }

export const TABLES = [
  'tenant', 'admin', 'apiKey', 'companySettings', 'glSettings', 'glVendor', 'salesRep', 'warehouseEntry', 'warehouseEntryAttachment',
  'supplierPayment', 'supplierPaymentAllocation', 'supplierLedgerEntry', 'glMove', 'glMoveLine',
] as const;
export type Table = (typeof TABLES)[number];

const DEFAULTS: Partial<Record<Table, Row>> = {
  supplierPayment: { status: 'POSTED', salesRepId: null, reference: null, note: null, cancelledAt: null, cancelledBy: null, cancelReason: null, autoForEntryId: null, clientRef: null, createdBy: null },
  supplierLedgerEntry: { netMilli: null, taxMilli: null, warehouseEntryId: null, supplierPaymentId: null, reversesId: null, dueDate: null, ref: null, note: null, createdBy: null },
  warehouseEntry: { type: 'RECEIVE', vendorId: null, paymentMode: null, status: 'POSTED', supplierRef: null, billDate: null, dueDate: null, totalMilli: null, returnOfEntryId: null },
  glVendor: { nameEn: null, code: null, vatNumber: null, crNumber: null, phone: null, email: null, address: null, city: null, countryCode: 'SA', iban: null, bankName: null, paymentDays: null, isActive: true, notes: null },
};

/** العلاقات التي تقرؤها المسارات والمصادقة: الجدول والمفتاحان، ومتعدّدة أم مفردة */
const RELATIONS: Partial<Record<Table, Record<string, { table: Table; local: string; foreign: string; many?: boolean }>>> = {
  supplierPayment: {
    vendor: { table: 'glVendor', local: 'vendorId', foreign: 'id' },
    allocations: { table: 'supplierPaymentAllocation', local: 'id', foreign: 'paymentId', many: true },
  },
  apiKey: {
    admin: { table: 'admin', local: 'adminId', foreign: 'id' },
    tenant: { table: 'tenant', local: 'tenantId', foreign: 'id' },
  },
};

/** مراجع المورّد بمفتاحٍ أجنبي NoAction — حذفه وهي قائمة يرمي P2003 كالقاعدة */
const VENDOR_FK: readonly Table[] = ['warehouseEntry', 'supplierLedgerEntry', 'supplierPayment'];

function eq(a: unknown, b: unknown, insensitive = false): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (insensitive && typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
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
    if ('some' in c) { if (!Array.isArray(v) || !v.some((x: Row) => matchWhere(x, c.some))) return false; continue; }
    const ins = c.mode === 'insensitive';
    if ('equals' in c && !eq(v, c.equals, ins)) return false;
    if ('in' in c && !(c.in as unknown[]).some((x) => eq(v, x, ins))) return false;
    if ('notIn' in c && (v == null || (c.notIn as unknown[]).some((x) => eq(v, x, ins)))) return false;
    if ('not' in c) {
      if (c.not === null) { if (v == null) return false; } else if (v == null || eq(v, c.not, ins)) return false;
    }
    if ('contains' in c) {
      if (typeof v !== 'string') return false;
      const hay = ins ? v.toLowerCase() : v;
      const needle = ins ? String(c.contains).toLowerCase() : String(c.contains);
      if (!hay.includes(needle)) return false;
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
      const r = typeof a[k] === 'string' && typeof b[k] === 'string' ? a[k].localeCompare(b[k], 'ar') : cmp(a[k], b[k]);
      if (r) return dir === 'desc' ? -r : r;
    }
    return 0;
  });
}

const prismaError = (code: string, message: string) => Object.assign(new Error(message), { code });

export class RouteFakeDb {
  t: Record<Table, Row[]> = Object.fromEntries(TABLES.map((n) => [n, []])) as unknown as Record<Table, Row[]>;
  calls: Call[] = [];
  inTx = false;
  private clock = Date.parse('2026-11-01T08:00:00Z');
  private seq = 0;

  reset(): void {
    this.t = Object.fromEntries(TABLES.map((n) => [n, []])) as unknown as Record<Table, Row[]>;
    this.calls = [];
    this.inTx = false;
  }

  now(): Date { this.clock += 1000; return new Date(this.clock); }
  id(prefix: string): string { this.seq += 1; return `${prefix}-${String(this.seq).padStart(4, '0')}`; }

  /** يضيف صفاً كما هو (بقيم الجدول الافتراضية) — للبذور، بلا تسجيل استدعاء */
  seed(table: Table, row: Row): Row {
    const r: Row = { ...(DEFAULTS[table] ?? {}), createdAt: this.now(), ...row };
    if (!r.id && table !== 'glSettings' && table !== 'companySettings') r.id = this.id(table);
    this.t[table].push(r);
    return r;
  }

  private project(table: Table, row: Row, select: Row | undefined): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (v === true) { out[k] = row[k]; continue; }
      if (!v || typeof v !== 'object') continue;
      const rel = RELATIONS[table]?.[k];
      if (!rel) throw new Error(`fake: علاقة غير مدعومة ${table}.${k}`);
      const related = this.t[rel.table].filter((x) => x[rel.foreign] === row[rel.local]);
      if (rel.many) {
        out[k] = sortRows(related.filter((x) => matchWhere(x, (v as Row).where)), (v as Row).orderBy).map((x) => this.project(rel.table, x, (v as Row).select));
      } else {
        out[k] = related[0] ? this.project(rel.table, related[0], (v as Row).select) : null;
      }
    }
    return out;
  }

  private delegate(table: Table) {
    const log = (op: string, args: unknown) => this.calls.push({ op: `${table}.${op}`, args, inTx: this.inTx });
    const pick = (args: Row) => args.select ?? args.include;
    return {
      findMany: async (args: Row = {}) => {
        log('findMany', args);
        let rows = sortRows(this.t[table].filter((r) => matchWhere(r, args.where)), args.orderBy);
        if (args.skip) rows = rows.slice(args.skip);
        if (args.take) rows = rows.slice(0, args.take);
        return rows.map((r) => this.project(table, r, pick(args)));
      },
      findFirst: async (args: Row = {}) => {
        log('findFirst', args);
        const r = sortRows(this.t[table].filter((x) => matchWhere(x, args.where)), args.orderBy)[0];
        return r ? this.project(table, r, pick(args)) : null;
      },
      findUnique: async (args: Row = {}) => {
        log('findUnique', args);
        const r = this.t[table].find((x) => matchWhere(x, args.where));
        return r ? this.project(table, r, pick(args)) : null;
      },
      count: async (args: Row = {}) => {
        log('count', args);
        return this.t[table].filter((r) => matchWhere(r, args.where)).length;
      },
      create: async (args: Row) => {
        log('create', args);
        const at = this.now();
        const row: Row = { ...(DEFAULTS[table] ?? {}), id: this.id(table), createdAt: at, ...(table === 'glVendor' || table === 'supplierPayment' ? { updatedAt: at } : {}), ...args.data };
        if (table === 'supplierPayment' && this.t.supplierPayment.some((p) => p.tenantId === row.tenantId && p.number === row.number)) {
          throw prismaError('P2002', 'Unique constraint failed on the fields: (`tenantId`,`number`)');
        }
        this.t[table].push(row);
        return this.project(table, row, pick(args));
      },
      createMany: async (args: Row) => {
        log('createMany', args);
        const at = this.now();
        for (const d of args.data as Row[]) this.t[table].push({ ...(DEFAULTS[table] ?? {}), id: this.id(table), createdAt: at, ...d });
        return { count: (args.data as Row[]).length };
      },
      updateMany: async (args: Row) => {
        log('updateMany', args);
        let count = 0;
        const at = this.now();
        for (const r of this.t[table]) {
          if (!matchWhere(r, args.where)) continue;
          Object.assign(r, args.data, table === 'glVendor' || table === 'supplierPayment' ? { updatedAt: at } : {});
          count++;
        }
        return { count };
      },
      deleteMany: async (args: Row) => {
        log('deleteMany', args);
        const doomed = this.t[table].filter((r) => matchWhere(r, args.where));
        if (table === 'glVendor') {
          for (const v of doomed) {
            for (const ref of VENDOR_FK) {
              if (this.t[ref].some((x) => x.vendorId === v.id)) throw prismaError('P2003', `Foreign key constraint failed on the field: \`${ref}_vendorId_fkey\``);
            }
          }
        }
        this.t[table] = this.t[table].filter((r) => !doomed.includes(r));
        return { count: doomed.length };
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

  tenant = this.delegate('tenant');
  admin = this.delegate('admin');
  apiKey = this.delegate('apiKey');
  companySettings = this.delegate('companySettings');
  glSettings = this.delegate('glSettings');
  glVendor = this.delegate('glVendor');
  salesRep = this.delegate('salesRep');
  warehouseEntry = this.delegate('warehouseEntry');
  warehouseEntryAttachment = this.delegate('warehouseEntryAttachment');
  supplierPayment = this.delegate('supplierPayment');
  supplierPaymentAllocation = this.delegate('supplierPaymentAllocation');
  supplierLedgerEntry = this.delegate('supplierLedgerEntry');
  glMove = this.delegate('glMove');
  glMoveLine = this.delegate('glMoveLine');

  $executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    this.calls.push({ op: '$executeRaw', args: { sql: strings.join('?'), values }, inTx: this.inTx });
    return 1;
  };

  $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    this.calls.push({ op: '$queryRaw', args: { sql, values }, inTx: this.inTx });
    if (sql.includes('FROM warehouse_entries') && sql.includes('FOR UPDATE')) {
      const [tenantId, ids] = values as [string, string[]];
      return this.t.warehouseEntry.filter((e) => e.tenantId === tenantId && ids.includes(e.id)).map((e) => ({ id: e.id })).sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    if (sql.includes('FROM supplier_payments') && sql.includes('FOR UPDATE')) {
      const [id, tenantId] = values as [string, string];
      return this.t.supplierPayment.filter((p) => p.id === id && p.tenantId === tenantId).map((p) => ({ id: p.id }));
    }
    if (sql.includes('FROM gl_vendors') && sql.includes('FOR UPDATE')) {
      const [id, tenantId] = values as [string, string];
      return this.t.glVendor.filter((v) => v.id === id && v.tenantId === tenantId).map((v) => ({ id: v.id }));
    }
    throw new Error(`fake: SQL غير متوقّع ${sql}`);
  };

  /** معاملة Prisma: دالّة (تُستعاد اللقطة عند الرمي) أو مصفوفة وعود */
  $transaction = async (arg: unknown, _opts?: unknown): Promise<any> => {
    if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
    const snap = Object.fromEntries(TABLES.map((n) => [n, this.t[n].map((r) => ({ ...r }))])) as Record<Table, Row[]>;
    this.calls.push({ op: 'tx.begin', inTx: true });
    this.inTx = true;
    try {
      const out = await (arg as (tx: unknown) => Promise<unknown>)(this);
      this.calls.push({ op: 'tx.commit', inTx: true });
      return out;
    } catch (e) {
      this.t = snap;
      this.calls.push({ op: 'tx.rollback', inTx: true });
      throw e;
    } finally {
      this.inTx = false;
    }
  };

  /** عمليات الكتابة المسجّلة (الجدول.العملية) */
  writes(): string[] {
    return this.calls.map((c) => c.op).filter((o) => /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)$/.test(o));
  }

  /** عدد استعلامات القاعدة (لا N+1) — بلا علامات المعاملة */
  queries(): number {
    return this.calls.filter((c) => !c.op.startsWith('tx.')).length;
  }
}

export const day = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
/** وحدة عملة ⇐ ملّي */
export const m = (x: number): bigint => BigInt(Math.round(x * 1000));
