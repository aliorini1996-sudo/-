/**
 * قاعدة مزيّفة في الذاكرة لمهمة معاينة «ربط الدفاتر» (P5 — jobs.ts ومسارات routes/ledger/linking.ts).
 *
 * تنفّذ ما تستعمله المهمة وحده — glLinkPreview (create/findFirst/findMany/count/updateMany) وقراءات glSettings وtenant
 * وcompanySettings وadmin — بمقيِّم where لعوامل Prisma المستعملة (in/notIn/not/lt/lte/gt/gte/OR/AND/NOT وPrisma.DbNull)،
 * وتسجّل كل نداء «النموذج.العملية» فيُثبت اختبار التجسّس أن الكتابة الوحيدة على gl_link_previews وأن الاستعلامات مجمّعة.
 * نوعٌ غير مدعوم من الفلاتر يرمي (لا نجاح صامت).
 */
import { Prisma } from '@prisma/client';

export type Row = Record<string, unknown>;

const WRITE_OPS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : x > y ? 1 : 0;
  return (x as number) - (y as number);
}

const isFilterObject = (c: unknown): c is Record<string, unknown> =>
  c !== null && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c) && c !== Prisma.DbNull && c !== Prisma.JsonNull;

function fieldMatches(v: unknown, cond: unknown): boolean {
  if (cond === Prisma.DbNull) return v == null;
  if (!isFilterObject(cond)) return eq(v, cond);
  for (const [op, x] of Object.entries(cond)) {
    if (x === undefined) continue;
    switch (op) {
      case 'equals':
        if (x === Prisma.DbNull ? v != null : !eq(v, x)) return false;
        break;
      case 'not':
        if (x === Prisma.DbNull) { if (v == null) return false; }
        else if (isFilterObject(x)) { if (fieldMatches(v, x)) return false; }
        else if (eq(v, x)) return false;
        break;
      case 'in':
        if (!(x as unknown[]).some((y) => eq(v, y))) return false;
        break;
      case 'notIn':
        if ((x as unknown[]).some((y) => eq(v, y))) return false;
        break;
      case 'lt': if (!(v != null && cmp(v, x) < 0)) return false; break;
      case 'lte': if (!(v != null && cmp(v, x) <= 0)) return false; break;
      case 'gt': if (!(v != null && cmp(v, x) > 0)) return false; break;
      case 'gte': if (!(v != null && cmp(v, x) >= 0)) return false; break;
      default: throw new Error(`فلتر غير مدعوم في القاعدة المزيّفة: ${op}`);
    }
  }
  return true;
}

export function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  for (const [k, cond] of Object.entries(where ?? {})) {
    if (cond === undefined) continue;
    if (k === 'OR') { if (!(cond as Row[]).some((w) => matches(row, w))) return false; continue; }
    if (k === 'AND') { const arr = Array.isArray(cond) ? cond : [cond]; if (!arr.every((w) => matches(row, w as Row))) return false; continue; }
    if (k === 'NOT') { const arr = Array.isArray(cond) ? cond : [cond]; if (arr.some((w) => matches(row, w as Row))) return false; continue; }
    if (!fieldMatches(row[k], cond)) return false;
  }
  return true;
}

function project(row: Row, select: Record<string, unknown> | undefined): Row {
  const copy = (v: unknown) => (v instanceof Date ? new Date(v.getTime()) : v);
  if (!select) return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, copy(v)]));
  const out: Row = {};
  for (const [k, on] of Object.entries(select)) if (on) out[k] = copy(row[k]);
  return out;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const specs = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, 'asc' | 'desc'>[];
  return [...rows].sort((a, b) => {
    for (const s of specs) {
      const [k, dir] = Object.entries(s)[0];
      const c = cmp(a[k], b[k]);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

const dbValue = (v: unknown): unknown => (v === Prisma.DbNull || v === Prisma.JsonNull ? null : v);

const PREVIEW_DEFAULTS: Row = {
  status: 'QUEUED', snapshotAt: null, dataHash: null, resultHash: null, result: null, resultBytes: null, phase: null, progressPct: 0,
  heartbeatAt: null, errorCode: null, error: null, options: null, requestedBy: null, startedAt: null, finishedAt: null,
};

export interface FakeLinkingDb {
  db: Record<string, unknown> & { $transaction: (fn: unknown, opts?: unknown) => Promise<unknown> };
  previews: Row[];
  settings: Map<string, Row>;
  tenants: Map<string, Row>;
  companies: Map<string, Row>;
  admins: Map<string, Row>;
  calls: string[];
  writes: string[];
  /** بيانات كل updateMany على glLinkPreview بترتيبها (وعدد ما مسّته) */
  updateLog: { where: Row | undefined; data: Row; count: number }[];
  txOpts: unknown[];
  /** نداءات المعاملة: نصوص العبارات الخام (SET/SHOW/now) بالترتيب */
  rawStatements: string[];
  dbNow: Date;
  reset(): void;
}

export function createFakeLinkingDb(): FakeLinkingDb {
  const state: FakeLinkingDb = {
    db: null as unknown as FakeLinkingDb['db'],
    previews: [],
    settings: new Map(),
    tenants: new Map(),
    companies: new Map(),
    admins: new Map(),
    calls: [],
    writes: [],
    updateLog: [],
    txOpts: [],
    rawStatements: [],
    dbNow: new Date('2026-11-14T09:00:00.000Z'),
    reset() {
      this.previews.length = 0;
      this.settings.clear(); this.tenants.clear(); this.companies.clear(); this.admins.clear();
      this.calls.length = 0; this.writes.length = 0; this.updateLog.length = 0; this.txOpts.length = 0; this.rawStatements.length = 0;
    },
  };
  let seq = 0;
  const record = (model: string, op: string) => {
    state.calls.push(`${model}.${op}`);
    if (WRITE_OPS.has(op)) state.writes.push(`${model}.${op}`);
  };

  const glLinkPreview = {
    async create(args: { data: Row; select?: Row }) {
      record('glLinkPreview', 'create');
      seq += 1;
      const row: Row = { ...PREVIEW_DEFAULTS, id: `pv-${String(seq).padStart(4, '0')}`, createdAt: new Date(), ...args.data };
      for (const k of Object.keys(row)) row[k] = dbValue(row[k]);
      state.previews.push(row);
      return project(row, args.select);
    },
    async findFirst(args: { where?: Row; orderBy?: unknown; select?: Row } = {}) {
      record('glLinkPreview', 'findFirst');
      const rows = sortRows(state.previews.filter((r) => matches(r, args.where)), args.orderBy);
      return rows[0] ? project(rows[0], args.select) : null;
    },
    async findMany(args: { where?: Row; orderBy?: unknown; take?: number; select?: Row } = {}) {
      record('glLinkPreview', 'findMany');
      let rows = sortRows(state.previews.filter((r) => matches(r, args.where)), args.orderBy);
      if (args.take != null) rows = rows.slice(0, args.take);
      return rows.map((r) => project(r, args.select));
    },
    async count(args: { where?: Row } = {}) {
      record('glLinkPreview', 'count');
      return state.previews.filter((r) => matches(r, args.where)).length;
    },
    async updateMany(args: { where?: Row; data: Row }) {
      record('glLinkPreview', 'updateMany');
      let count = 0;
      for (const r of state.previews) {
        if (!matches(r, args.where)) continue;
        for (const [k, v] of Object.entries(args.data)) r[k] = dbValue(v);
        count += 1;
      }
      state.updateLog.push({ where: args.where, data: { ...args.data }, count });
      return { count };
    },
  };

  const byKey = (model: string, map: Map<string, Row>, keyField: string) => ({
    async findUnique(args: { where: Row; select?: Row }) {
      record(model, 'findUnique');
      const r = map.get(String(args.where[keyField]));
      return r ? project(r, args.select) : null;
    },
  });

  const models: Record<string, unknown> = {
    glLinkPreview,
    glSettings: byKey('glSettings', state.settings, 'tenantId'),
    tenant: byKey('tenant', state.tenants, 'id'),
    companySettings: byKey('companySettings', state.companies, 'tenantId'),
    admin: byKey('admin', state.admins, 'id'),
  };

  const tx: Record<string, unknown> = {
    ...models,
    async $executeRaw(strings: TemplateStringsArray) {
      const sql = strings.join('?');
      record('$tx', 'executeRaw');
      state.rawStatements.push(sql);
      return 0;
    },
    // عبارات المعاملة الدوّارة على اللقطة المُصدَّرة (snapshot.ts): SET TRANSACTION … ثم SET TRANSACTION SNAPSHOT '<id>'
    async $executeRawUnsafe(sql: string) {
      record('$tx', 'executeRaw');
      state.rawStatements.push(sql);
      return 0;
    },
    async $queryRaw(strings: TemplateStringsArray) {
      const sql = strings.join('?');
      state.rawStatements.push(sql);
      state.calls.push('$tx.queryRaw');
      if (/SHOW transaction_read_only/i.test(sql)) return [{ transaction_read_only: 'on' }];
      if (/pg_export_snapshot\(\)/i.test(sql)) return [{ snapshot: '00000003-0000001B-1' }];
      if (/now\(\)/i.test(sql)) return [{ now: state.dbNow }];
      return [];
    },
  };

  const db = new Proxy({ ...models }, {
    get(target, key: string) {
      if (key === '$transaction') {
        return async (fn: unknown, opts?: unknown) => {
          state.calls.push('$transaction');
          state.txOpts.push(opts);
          if (typeof fn !== 'function') throw new Error('المعاملات التفاعلية وحدها مدعومة في القاعدة المزيّفة');
          return (fn as (t: unknown) => Promise<unknown>)(tx);
        };
      }
      if (key === 'then') return undefined;
      if (key in target) return (target as Record<string, unknown>)[key];
      // أي نموذج آخر: يُسجَّل ويرمي — المهمة لا تلمس غير ما سبق
      return new Proxy({}, {
        get: (_t, op: string) => async () => {
          record(key, op);
          throw new Error(`نموذج غير متوقّع في مهمة المعاينة: ${key}.${op}`);
        },
      });
    },
  }) as FakeLinkingDb['db'];
  state.db = db;
  return state;
}

/** ساعة تطبيق قابلة للتحكّم */
export function fakeClock(startIso: string) {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    advance(ms: number) { t += ms; },
    set(iso: string) { t = new Date(iso).getTime(); },
  };
}
