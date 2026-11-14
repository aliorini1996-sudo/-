// «ربط الدفاتر» L8 (A10) — Prisma مزيّف في الذاكرة لاختبارات مسارات تقارير الشركاء والمرفقات ومخزن المطابقة: جداول
// بصفوف، وتقييم where (مساواة، in/notIn، lt/lte/gt/gte، not، contains، startsWith، OR/AND، وعلاقات الأب)، وselect متداخل،
// وorderBy/take، وaggregate/groupBy/count/createMany/deleteMany — وسجلّ لكل نداء بمعامِلاته لإثبات العزل بالشركة.
// ليس اختباراً بذاته.

type Row = Record<string, unknown>;

/** علاقة: حقل العلاقة ⇒ [الجدول، المفتاح الأجنبي في الصفّ، المفتاح في الجدول الآخر] */
const RELATIONS: Record<string, Record<string, [string, string, string]>> = {
  receiptPhoto: { receipt: ['receipt', 'receiptId', 'id'] },
  repSettlementPhoto: { settlement: ['repSettlement', 'settlementId', 'id'] },
  userSettlementPhoto: { settlement: ['userSettlement', 'settlementId', 'id'] },
  glMoveLine: { account: ['glAccount', 'accountId', 'id'], move: ['glMove', 'moveId', 'id'] },
  glMove: { journal: ['glJournal', 'journalId', 'id'], reversal: ['glMove', 'id', 'reversedMoveId'] },
  glMoveSource: { move: ['glMove', 'moveId', 'id'] },
  glAttachment: { blob: ['glAttachmentBlob', 'id', 'attachmentId'] },
  receiptInvoice: { receipt: ['receipt', 'receiptId', 'id'] },
  customerAdjustmentAllocation: { adjustment: ['customerAdjustment', 'adjustmentId', 'id'] },
  invoiceItem: { invoice: ['invoice', 'invoiceId', 'id'] },
};

const OPS = new Set(['in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'not', 'contains', 'startsWith', 'equals', 'mode']);

const cmp = (a: unknown, b: unknown): number => {
  const v = (x: unknown) => (x instanceof Date ? x.getTime() : x);
  const x = v(a) as number | bigint | string;
  const y = v(b) as number | bigint | string;
  return x < y ? -1 : x > y ? 1 : 0;
};
const eq = (a: unknown, b: unknown): boolean => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

export class FakeDb {
  tables: Record<string, Row[]> = {};
  calls: { model: string; method: string; args: unknown }[] = [];
  raw: { sql: string; values: unknown[] }[] = [];
  /** معالج SQL الخام: يُعاد له النصّ والقيم */
  rawHandler: (sql: string, values: unknown[]) => unknown[] = () => [];
  private seq = 0;

  table(name: string): Row[] {
    this.tables[name] ??= [];
    return this.tables[name];
  }
  insert(name: string, rows: Row[]): void {
    this.table(name).push(...rows.map((r) => ({ ...r })));
  }

  private related(model: string, row: Row, rel: string): Row | null {
    const r = RELATIONS[model]?.[rel];
    if (!r) return null;
    const [t, fk, pk] = r;
    return this.table(t).find((x) => x[pk] === row[fk] && row[fk] !== undefined && row[fk] !== null) ?? null;
  }

  matches(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    for (const [k, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (k === 'OR') { if (!(cond as Row[]).some((w) => this.matches(model, row, w))) return false; continue; }
      if (k === 'AND') { if (!(cond as Row[]).every((w) => this.matches(model, row, w))) return false; continue; }
      if (k === 'NOT') { if (this.matches(model, row, cond as Row)) return false; continue; }
      const rel = RELATIONS[model]?.[k];
      if (rel && cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
        const target = this.related(model, row, k);
        const inner = (cond as Row).is !== undefined ? (cond as Row).is as Row | null : cond as Row;
        if (inner === null) { if (target) return false; continue; }
        if (!target || !this.matches(rel[0], target, inner)) return false;
        continue;
      }
      const v = row[k];
      if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && typeof cond !== 'bigint'
        && Object.keys(cond).every((o) => OPS.has(o))) {
        const c = cond as Row;
        if ('equals' in c && !eq(v, c.equals)) return false;
        if ('in' in c && !(c.in as unknown[]).some((x) => eq(x, v))) return false;
        if ('notIn' in c && (c.notIn as unknown[]).some((x) => eq(x, v))) return false;
        if ('lt' in c && !(v !== null && v !== undefined && cmp(v, c.lt) < 0)) return false;
        if ('lte' in c && !(v !== null && v !== undefined && cmp(v, c.lte) <= 0)) return false;
        if ('gt' in c && !(v !== null && v !== undefined && cmp(v, c.gt) > 0)) return false;
        if ('gte' in c && !(v !== null && v !== undefined && cmp(v, c.gte) >= 0)) return false;
        if ('not' in c && (c.not === null ? v === null || v === undefined : eq(v, c.not))) return false;
        if ('contains' in c) {
          const s = String(v ?? '');
          const t = String(c.contains);
          if (!(c.mode === 'insensitive' ? s.toLowerCase().includes(t.toLowerCase()) : s.includes(t))) return false;
        }
        if ('startsWith' in c && !String(v ?? '').startsWith(String(c.startsWith))) return false;
        continue;
      }
      if (cond === null) { if (v !== null && v !== undefined) return false; continue; }
      if (!eq(v, cond)) return false;
    }
    return true;
  }

  private project(model: string, row: Row, select: Row | undefined): Row {
    if (!select) return { ...row };
    const out: Row = {};
    for (const [k, s] of Object.entries(select)) {
      if (!s) continue;
      const rel = RELATIONS[model]?.[k];
      if (rel && typeof s === 'object') {
        const t = this.related(model, row, k);
        out[k] = t ? this.project(rel[0], t, (s as Row).select as Row | undefined) : null;
      } else if (k === 'lines' && model === 'glMove') {
        out[k] = this.table('glMoveLine').filter((l) => l.moveId === row.id).map((l) => this.project('glMoveLine', l, (s as Row).select as Row));
      } else {
        out[k] = row[k] === undefined ? null : row[k];
      }
    }
    return out;
  }

  private sorted(rows: Row[], orderBy: unknown): Row[] {
    const specs = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Row[];
    return [...rows].sort((a, b) => {
      for (const s of specs) {
        const [k, dir] = Object.entries(s)[0] as [string, string];
        const c = cmp(a[k] ?? '', b[k] ?? '');
        if (c !== 0) return dir === 'desc' ? -c : c;
      }
      return 0;
    });
  }

  private find(model: string, args: Row = {}): Row[] {
    let rows = this.table(model).filter((r) => this.matches(model, r, args.where as Row));
    rows = this.sorted(rows, args.orderBy);
    if (typeof args.skip === 'number') rows = rows.slice(args.skip);
    if (typeof args.take === 'number') rows = rows.slice(0, args.take);
    return rows;
  }

  model(model: string): Record<string, (args?: Row) => Promise<unknown>> {
    const rec = (method: string, args: unknown) => this.calls.push({ model, method, args });
    return {
      findMany: async (args = {}) => { rec('findMany', args); return this.find(model, args).map((r) => this.project(model, r, args.select as Row)); },
      findFirst: async (args = {}) => { rec('findFirst', args); const r = this.find(model, args)[0]; return r ? this.project(model, r, args.select as Row) : null; },
      findUnique: async (args = {}) => {
        rec('findUnique', args);
        const where = { ...(args.where as Row) };
        // مفاتيح مركّبة tenantId_sourceKey وغيرها تُفكّ
        for (const [k, v] of Object.entries(where)) if (k.includes('_') && v && typeof v === 'object') { delete where[k]; Object.assign(where, v); }
        const r = this.table(model).find((x) => this.matches(model, x, where));
        return r ? this.project(model, r, args.select as Row) : null;
      },
      count: async (args = {}) => { rec('count', args); return this.find(model, args).length; },
      aggregate: async (args = {}) => {
        rec('aggregate', args);
        const rows = this.find(model, args);
        const sum: Row = {};
        for (const k of Object.keys((args._sum as Row) ?? {})) {
          const vals = rows.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
          sum[k] = vals.length === 0 ? null : vals.reduce((a, v) => (a as bigint | number) + (v as never), typeof vals[0] === 'bigint' ? 0n : 0);
        }
        return { _sum: sum, _count: { _all: rows.length } };
      },
      groupBy: async (args = {}) => {
        rec('groupBy', args);
        const rows = this.find(model, { where: args.where });
        const by = args.by as string[];
        const groups = new Map<string, Row[]>();
        for (const r of rows) {
          const k = JSON.stringify(by.map((f) => r[f] ?? null));
          groups.set(k, [...(groups.get(k) ?? []), r]);
        }
        return [...groups.values()].map((g) => {
          const out: Row = {};
          for (const f of by) out[f] = g[0][f] ?? null;
          if (args._sum) {
            const sum: Row = {};
            for (const k of Object.keys(args._sum as Row)) {
              const vals = g.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
              sum[k] = vals.length === 0 ? null : vals.reduce((a, v) => (a as bigint | number) + (v as never), typeof vals[0] === 'bigint' ? 0n : 0);
            }
            out._sum = sum;
          }
          if (args._count) out._count = { _all: g.length };
          return out;
        });
      },
      create: async (args = {}) => {
        rec('create', args);
        const row = { id: `${model}-${++this.seq}`, ...(args.data as Row) };
        this.table(model).push(row);
        return row;
      },
      createMany: async (args = {}) => {
        rec('createMany', args);
        let count = 0;
        for (const d of args.data as Row[]) {
          if (model === 'glPartialReconcile' && this.table(model).some((p) => p.tenantId === d.tenantId && p.sourceRef === d.sourceRef
            && p.debitLineId === d.debitLineId && p.creditLineId === d.creditLineId)) continue;
          this.table(model).push({ id: `${model}-${++this.seq}`, ...d });
          count++;
        }
        return { count };
      },
      deleteMany: async (args = {}) => {
        rec('deleteMany', args);
        const before = this.table(model).length;
        this.tables[model] = this.table(model).filter((r) => !this.matches(model, r, args.where as Row));
        return { count: before - this.tables[model].length };
      },
    };
  }

  /** العميل المزيّف: `prisma.<model>.<method>` و`$transaction` و`$queryRaw` و`$executeRaw` */
  client(): Record<string, unknown> {
    const self = this;
    const proxy: Record<string, unknown> = new Proxy({}, {
      get: (_t, key: string) => {
        if (key === '$transaction') return async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(proxy) : Promise.all(arg as Promise<unknown>[]));
        if (key === '$queryRaw') {
          return async (strings: TemplateStringsArray | { strings: string[]; values: unknown[] }, ...values: unknown[]) => {
            const parts = Array.isArray(strings) ? (strings as readonly string[]) : (strings as { strings: string[] }).strings;
            const vals = Array.isArray(strings) ? values : (strings as { values: unknown[] }).values;
            // كـPrisma: مقاطع Prisma.sql المتداخلة تُدمج في النصّ وقيمها في القيم
            const flat = (ps: readonly string[], vs: readonly unknown[]): { sql: string; values: unknown[] } => {
              let sql = ps[0];
              const out: unknown[] = [];
              vs.forEach((v, i) => {
                const frag = v as { strings?: string[]; values?: unknown[] } | null;
                if (frag && typeof frag === 'object' && Array.isArray(frag.strings) && Array.isArray(frag.values)) {
                  const inner = flat(frag.strings, frag.values);
                  sql += inner.sql;
                  out.push(...inner.values);
                } else {
                  sql += '?';
                  out.push(v);
                }
                sql += ps[i + 1];
              });
              return { sql, values: out };
            };
            const q = flat(parts, vals);
            self.raw.push(q);
            return self.rawHandler(q.sql, q.values);
          };
        }
        if (key === '$executeRaw') return async () => 0;
        if (key === 'then') return undefined;
        return self.model(key);
      },
    });
    return proxy;
  }
}

/** بادئة/طول/ذيل لـdata URL كما تعيدها substr/length/right في SQL المرفقات */
export function dataUrlMetaOf(data: string | null): { head: string | null; len: number | null; tail: string | null } {
  if (data === null) return { head: null, len: null, tail: null };
  return { head: data.slice(0, 64), len: data.length, tail: data.slice(-2) };
}
