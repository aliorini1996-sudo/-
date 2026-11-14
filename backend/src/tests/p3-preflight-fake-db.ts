// قاعدة مزيّفة لاختبار الفحوص المسبقة (linking/preflight.ts — P3): شكل Prisma للمندوبات التشغيلية التي يقرؤها الفحص وحدها،
// بدلالة SQL للقيم الفارغة (`{ not: 'X' }` و`gt` لا تطابق NULL) كي تُكشف أخطاء المرشّحات كما في القاعدة الحقيقية.
// - كل كتابة (create/update/delete/upsert/…) وكل $executeRaw/$queryRaw تُحصى ثم ترمي: الفحص قراءة فقط.
// - العميل الحارس (guarded) يرمي SHADOW_GL_ACCESS عند أي مندوب gl* — كالعميل الوكيل في ظلّ المعاينة.
// - سجلّ الاستعلامات (model.op) لإثبات «بلا N+1»: عدد الاستعلامات لا يتبع حجم البيانات.
// - findMany بلا orderBy وgroupBy يعيدان ترتيباً معكوساً عمداً: الكود الذي يعتمد ترتيب القاعدة غير المضمون ينكشف.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type Row = Record<string, any>;

interface RelDef { model: string; fk: string; kind: 'one' | 'many' }

const RELATIONS: Record<string, Record<string, RelDef>> = {
  warehouseEntryItem: { entry: { model: 'warehouseEntry', fk: 'entryId', kind: 'one' } },
  warehouseEntry: { items: { model: 'warehouseEntryItem', fk: 'entryId', kind: 'many' } },
  invoiceItem: { invoice: { model: 'invoice', fk: 'invoiceId', kind: 'one' } },
  invoice: { items: { model: 'invoiceItem', fk: 'invoiceId', kind: 'many' } },
  vanLoadItem: { vanLoad: { model: 'vanLoad', fk: 'vanLoadId', kind: 'one' } },
  vanLoad: { items: { model: 'vanLoadItem', fk: 'vanLoadId', kind: 'many' } },
};

export const FAKE_MODELS = [
  'tenant', 'companySettings', 'erpIntegration', 'importBatch', 'invoice', 'invoiceItem', 'receipt', 'vanLoad', 'vanLoadItem',
  'warehouseEntry', 'warehouseEntryItem', 'accountEntry', 'repSettlement', 'settlementEntry', 'product', 'salesRep',
] as const;
export type FakeModel = (typeof FAKE_MODELS)[number];

const WRITE_OPS = ['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];
const RAW_OPS = ['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe', '$transaction'];

const isPlainObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
const norm = (v: unknown) => (v instanceof Date ? v.getTime() : v);
const eq = (a: unknown, b: unknown) => norm(a) === norm(b);
const isNull = (v: unknown) => v === null || v === undefined;

function cmp(a: unknown, b: unknown): number {
  const x = norm(a) as any;
  const y = norm(b) as any;
  return x < y ? -1 : x > y ? 1 : 0;
}

export class FakeDb {
  readonly tables: Record<FakeModel, Row[]>;
  readonly queries: string[] = [];
  writes = 0;
  raws = 0;
  readonly glAccess: string[] = [];

  constructor() {
    this.tables = Object.fromEntries(FAKE_MODELS.map((m) => [m, []])) as unknown as Record<FakeModel, Row[]>;
  }

  add(model: FakeModel, ...rows: Row[]): this {
    this.tables[model].push(...rows);
    return this;
  }

  /** عدد الاستعلامات لكل model.op */
  queryCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const q of this.queries) out[q] = (out[q] ?? 0) + 1;
    return out;
  }

  // ─── المطابقة ───

  private matchScalar(val: unknown, f: unknown): boolean {
    if (f === null) return isNull(val);
    if (!isPlainObj(f)) return !isNull(val) && eq(val, f);
    for (const [op, x] of Object.entries(f)) {
      if (x === undefined) continue;
      switch (op) {
        case 'equals': if (x === null ? !isNull(val) : (isNull(val) || !eq(val, x))) return false; break;
        case 'not':
          if (x === null) { if (isNull(val)) return false; }
          else if (isPlainObj(x)) { if (isNull(val) || this.matchScalar(val, x)) return false; }
          else if (isNull(val) || eq(val, x)) return false; // SQL: <> لا يطابق NULL
          break;
        case 'in': if (isNull(val) || !(x as unknown[]).some((y) => eq(val, y))) return false; break;
        case 'notIn': if (isNull(val) || (x as unknown[]).some((y) => eq(val, y))) return false; break;
        case 'gt': if (isNull(val) || !(cmp(val, x) > 0)) return false; break;
        case 'gte': if (isNull(val) || !(cmp(val, x) >= 0)) return false; break;
        case 'lt': if (isNull(val) || !(cmp(val, x) < 0)) return false; break;
        case 'lte': if (isNull(val) || !(cmp(val, x) <= 0)) return false; break;
        default: throw new Error(`fake: مرشّح غير مدعوم ${op}`);
      }
    }
    return true;
  }

  matches(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (k === 'AND') { if (!(Array.isArray(v) ? v : [v]).every((w) => this.matches(model, row, w))) return false; continue; }
      if (k === 'OR') { if (!(v as Row[]).some((w) => this.matches(model, row, w))) return false; continue; }
      if (k === 'NOT') { if ((Array.isArray(v) ? v : [v]).some((w) => this.matches(model, row, w))) return false; continue; }
      const rel = RELATIONS[model]?.[k];
      if (rel) {
        if (rel.kind === 'one') {
          const target = this.tables[rel.model as FakeModel].find((r) => r.id === row[rel.fk]);
          const w = isPlainObj(v) && 'is' in v ? v.is : v;
          if (!target || !this.matches(rel.model, target, w)) return false;
        } else {
          const kids = this.tables[rel.model as FakeModel].filter((r) => r[rel.fk] === row.id);
          if ('some' in v && !kids.some((c) => this.matches(rel.model, c, v.some))) return false;
          if ('none' in v && kids.some((c) => this.matches(rel.model, c, v.none))) return false;
          if ('every' in v && !kids.every((c) => this.matches(rel.model, c, v.every))) return false;
        }
        continue;
      }
      if (!this.matchScalar(row[k], v)) return false;
    }
    return true;
  }

  private sort(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
    if (!orderBy) return [...rows].reverse();
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => Object.entries(o)[0] as [string, 'asc' | 'desc']);
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = a[k];
        const y = b[k];
        // Postgres: NULLS LAST تصاعدياً و NULLS FIRST تنازلياً
        if (isNull(x) || isNull(y)) {
          if (isNull(x) && isNull(y)) continue;
          return (isNull(x) ? 1 : -1) * (dir === 'desc' ? -1 : 1);
        }
        const c = cmp(x, y);
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  private project(model: string, row: Row, select: Row | undefined): Row {
    if (!select) {
      const out: Row = {};
      for (const [k, v] of Object.entries(row)) out[k] = v;
      return out;
    }
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      const rel = RELATIONS[model]?.[k];
      if (rel) {
        const sub = v === true ? {} : (v as Row);
        if (rel.kind === 'one') {
          const target = this.tables[rel.model as FakeModel].find((r) => r.id === row[rel.fk]);
          out[k] = target ? this.project(rel.model, target, sub.select) : null;
        } else {
          let kids = this.tables[rel.model as FakeModel].filter((r) => r[rel.fk] === row.id && this.matches(rel.model, r, sub.where));
          kids = sub.orderBy ? this.sort(kids, sub.orderBy) : kids;
          out[k] = kids.map((c) => this.project(rel.model, c, sub.select));
        }
        continue;
      }
      out[k] = row[k] === undefined ? null : row[k];
    }
    return out;
  }

  private find(model: FakeModel, args: Row = {}): Row[] {
    const rows = this.tables[model].filter((r) => this.matches(model, r, args.where));
    let sorted = this.sort(rows, args.orderBy);
    if (args.skip) sorted = sorted.slice(args.skip);
    if (args.take !== undefined) sorted = sorted.slice(0, args.take);
    return sorted;
  }

  private groupBy(model: FakeModel, args: Row): Row[] {
    const rows = this.tables[model].filter((r) => this.matches(model, r, args.where));
    const by = args.by as string[];
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const key = JSON.stringify(by.map((k) => (isNull(r[k]) ? null : norm(r[k]))));
      const g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }
    const out: Row[] = [];
    for (const g of groups.values()) {
      const o: Row = {};
      for (const k of by) o[k] = isNull(g[0][k]) ? null : g[0][k];
      if (args._count) {
        o._count = {};
        for (const f of Object.keys(args._count)) o._count[f] = f === '_all' ? g.length : g.filter((r) => !isNull(r[f])).length;
      }
      for (const agg of ['_sum', '_max', '_min'] as const) {
        if (!args[agg]) continue;
        o[agg] = {};
        for (const f of Object.keys(args[agg])) {
          const vals = g.map((r) => r[f]).filter((v) => !isNull(v));
          if (!vals.length) { o[agg][f] = null; continue; }
          if (agg === '_sum') o[agg][f] = vals.reduce((s, v) => s + Number(v), 0);
          else o[agg][f] = vals.reduce((m, v) => ((agg === '_max' ? cmp(v, m) > 0 : cmp(v, m) < 0) ? v : m));
        }
      }
      out.push(o);
    }
    // ترتيب «القاعدة» غير مضمون — نعكس الإدراج عمداً
    return out.reverse();
  }

  private delegate(model: FakeModel) {
    const log = (op: string) => this.queries.push(`${model}.${op}`);
    const api: Row = {
      findUnique: async (args: Row) => { log('findUnique'); const r = this.find(model, { where: args.where })[0]; return r ? this.project(model, r, args.select) : null; },
      findFirst: async (args: Row = {}) => { log('findFirst'); const r = this.find(model, { ...args, take: 1 })[0]; return r ? this.project(model, r, args.select) : null; },
      findMany: async (args: Row = {}) => { log('findMany'); return this.find(model, args).map((r) => this.project(model, r, args.select)); },
      count: async (args: Row = {}) => { log('count'); return this.find(model, { where: args.where }).length; },
      groupBy: async (args: Row) => { log('groupBy'); return this.groupBy(model, args); },
      aggregate: async () => { throw new Error('fake: aggregate غير مدعوم'); },
    };
    for (const op of WRITE_OPS) {
      api[op] = async () => { this.writes++; throw new Error(`WRITE_FORBIDDEN ${model}.${op}`); };
    }
    return api;
  }

  /** العميل: guarded ⇒ أي gl* يرمي SHADOW_GL_ACCESS (كالعميل الوكيل في ظلّ المعاينة) */
  client(opts: { guarded?: boolean } = { guarded: true }): any {
    const delegates = new Map<string, Row>();
    const self = this;
    return new Proxy({}, {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        if (prop === 'then') return undefined; // ليس وعداً
        if (opts.guarded !== false && /^gl[A-Z]/.test(prop)) {
          self.glAccess.push(prop);
          throw Object.assign(new Error(`SHADOW_GL_ACCESS ${prop}`), { code: 'SHADOW_GL_ACCESS' });
        }
        if (RAW_OPS.includes(prop)) {
          return async () => { self.raws++; throw new Error(`RAW_FORBIDDEN ${prop}`); };
        }
        if ((FAKE_MODELS as readonly string[]).includes(prop)) {
          if (!delegates.has(prop)) delegates.set(prop, self.delegate(prop as FakeModel));
          return delegates.get(prop);
        }
        throw new Error(`fake: مندوب غير معروف ${prop}`);
      },
    });
  }
}
