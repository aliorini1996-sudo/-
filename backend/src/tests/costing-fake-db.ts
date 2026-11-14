/**
 * قاعدة مزيّفة في الذاكرة لمحرّك التكلفة (services/costing/streams.ts وsnapshots.ts) — «ربط الدفاتر» L3، العقد §6–§7.
 *
 * محرّك استعلامٍ صغير عامّ بقدر ما تستعمله الوحدتان (ويستعمله C3 للتفاضلي والأداء): where بالمساواة وin/not/gt/gte/lt/lte
 * وOR/AND/NOT وفلاتر العلاقات الأحادية (entry/vanLoad/invoice)، وorderBy بحقول العلاقة، وselect متداخل، وtake؛
 * وcreateMany بقيود التفرّد (skipDuplicates)، وdeleteMany/count/findFirst، و$executeRaw/$queryRaw (القفل وSELECT now())،
 * و$transaction بتراجعٍ لجداول gl_cost_* عند الرمي.
 *
 * التجسّس: كل عملية تُسجَّل في `ops` (النموذج، العملية، رقم المعاملة) — فيُثبت الاختبار «لا كتابة إلا gl_cost_*» وترتيب
 * العبارات داخل المعاملة (القفل أولاً، والرأس آخراً).
 *
 * بُناة البيانات (addReceipt/addVanLoad/addInvoice/…) يولّدون معرّفات قابلة للترتيب ولحظاتٍ متزايدة (ساعة وهمية) —
 * والمعرّفات تبدأ بحروف لا أرقام عشوائية فيكون الترتيب بها حتمياً.
 */

type Row = Record<string, unknown>;

export type ModelName =
  | 'warehouseEntry' | 'warehouseEntryItem' | 'vanLoad' | 'vanLoadItem' | 'invoice' | 'invoiceItem'
  | 'accountEntry' | 'invoiceRestockLog' | 'glCostSnapshot' | 'glCostCheckpoint';

export const ALL_MODELS: readonly ModelName[] = [
  'warehouseEntry', 'warehouseEntryItem', 'vanLoad', 'vanLoadItem', 'invoice', 'invoiceItem',
  'accountEntry', 'invoiceRestockLog', 'glCostSnapshot', 'glCostCheckpoint',
];

/** العلاقات الأحادية: النموذج ⇐ الحقل ⇐ (النموذج الهدف، المفتاح الأجنبي) */
const RELATIONS: Partial<Record<ModelName, Record<string, [ModelName, string]>>> = {
  warehouseEntryItem: { entry: ['warehouseEntry', 'entryId'] },
  vanLoadItem: { vanLoad: ['vanLoad', 'vanLoadId'] },
  invoiceItem: { invoice: ['invoice', 'invoiceId'] },
  accountEntry: { invoice: ['invoice', 'invoiceId'] },
};

/** قيود التفرّد (لـcreateMany skipDuplicates) */
const UNIQUE: Partial<Record<ModelName, string[][]>> = {
  glCostSnapshot: [['tenantId', 'sourceKey']],
  glCostCheckpoint: [['tenantId', 'cursorAt', 'cursorId', 'productId', 'location']],
};

/** قيم افتراضية كما في المخطط */
const DEFAULTS: Partial<Record<ModelName, Row>> = {
  glCostSnapshot: { uncostedQty: 0, varianceMilli: 0n, memoMilli: 0n, unitCostE4: 0n, method: 'AVCO', lateArrival: false, toLocation: null },
  glCostCheckpoint: { qtyBase: 0, uncostedQty: 0, valueMilli: 0n, lastAvgValueMilli: null, lastAvgQty: null, movesFolded: 0 },
};

export const GL_COST_MODELS: readonly ModelName[] = ['glCostSnapshot', 'glCostCheckpoint'];

export interface OpRecord {
  model: ModelName | '$executeRaw' | '$queryRaw';
  op: string;
  /** رقم المعاملة (null خارجها) */
  tx: number | null;
  write: boolean;
  sql?: string;
  /** عدد الصفوف لعمليات الكتابة الجماعية، وproductId لكل صفّ checkpoint (لتتبّع الرأس) */
  rows?: Row[];
}

const WRITE_OPS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

function isPlainObject(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v) && typeof v !== 'bigint';
}

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  return a === b;
}

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const OPERATORS = new Set(['equals', 'in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte']);

function matchValue(v: unknown, cond: unknown): boolean {
  if (cond === null) return v === null || v === undefined;
  if (isPlainObject(cond) && Object.keys(cond).every((k) => OPERATORS.has(k))) {
    for (const [op, arg] of Object.entries(cond)) {
      if (arg === undefined) continue;
      switch (op) {
        case 'equals': if (!eq(v, arg)) return false; break;
        case 'in':
          // كـPrisma: قائمة in قيمٌ بسيطة وحدها — دالّةٌ (Object.prototype.valueOf مثلاً) خطأ تحقّق لا «لا تطابق»
          for (const x of arg as unknown[]) {
            if (x !== null && !['string', 'number', 'bigint', 'boolean'].includes(typeof x) && !(x instanceof Date)) {
              throw new Error(`FAKE_INVALID_IN: قيمة غير صالحة في in (${typeof x})`);
            }
          }
          if (!(arg as unknown[]).some((x) => eq(v, x))) return false;
          break;
        case 'notIn': if ((arg as unknown[]).some((x) => eq(v, x))) return false; break;
        case 'not': if (isPlainObject(arg) ? matchValue(v, arg) : eq(v, arg)) return false; break;
        case 'gt': if (v === null || v === undefined || !(cmp(v, arg) > 0)) return false; break;
        case 'gte': if (v === null || v === undefined || !(cmp(v, arg) >= 0)) return false; break;
        case 'lt': if (v === null || v === undefined || !(cmp(v, arg) < 0)) return false; break;
        case 'lte': if (v === null || v === undefined || !(cmp(v, arg) <= 0)) return false; break;
      }
    }
    return true;
  }
  return eq(v, cond);
}

export class CostingFakeDb {
  readonly tables: Record<ModelName, Row[]> = Object.fromEntries(ALL_MODELS.map((m) => [m, [] as Row[]])) as Record<ModelName, Row[]>;
  readonly ops: OpRecord[] = [];
  /** ساعة القاعدة (SELECT now()) */
  dbNow = new Date('2026-11-14T12:00:00.000Z');
  /** ساعة البُناة: كل حركة تُنشأ بعد سابقتها بثانية (قابلة للتعديل) */
  clock = new Date('2026-01-01T06:00:00.000Z').getTime();
  stepMs = 1000;
  private seq = 0;
  private rowSeq = 0;
  private txSeq = 0;
  private currentTx: number | null = null;
  /** خطّاف قبل كل معاملة (لاختبار التزامن: تشغيلٌ آخر يكتب بين القراءة والكتابة) */
  beforeTransaction: ((n: number) => void | Promise<void>) | null = null;
  /** ترفض كل كتابة خارج gl_cost_* (حارس المعاينة/الإلحاق) */
  strictWrites = true;

  // المندوبات بأسماء Prisma (تقرأ الجداول عند النداء لا عند الإنشاء)
  readonly warehouseEntry = this.delegate('warehouseEntry');
  readonly warehouseEntryItem = this.delegate('warehouseEntryItem');
  readonly vanLoad = this.delegate('vanLoad');
  readonly vanLoadItem = this.delegate('vanLoadItem');
  readonly invoice = this.delegate('invoice');
  readonly invoiceItem = this.delegate('invoiceItem');
  readonly accountEntry = this.delegate('accountEntry');
  readonly invoiceRestockLog = this.delegate('invoiceRestockLog');
  readonly glCostSnapshot = this.delegate('glCostSnapshot');
  readonly glCostCheckpoint = this.delegate('glCostCheckpoint');

  // ═══ محرّك الاستعلام ═══

  private related(model: ModelName, row: Row, rel: string): Row | null {
    const r = RELATIONS[model]?.[rel];
    if (!r) return null;
    const [target, fk] = r;
    const id = row[fk];
    if (id === null || id === undefined) return null;
    return this.tables[target].find((x) => x.id === id) ?? null;
  }

  matches(model: ModelName, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === 'AND') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((w) => this.matches(model, row, w as Row))) return false;
      } else if (k === 'OR') {
        if (!(cond as Row[]).some((w) => this.matches(model, row, w))) return false;
      } else if (k === 'NOT') {
        const list = Array.isArray(cond) ? cond : [cond];
        if (list.some((w) => this.matches(model, row, w as Row))) return false;
      } else if (RELATIONS[model]?.[k]) {
        const [target] = RELATIONS[model]![k];
        const rel = this.related(model, row, k);
        if (cond === null) { if (rel !== null) return false; continue; }
        if (!rel) return false;
        const c = cond as Row;
        const inner = 'is' in c ? (c.is as Row) : c;
        if (!this.matches(target, rel, inner)) return false;
      } else if (!matchValue(row[k], cond)) {
        return false;
      }
    }
    return true;
  }

  private sortKey(model: ModelName, row: Row, spec: Row): { v: unknown; dir: number } {
    const [k, d] = Object.entries(spec)[0];
    if (RELATIONS[model]?.[k]) {
      const [target] = RELATIONS[model]![k];
      const rel = this.related(model, row, k) ?? {};
      return this.sortKey(target, rel, d as Row);
    }
    return { v: row[k], dir: d === 'desc' ? -1 : 1 };
  }

  private order(model: ModelName, rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
    return rows.slice().sort((a, b) => {
      for (const s of specs) {
        const ka = this.sortKey(model, a, s);
        const kb = this.sortKey(model, b, s);
        const c = cmp(ka.v, kb.v);
        if (c !== 0) return c * ka.dir;
      }
      return 0;
    });
  }

  private project(model: ModelName, row: Row, select: Row | undefined): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (RELATIONS[model]?.[k]) {
        const [target] = RELATIONS[model]![k];
        const rel = this.related(model, row, k);
        out[k] = rel ? this.project(target, rel, isPlainObject(v) ? (v.select as Row | undefined) : undefined) : null;
      } else {
        out[k] = row[k] === undefined ? null : row[k];
      }
    }
    return out;
  }

  private record(model: OpRecord['model'], op: string, extra: Partial<OpRecord> = {}): void {
    this.ops.push({ model, op, tx: this.currentTx, write: WRITE_OPS.has(op), ...extra });
  }

  private assertWritable(model: ModelName, op: string): void {
    if (this.strictWrites && !GL_COST_MODELS.includes(model)) {
      throw new Error(`FAKE_WRITE_REJECTED: ${model}.${op} (الكتابة مسموحة في gl_cost_* وحدها)`);
    }
  }

  private uniqueKey(model: ModelName, row: Row): string[] {
    return (UNIQUE[model] ?? []).map((cols) => cols.map((c) => {
      const v = row[c];
      return v instanceof Date ? `D${v.getTime()}` : String(v);
    }).join('\u0001'));
  }

  private delegate(model: ModelName) {
    const self = this;
    return {
      async findMany(args: { where?: Row; orderBy?: unknown; take?: number; skip?: number; select?: Row } = {}): Promise<Row[]> {
        self.record(model, 'findMany');
        let rows = self.tables[model].filter((r) => self.matches(model, r, args.where));
        rows = self.order(model, rows, args.orderBy);
        if (args.skip) rows = rows.slice(args.skip);
        if (args.take !== undefined) rows = args.take >= 0 ? rows.slice(0, args.take) : rows.slice(args.take);
        return rows.map((r) => self.project(model, r, args.select));
      },
      async findFirst(args: { where?: Row; orderBy?: unknown; select?: Row } = {}): Promise<Row | null> {
        self.record(model, 'findFirst');
        const rows = self.order(model, self.tables[model].filter((r) => self.matches(model, r, args.where)), args.orderBy);
        return rows.length ? self.project(model, rows[0], args.select) : null;
      },
      async findUnique(args: { where: Row; select?: Row }): Promise<Row | null> {
        self.record(model, 'findUnique');
        const r = self.tables[model].find((x) => self.matches(model, x, args.where));
        return r ? self.project(model, r, args.select) : null;
      },
      async count(args: { where?: Row } = {}): Promise<number> {
        self.record(model, 'count');
        return self.tables[model].filter((r) => self.matches(model, r, args.where)).length;
      },
      async create(args: { data: Row }): Promise<Row> {
        self.assertWritable(model, 'create');
        const r = await self.insertMany(model, [args.data], false);
        self.record(model, 'create', { rows: [args.data] });
        return r[0];
      },
      async createMany(args: { data: Row[] | Row; skipDuplicates?: boolean }): Promise<{ count: number }> {
        self.assertWritable(model, 'createMany');
        const data = Array.isArray(args.data) ? args.data : [args.data];
        const r = await self.insertMany(model, data, args.skipDuplicates === true);
        self.record(model, 'createMany', { rows: data });
        return { count: r.length };
      },
      async deleteMany(args: { where?: Row } = {}): Promise<{ count: number }> {
        self.assertWritable(model, 'deleteMany');
        const keep: Row[] = [];
        let n = 0;
        for (const r of self.tables[model]) {
          if (self.matches(model, r, args.where)) n++;
          else keep.push(r);
        }
        self.tables[model] = keep;
        self.record(model, 'deleteMany');
        return { count: n };
      },
      async update(): Promise<never> {
        self.assertWritable(model, 'update');
        throw new Error(`FAKE_UNSUPPORTED: ${model}.update`);
      },
      async updateMany(): Promise<never> {
        self.assertWritable(model, 'updateMany');
        throw new Error(`FAKE_UNSUPPORTED: ${model}.updateMany`);
      },
      async upsert(): Promise<never> {
        self.assertWritable(model, 'upsert');
        throw new Error(`FAKE_UNSUPPORTED: ${model}.upsert`);
      },
      async delete(): Promise<never> {
        self.assertWritable(model, 'delete');
        throw new Error(`FAKE_UNSUPPORTED: ${model}.delete`);
      },
    };
  }

  private async insertMany(model: ModelName, data: Row[], skipDuplicates: boolean): Promise<Row[]> {
    const table = this.tables[model];
    const seen = new Set<string>();
    for (const r of table) for (const k of this.uniqueKey(model, r)) seen.add(k);
    const inserted: Row[] = [];
    for (const d of data) {
      const row: Row = { ...(DEFAULTS[model] ?? {}), ...d };
      // عدّاد مستقل عن معرّفات البُناة: كتابة اللقطات لا تغيّر معرّفات البيانات المبنية بعدها (مقارنة قاعدتين)
      if (row.id === undefined) row.id = `${model}-${String(++this.rowSeq).padStart(8, '0')}`;
      if (row.createdAt === undefined) row.createdAt = new Date(this.dbNow.getTime());
      const keys = this.uniqueKey(model, row);
      if (keys.some((k) => seen.has(k))) {
        if (skipDuplicates) continue;
        throw new Error(`FAKE_UNIQUE_VIOLATION: ${model} ${keys.join(',')}`);
      }
      for (const k of keys) seen.add(k);
      table.push(row);
      inserted.push(row);
    }
    return inserted;
  }

  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = strings.join('?');
    if (!/pg_advisory_xact_lock/.test(sql)) {
      this.record('$executeRaw', 'executeRaw', { sql, write: true });
      if (this.strictWrites) throw new Error(`FAKE_WRITE_REJECTED: $executeRaw ${sql}`);
      return 0;
    }
    this.record('$executeRaw', 'lock', { sql: `${sql} :: ${values.map(String).join(',')}` });
    return 1;
  }

  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sql = strings.join('?');
    this.record('$queryRaw', 'queryRaw', { sql });
    void values;
    if (/now\(\)/i.test(sql)) return [{ now: new Date(this.dbNow.getTime()) }];
    throw new Error(`FAKE_UNSUPPORTED: $queryRaw ${sql}`);
  }

  async $transaction<T>(fn: (tx: this) => Promise<T>, _opts?: unknown): Promise<T> {
    const n = ++this.txSeq;
    if (this.beforeTransaction) await this.beforeTransaction(n);
    const saved = new Map<ModelName, Row[]>(GL_COST_MODELS.map((m) => [m, this.tables[m].slice()]));
    const prev = this.currentTx;
    this.currentTx = n;
    try {
      return await fn(this);
    } catch (e) {
      for (const [m, rows] of saved) this.tables[m] = rows;
      throw e;
    } finally {
      this.currentTx = prev;
    }
  }

  /** عمليات الكتابة كلها (للتجسّس) */
  writes(): OpRecord[] {
    return this.ops.filter((o) => o.write);
  }

  /** عمليات معاملة بعينها بترتيبها */
  txOps(n: number): OpRecord[] {
    return this.ops.filter((o) => o.tx === n);
  }

  get transactions(): number {
    return this.txSeq;
  }

  // ═══ بُناة البيانات (ساعة وهمية ومعرّفات قابلة للترتيب) ═══

  private nextAt(at?: Date | string): Date {
    if (at !== undefined) {
      const d = new Date(at);
      this.clock = Math.max(this.clock, d.getTime());
      return d;
    }
    this.clock += this.stepMs;
    return new Date(this.clock);
  }

  id(prefix: string): string {
    return `${prefix}-${String(++this.seq).padStart(8, '0')}`;
  }

  /** حركة مستودع (RECEIVE/ADJUST/RETURN) ببنودها */
  addWarehouseEntry(input: {
    tenantId?: string; type?: string; at?: Date | string; zeroRunId?: string | null; reason?: string | null; id?: string;
    items: { productId: string; qty: number; unitCost?: number | null; unitFactor?: number; baseQty?: number | null; id?: string }[];
  }): { id: string; itemIds: string[]; createdAt: Date } {
    const id = input.id ?? this.id('we');
    const createdAt = this.nextAt(input.at);
    this.tables.warehouseEntry.push({
      id, tenantId: input.tenantId ?? 't1', type: input.type ?? 'RECEIVE', zeroRunId: input.zeroRunId ?? null,
      reason: input.reason ?? null, createdAt,
    });
    const itemIds = input.items.map((it) => {
      const iid = it.id ?? this.id('wi');
      const f = it.unitFactor ?? 1;
      this.tables.warehouseEntryItem.push({
        id: iid, entryId: id, productId: it.productId, qty: it.qty, unitFactor: f,
        baseQty: it.baseQty === undefined ? Math.round(it.qty * f * 1e6) / 1e6 : it.baseQty, unitCost: it.unitCost ?? null,
      });
      return iid;
    });
    return { id, itemIds, createdAt };
  }

  addReceipt(productId: string, qty: number, unitCost: number | null, opts: { at?: Date | string; tenantId?: string; unitFactor?: number } = {}) {
    return this.addWarehouseEntry({ type: 'RECEIVE', at: opts.at, tenantId: opts.tenantId, items: [{ productId, qty, unitCost, unitFactor: opts.unitFactor }] });
  }

  /** حركة سيارة (LOAD/UNLOAD/ADJUST/DAMAGED_OUT/EXPIRED_OUT) */
  addVanLoad(input: {
    tenantId?: string; salesRepId: string | null; deletedSalesRepId?: string | null; type?: string; at?: Date | string;
    zeroRunId?: string | null; reason?: string | null; id?: string;
    items: { productId: string; qty: number; unitFactor?: number; baseQty?: number | null; id?: string }[];
  }): { id: string; itemIds: string[]; createdAt: Date } {
    const id = input.id ?? this.id('vl');
    const createdAt = this.nextAt(input.at);
    this.tables.vanLoad.push({
      id, tenantId: input.tenantId ?? 't1', salesRepId: input.salesRepId, deletedSalesRepId: input.deletedSalesRepId ?? null,
      type: input.type ?? 'LOAD', zeroRunId: input.zeroRunId ?? null, reason: input.reason ?? null, createdAt,
    });
    const itemIds = input.items.map((it) => {
      const iid = it.id ?? this.id('vi');
      const f = it.unitFactor ?? 1;
      this.tables.vanLoadItem.push({
        id: iid, vanLoadId: id, productId: it.productId, qty: it.qty, unitFactor: f,
        baseQty: it.baseQty === undefined ? Math.round(it.qty * f * 1e6) / 1e6 : it.baseQty,
      });
      return iid;
    });
    return { id, itemIds, createdAt };
  }

  /**
   * فاتورة (CASH/CREDIT/RETURN) ببنودها وصفّها الأساسي في account_entries (INVOICE_DEBIT للبيع، INVOICE_CREDIT للمرتجع)،
   * وللنقدية صفّ RECEIPT_CREDIT أيضاً (لا يمسّ المخزون — يثبت الاختبار تجاهله).
   */
  addInvoice(input: {
    tenantId?: string; type?: string; salesRepId?: string | null; at?: Date | string; entryDate?: Date | string;
    documentKind?: string | null; returnToStock?: boolean; returnReason?: string | null; id?: string; postEntry?: boolean;
    items: {
      productId: string | null; qty: number; unitFactor?: number; baseQty?: number | null; id?: string;
      returnOfItemId?: string | null; creditedItemId?: string | null; returnExpired?: boolean | null;
    }[];
  }): { id: string; itemIds: string[]; createdAt: Date; entryId: string | null } {
    const id = input.id ?? this.id('in');
    const createdAt = this.nextAt(input.at);
    const type = input.type ?? 'CREDIT';
    this.tables.invoice.push({
      id, tenantId: input.tenantId ?? 't1', type, status: 'CONFIRMED', documentKind: input.documentKind ?? null,
      salesRepId: input.salesRepId ?? null, returnToStock: input.returnToStock ?? true, returnReason: input.returnReason ?? null, createdAt,
    });
    const itemIds = input.items.map((it) => {
      const iid = it.id ?? this.id('ii');
      const f = it.unitFactor ?? 1;
      this.tables.invoiceItem.push({
        id: iid, invoiceId: id, productId: it.productId, qty: it.qty, unitFactor: f,
        baseQty: it.baseQty === undefined ? Math.round(it.qty * f * 1e6) / 1e6 : it.baseQty,
        returnOfItemId: it.returnOfItemId ?? null, creditedItemId: it.creditedItemId ?? null, returnExpired: it.returnExpired ?? null,
      });
      return iid;
    });
    let entryId: string | null = null;
    if (input.postEntry !== false) {
      const primary = type === 'RETURN' ? 'INVOICE_CREDIT' : 'INVOICE_DEBIT';
      entryId = this.addAccountEntry({
        tenantId: input.tenantId, invoiceId: id, type: primary, at: createdAt,
        entryDate: input.entryDate !== undefined ? new Date(input.entryDate) : createdAt,
      });
      if (type === 'CASH') this.addAccountEntry({ tenantId: input.tenantId, invoiceId: id, type: 'RECEIPT_CREDIT', at: createdAt, entryDate: createdAt });
    }
    return { id, itemIds, createdAt, entryId };
  }

  addAccountEntry(input: { tenantId?: string; invoiceId: string | null; receiptId?: string | null; type: string; at?: Date | string; entryDate?: Date | string; id?: string; description?: string }): string {
    const id = input.id ?? this.id('ae');
    const createdAt = this.nextAt(input.at);
    this.tables.accountEntry.push({
      id, tenantId: input.tenantId ?? 't1', customerId: 'c1', invoiceId: input.invoiceId, receiptId: input.receiptId ?? null,
      type: input.type, debit: 0, credit: 0, description: input.description ?? '',
      entryDate: input.entryDate !== undefined ? new Date(input.entryDate) : createdAt, createdAt,
    });
    return id;
  }

  /** إلغاء فاتورة: صفّ العكس الأساسي (INVOICE_CREDIT للبيع، INVOICE_DEBIT للمرتجع) — كـreverseInvoiceInTx */
  cancelInvoice(invoiceId: string, opts: { at?: Date | string; withReceiptLeg?: boolean } = {}): string {
    const inv = this.tables.invoice.find((i) => i.id === invoiceId);
    if (!inv) throw new Error(`no invoice ${invoiceId}`);
    inv.status = 'CANCELLED';
    const type = inv.type === 'RETURN' ? 'INVOICE_DEBIT' : 'INVOICE_CREDIT';
    const at = this.nextAt(opts.at);
    const id = this.addAccountEntry({ tenantId: inv.tenantId as string, invoiceId, type, at, entryDate: at });
    if (inv.type === 'CASH' && opts.withReceiptLeg !== false) this.addAccountEntry({ tenantId: inv.tenantId as string, invoiceId, type: 'RECEIPT_DEBIT', at, entryDate: at });
    return id;
  }

  /** تبديل «الإعادة للمخزون»: يحدّث الفاتورة ويكتب سجلّه (كما يفعل مسار L1) */
  toggleRestock(invoiceId: string, to: boolean, opts: { at?: Date | string; id?: string } = {}): string {
    const inv = this.tables.invoice.find((i) => i.id === invoiceId);
    if (!inv) throw new Error(`no invoice ${invoiceId}`);
    const id = opts.id ?? this.id('rl');
    const createdAt = this.nextAt(opts.at);
    this.tables.invoiceRestockLog.push({ id, tenantId: inv.tenantId, invoiceId, previous: inv.returnToStock, returnToStock: to, createdAt });
    inv.returnToStock = to;
    return id;
  }

  /** نسخة عميقة لجداول gl_cost_* (للمقارنة بين تشغيلين) */
  glSnapshotRows(): Row[] {
    return this.tables.glCostSnapshot.map((r) => ({ ...r }));
  }
}

/** عميلٌ بشكل Prisma للدوال المختبَرة (القاعدة المزيّفة تحقّق الجزء الذي تستعمله) */
export function asPrisma<T>(db: CostingFakeDb): T {
  return db as unknown as T;
}
