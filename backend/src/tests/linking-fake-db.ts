// «ربط الدفاتر» L2 — قاعدة Prisma مزيّفة عامّة في الذاكرة لاختبارات المعاينة (P1) وتكاملها مع الوحدات الحقيقية.
// ليس ملف اختبار. يقرأ backend/prisma/schema.prisma نفسه فيعرف كل نموذج وحقوله وعلاقاته وقيمه الافتراضية، ويطبّق
// مجموعة Prisma التي تستعملها الوحدات (where بعوامله وعلاقاته وJSON path، وselect/include متداخلة، وorderBy عبر
// علاقة to-one، وtake/skip/cursor/distinct، وcount/aggregate/groupBy)، بفهارس مساواة كسولة فلا يصير كل استعلام
// مسحاً كاملاً (اختبار الأداء: ٢٠ ألف فاتورة).
//
// **القراءة وحدها**: كل create/update/delete/upsert وكل $executeRaw غير «SET TRANSACTION» الأولى في معاملتها تُحصى
// في stats.writes وترمي خطأ «معاملة للقراءة فقط» (25006) — فمعيار «صفر كتابات» يُقاس لا يُفترض. البيانات تُزرع بـseed().
// $queryRaw يفهم «SHOW transaction_read_only» و«SELECT now()» وحدهما (وغيرهما يُحصى ويرمي).
import fs from 'node:fs';
import { compareLocalDate, localDate } from '../services/gl/dates';
import path from 'node:path';
import { LINKED_DEFAULT_RECEIPT_ROUTING, type PreviewOptions } from '../services/gl/linking/types';

// ═══ المخطط ═══

interface FieldDef {
  name: string;
  type: string;
  list: boolean;
  optional: boolean;
  relation: boolean;
  relationName: string | null;
  fields: string[] | null;
  references: string[] | null;
  defaultValue: { kind: 'value'; value: unknown } | { kind: 'now' } | { kind: 'uuid' } | { kind: 'autoinc' } | null;
  updatedAt: boolean;
}

interface RelationDef {
  kind: 'one' | 'many';
  target: string;
  /** حقول هذا النموذج */
  local: string[];
  /** الحقول المقابلة في الهدف */
  remote: string[];
}

interface ModelDef {
  name: string;
  delegate: string;
  fields: Map<string, FieldDef>;
  scalars: string[];
  relations: Map<string, RelationDef>;
  /** مفاتيح فريدة مركّبة (tenantId_sourceKey…) ⇒ حقولها */
  compound: Map<string, string[]>;
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

function parseDefault(attr: string): FieldDef['defaultValue'] {
  const m = /@default\((.*)\)/.exec(attr);
  if (!m) return null;
  let inner = m[1].trim();
  // إغلاق @default( الأول فقط
  let depth = 0;
  let end = inner.length;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '(') depth++;
    else if (inner[i] === ')') { if (depth === 0) { end = i; break; } depth--; }
  }
  inner = inner.slice(0, end).trim();
  if (inner === 'now()') return { kind: 'now' };
  if (inner === 'uuid()' || inner === 'cuid()') return { kind: 'uuid' };
  if (inner === 'autoincrement()') return { kind: 'autoinc' };
  if (inner === 'true' || inner === 'false') return { kind: 'value', value: inner === 'true' };
  if (/^-?\d+(\.\d+)?$/.test(inner)) return { kind: 'value', value: Number(inner) };
  if (inner === '[]') return { kind: 'value', value: [] };
  const s = /^"(.*)"$/.exec(inner);
  if (s) return { kind: 'value', value: s[1] };
  return null;
}

function parseSchema(text: string): Map<string, ModelDef> {
  const models = new Map<string, ModelDef>();
  const blockRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  const raw: { name: string; body: string }[] = [];
  while ((m = blockRe.exec(text))) raw.push({ name: m[1], body: m[2] });
  const names = new Set(raw.map((r) => r.name));
  for (const { name, body } of raw) {
    const fields = new Map<string, FieldDef>();
    const compound = new Map<string, string[]>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      if (line.startsWith('@@')) {
        const u = /^@@(?:unique|id)\(\s*\[([^\]]+)\](?:[^)]*name:\s*"(\w+)")?/.exec(line);
        if (u) {
          const cols = u[1].split(',').map((x) => x.trim().replace(/\(.*\)$/, ''));
          compound.set(u[2] ?? cols.join('_'), cols);
        }
        continue;
      }
      const fm = /^(\w+)\s+([\w]+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!fm) continue;
      const [, fname, ftype, list, opt, attrs] = fm;
      const isRel = names.has(ftype);
      let relationName: string | null = null;
      let rf: string[] | null = null;
      let rr: string[] | null = null;
      const rel = /@relation\(([^)]*)\)/.exec(attrs);
      if (rel) {
        const nm = /^\s*"([^"]+)"/.exec(rel[1]) ?? /name:\s*"([^"]+)"/.exec(rel[1]);
        relationName = nm ? nm[1] : null;
        const f = /fields:\s*\[([^\]]*)\]/.exec(rel[1]);
        const r = /references:\s*\[([^\]]*)\]/.exec(rel[1]);
        rf = f ? f[1].split(',').map((x) => x.trim()).filter(Boolean) : null;
        rr = r ? r[1].split(',').map((x) => x.trim()).filter(Boolean) : null;
      }
      fields.set(fname, {
        name: fname, type: ftype, list: !!list, optional: !!opt, relation: isRel, relationName, fields: rf, references: rr,
        defaultValue: isRel ? null : parseDefault(attrs), updatedAt: /@updatedAt/.test(attrs),
      });
    }
    models.set(name, {
      name, delegate: lowerFirst(name), fields, compound,
      scalars: [...fields.values()].filter((f) => !f.relation).map((f) => f.name),
      relations: new Map(),
    });
  }
  // العلاقات
  for (const model of models.values()) {
    for (const f of model.fields.values()) {
      if (!f.relation) continue;
      const target = models.get(f.type)!;
      if (f.fields && f.references) {
        model.relations.set(f.name, { kind: 'one', target: target.name, local: f.fields, remote: f.references });
        continue;
      }
      const back = [...target.fields.values()].find((g) => g.relation && g.type === model.name && g.relationName === f.relationName
        && !(target.name === model.name && g.name === f.name) && g.fields && g.references);
      if (!back) continue;
      model.relations.set(f.name, { kind: f.list ? 'many' : 'one', target: target.name, local: back.references!, remote: back.fields! });
    }
  }
  return models;
}

// ═══ القيم ═══

type Row = Record<string, unknown>;

function keyOf(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return `d:${v.getTime()}`;
  if (typeof v === 'bigint') return `b:${v}`;
  return `${typeof v}:${String(v)}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype;
}

function eqVal(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof Date || b instanceof Date) return new Date(a as Date).getTime() === new Date(b as Date).getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return BigInt(a as bigint) === BigInt(b as bigint);
  return a === b;
}

function cmpVal(a: unknown, b: unknown): number {
  if (a instanceof Date || b instanceof Date) return new Date(a as Date).getTime() - new Date(b as Date).getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const x = BigInt(a as bigint);
    const y = BigInt(b as bigint);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const s = String(a);
  const t = String(b);
  return s < t ? -1 : s > t ? 1 : 0;
}

/** مجموعات in/notIn مذكَّرة لكل مصفوفة (لا Set جديدة لكل صفّ في المسح) */
const SET_CACHE = new WeakMap<readonly unknown[], Set<string>>();
function keySet(arr: readonly unknown[]): Set<string> {
  let s = SET_CACHE.get(arr);
  if (!s) { s = new Set(arr.map(keyOf)); SET_CACHE.set(arr, s); }
  return s;
}

function jsonClone<T>(v: T): T {
  if (v === null || v === undefined) return v;
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as T;
}

export class FakeReadOnlyError extends Error {
  readonly code = '25006';
  constructor(op: string) {
    super(`cannot execute ${op} in a read-only transaction`);
    this.name = 'FakeReadOnlyError';
  }
}

export interface FakeDbStats {
  /** «نموذج.دالّة» ⇒ عدد الاستدعاءات */
  reads: Map<string, number>;
  /** كل محاولة كتابة (ومنها $executeRaw غير SET الأولى) */
  writes: string[];
  /** نصوص $executeRaw/$queryRaw بترتيبها */
  raw: string[];
  /** خيارات كل $transaction */
  transactions: { timeout?: number; maxWait?: number }[];
  /** معاملات استوردت لقطة مُصدَّرة (SET TRANSACTION SNAPSHOT) */
  snapshotImports: number;
}

interface TxState {
  statements: number;
  readOnly: boolean;
  isolation: string | null;
}

const WRITE_METHODS = ['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];

export interface FakeDbOptions {
  /** ساعة القاعدة لـSELECT now() والقيم الافتراضية now() */
  now?: () => Date;
  schemaPath?: string;
}

let SCHEMA_CACHE: Map<string, ModelDef> | null = null;

export class FakeDb {
  readonly models: Map<string, ModelDef>;
  private readonly byDelegate = new Map<string, ModelDef>();
  private readonly tables = new Map<string, Row[]>();
  private readonly indexes = new Map<string, Map<string, Row[]>>();
  readonly stats: FakeDbStats = { reads: new Map(), writes: [], raw: [], transactions: [], snapshotImports: 0 };
  /** لقطات صدّرتها معاملات (pg_export_snapshot) — الاستيراد يقبلها وحدها */
  private readonly exportedSnapshots = new Set<string>();
  private snapshotSeq = 0;
  now: () => Date;
  private idSeq = 0;
  private autoinc = 0;
  /** العميل خارج أي معاملة */
  readonly client: Record<string, unknown>;

  constructor(opts: FakeDbOptions = {}) {
    if (!SCHEMA_CACHE || opts.schemaPath) {
      const p = opts.schemaPath ?? path.join(__dirname, '..', '..', 'prisma', 'schema.prisma');
      SCHEMA_CACHE = parseSchema(fs.readFileSync(p, 'utf8'));
    }
    this.models = SCHEMA_CACHE;
    for (const m of this.models.values()) this.byDelegate.set(m.delegate, m);
    this.now = opts.now ?? (() => new Date('2027-06-15T09:00:00.000Z'));
    this.client = this.makeClient(null);
  }

  // ── الزرع ──

  model(nameOrDelegate: string): ModelDef {
    const m = this.byDelegate.get(nameOrDelegate) ?? this.models.get(nameOrDelegate);
    if (!m) throw new Error(`fake: نموذج غير معروف ${nameOrDelegate}`);
    return m;
  }

  rows(nameOrDelegate: string): Row[] {
    const m = this.model(nameOrDelegate);
    let t = this.tables.get(m.name);
    if (!t) { t = []; this.tables.set(m.name, t); }
    return t;
  }

  /** يزرع صفوفاً بالقيم الافتراضية للمخطط؛ حقل غير معروف ⇒ خطأ (لا أخطاء إملائية صامتة) */
  seed(nameOrDelegate: string, input: readonly Row[]): Row[] {
    const m = this.model(nameOrDelegate);
    const out: Row[] = [];
    for (const r of input) {
      const row: Row = {};
      for (const k of Object.keys(r)) {
        const f = m.fields.get(k);
        if (!f || f.relation) throw new Error(`fake: حقل غير معروف ${m.name}.${k}`);
      }
      for (const name of m.scalars) {
        const f = m.fields.get(name)!;
        if (r[name] !== undefined) { row[name] = r[name]; continue; }
        const d = f.defaultValue;
        if (d?.kind === 'value') row[name] = Array.isArray(d.value) ? [] : d.value;
        else if (d?.kind === 'now' || f.updatedAt) row[name] = new Date(this.now().getTime());
        else if (d?.kind === 'uuid') row[name] = `${m.delegate}-${String(++this.idSeq).padStart(8, '0')}`;
        else if (d?.kind === 'autoinc') row[name] = ++this.autoinc;
        else row[name] = null;
      }
      this.rows(m.name).push(row);
      out.push(row);
    }
    this.invalidate(m.name);
    return out;
  }

  /** تعديل مباشر لصفّ (للاختبارات: «صفّ قبل البدء تغيّر») — يبطل الفهارس */
  patch(nameOrDelegate: string, id: string, data: Row): void {
    const m = this.model(nameOrDelegate);
    const row = this.rows(m.name).find((r) => r.id === id);
    if (!row) throw new Error(`fake: ${m.name}#${id} غير موجود`);
    Object.assign(row, data);
    this.invalidate(m.name);
  }

  remove(nameOrDelegate: string, id: string): void {
    const m = this.model(nameOrDelegate);
    const t = this.rows(m.name);
    const i = t.findIndex((r) => r.id === id);
    if (i >= 0) t.splice(i, 1);
    this.invalidate(m.name);
  }

  private invalidate(model: string): void {
    for (const k of [...this.indexes.keys()]) if (k.startsWith(`${model}|`)) this.indexes.delete(k);
  }

  private index(model: string, field: string): Map<string, Row[]> {
    const k = `${model}|${field}`;
    let idx = this.indexes.get(k);
    if (!idx) {
      idx = new Map();
      for (const r of this.rows(model)) {
        const v = keyOf(r[field]);
        const list = idx.get(v);
        if (list) list.push(r); else idx.set(v, [r]);
      }
      this.indexes.set(k, idx);
    }
    return idx;
  }

  writeCount(): number {
    return this.stats.writes.length;
  }

  readCount(key?: string): number {
    if (key) return this.stats.reads.get(key) ?? 0;
    let n = 0;
    for (const v of this.stats.reads.values()) n += v;
    return n;
  }

  // ── العميل ──

  private makeClient(tx: TxState | null): Record<string, unknown> {
    const client: Record<string, unknown> = {};
    for (const m of this.models.values()) client[m.delegate] = this.makeDelegate(m, tx);
    const sqlOf = (args: unknown[]): string => {
      const a = args[0] as { raw?: unknown; strings?: unknown } | string;
      if (typeof a === 'string') return a;
      if (Array.isArray(a)) return (a as string[]).join('?');
      if (a && Array.isArray((a as { strings?: unknown }).strings)) return ((a as { strings: string[] }).strings).join('?');
      return String(a);
    };
    const exec = async (...args: unknown[]): Promise<number> => {
      const sql = sqlOf(args).trim();
      this.stats.raw.push(sql);
      if (tx && /^SET\s+TRANSACTION\b/i.test(sql) && tx.statements === 0) {
        tx.statements++;
        if (/READ\s+ONLY/i.test(sql)) tx.readOnly = true;
        const iso = /ISOLATION\s+LEVEL\s+(REPEATABLE\s+READ|SERIALIZABLE|READ\s+COMMITTED)/i.exec(sql);
        if (iso) tx.isolation = iso[1].toUpperCase().replace(/\s+/g, ' ');
        return 0;
      }
      // استيراد لقطة مُصدَّرة (snapshot.ts): ثاني عبارة بعد SET TRANSACTION وحدها، ولمعرّفٍ صدّرته معاملةٌ ما زالت مفتوحة
      const imp = /^SET\s+TRANSACTION\s+SNAPSHOT\s+'([^']+)'$/i.exec(sql);
      if (tx && imp && tx.statements === 1 && tx.isolation === 'REPEATABLE READ') {
        if (!this.exportedSnapshots.has(imp[1])) throw new Error(`invalid snapshot identifier: "${imp[1]}"`);
        tx.statements++;
        this.stats.snapshotImports++;
        return 0;
      }
      if (tx) tx.statements++;
      this.stats.writes.push(`$executeRaw:${sql.slice(0, 80)}`);
      throw new FakeReadOnlyError(sql.split(/\s+/)[0] ?? 'statement');
    };
    const query = async (...args: unknown[]): Promise<unknown[]> => {
      const sql = sqlOf(args).trim();
      this.stats.raw.push(sql);
      if (tx) tx.statements++;
      if (/^SHOW\s+transaction_read_only/i.test(sql)) return [{ transaction_read_only: tx?.readOnly ? 'on' : 'off' }];
      if (/^SHOW\s+transaction_isolation/i.test(sql)) return [{ transaction_isolation: (tx?.isolation ?? 'READ COMMITTED').toLowerCase() }];
      if (/^SELECT\s+now\(\)/i.test(sql)) return [{ now: new Date(this.now().getTime()) }];
      if (/^SELECT\s+pg_export_snapshot\(\)/i.test(sql)) {
        const id = `00000003-0000001B-${++this.snapshotSeq}`;
        this.exportedSnapshots.add(id);
        return [{ snapshot: id }];
      }
      throw new Error(`fake: $queryRaw غير مدعوم: ${sql.slice(0, 120)}`);
    };
    client.$executeRaw = exec;
    client.$executeRawUnsafe = exec;
    client.$queryRaw = query;
    client.$queryRawUnsafe = query;
    client.$transaction = async (arg: unknown, opts?: { timeout?: number; maxWait?: number }) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      this.stats.transactions.push({ timeout: opts?.timeout, maxWait: opts?.maxWait });
      const state: TxState = { statements: 0, readOnly: false, isolation: null };
      const txClient = this.makeClient(state);
      return (arg as (t: unknown) => Promise<unknown>)(txClient);
    };
    return client;
  }

  private makeDelegate(m: ModelDef, tx: TxState | null): Record<string, unknown> {
    const self = this;
    const note = (method: string) => {
      const k = `${m.delegate}.${method}`;
      self.stats.reads.set(k, (self.stats.reads.get(k) ?? 0) + 1);
      if (tx) tx.statements++;
    };
    const d: Record<string, unknown> = {
      async findMany(args: Row = {}) { note('findMany'); return self.findMany(m, args).map((r) => self.project(m, r, args)); },
      async findFirst(args: Row = {}) { note('findFirst'); const r = self.findMany(m, { ...args, take: 1 })[0]; return r ? self.project(m, r, args) : null; },
      async findFirstOrThrow(args: Row = {}) {
        note('findFirstOrThrow');
        const r = self.findMany(m, { ...args, take: 1 })[0];
        if (!r) throw Object.assign(new Error('No record found'), { code: 'P2025' });
        return self.project(m, r, args);
      },
      async findUnique(args: Row = {}) { note('findUnique'); const r = self.findMany(m, { where: args.where, take: 1 })[0]; return r ? self.project(m, r, args) : null; },
      async findUniqueOrThrow(args: Row = {}) {
        note('findUniqueOrThrow');
        const r = self.findMany(m, { where: args.where, take: 1 })[0];
        if (!r) throw Object.assign(new Error('No record found'), { code: 'P2025' });
        return self.project(m, r, args);
      },
      async count(args: Row = {}) {
        note('count');
        const rows = self.findMany(m, { ...args, select: undefined });
        const sel = args.select as Row | undefined;
        if (sel && typeof sel === 'object') {
          const out: Row = {};
          for (const k of Object.keys(sel)) out[k] = k === '_all' ? rows.length : rows.filter((r) => r[k] !== null && r[k] !== undefined).length;
          return out;
        }
        return rows.length;
      },
      async aggregate(args: Row = {}) { note('aggregate'); return self.aggregate(m, self.findMany(m, args), args); },
      async groupBy(args: Row = {}) { note('groupBy'); return self.groupBy(m, args); },
    };
    for (const w of WRITE_METHODS) {
      d[w] = async () => {
        if (tx) tx.statements++;
        self.stats.writes.push(`${m.delegate}.${w}`);
        throw new FakeReadOnlyError(`${m.delegate}.${w}`);
      };
    }
    return d;
  }

  // ── المحرّك ──

  private expandWhere(m: ModelDef, where: Row): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(where)) {
      if (!m.fields.has(k) && m.compound.has(k) && isPlainObject(v)) Object.assign(out, v);
      else out[k] = v;
    }
    return out;
  }

  /** مرشّحون بفهرس مساواة على أول حقل علوي بقيمة بسيطة (أو in قصيرة) */
  private candidates(m: ModelDef, where: Row | undefined): Row[] {
    const all = this.rows(m.name);
    if (!where) return all;
    let best: Row[] | null = null;
    for (const [k, v] of Object.entries(where)) {
      const f = m.fields.get(k);
      if (!f || f.relation || f.type === 'Json') continue;
      let hit: Row[] | null = null;
      if (v !== undefined && v !== null && (typeof v !== 'object' || v instanceof Date)) {
        hit = this.index(m.name, k).get(keyOf(v)) ?? [];
      } else if (isPlainObject(v) && Object.keys(v).length === 1 && v.equals !== undefined && v.equals !== null) {
        hit = this.index(m.name, k).get(keyOf(v.equals)) ?? [];
      } else if (isPlainObject(v) && Object.keys(v).length === 1 && Array.isArray(v.in) && v.in.length <= 5000) {
        const idx = this.index(m.name, k);
        const seen = new Set<Row>();
        hit = [];
        for (const x of v.in as unknown[]) for (const r of idx.get(keyOf(x)) ?? []) if (!seen.has(r)) { seen.add(r); hit.push(r); }
        // ترتيب الإدراج كالجدول
        const order = new Map(all.map((r, i) => [r, i]));
        hit.sort((a, b) => order.get(a)! - order.get(b)!);
      }
      if (hit && (!best || hit.length < best.length)) best = hit;
    }
    return best ?? all;
  }

  findMany(m: ModelDef, args: Row): Row[] {
    const where = args.where ? this.expandWhere(m, args.where as Row) : undefined;
    let rows = this.candidates(m, where);
    if (where) rows = rows.filter((r) => this.match(m, r, where));
    else rows = [...rows];
    if (args.orderBy) rows = this.sort(m, rows, args.orderBy);
    if (args.cursor) {
      const c = this.expandWhere(m, args.cursor as Row);
      const i = rows.findIndex((r) => Object.entries(c).every(([k, v]) => eqVal(r[k], v)));
      rows = i < 0 ? [] : rows.slice(i);
    }
    if (typeof args.skip === 'number') rows = rows.slice(args.skip);
    if (typeof args.take === 'number') rows = args.take >= 0 ? rows.slice(0, args.take) : rows.slice(args.take);
    if (Array.isArray(args.distinct) || typeof args.distinct === 'string') {
      const fields = (Array.isArray(args.distinct) ? args.distinct : [args.distinct]) as string[];
      const seen = new Set<string>();
      rows = rows.filter((r) => {
        const k = fields.map((f) => keyOf(r[f])).join('|');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return rows;
  }

  private related(m: ModelDef, row: Row, relName: string): Row[] {
    const rel = m.relations.get(relName)!;
    const target = this.models.get(rel.target)!;
    if (rel.local.length === 1) {
      const v = row[rel.local[0]];
      if (v === null || v === undefined) return [];
      return this.index(target.name, rel.remote[0]).get(keyOf(v)) ?? [];
    }
    return this.rows(target.name).filter((t) => rel.local.every((lf, i) => eqVal(row[lf], t[rel.remote[i]])));
  }

  match(m: ModelDef, row: Row, where: Row): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (v === undefined) continue;
      if (k === 'AND') {
        const list = Array.isArray(v) ? v : [v];
        if (!list.every((w) => this.match(m, row, this.expandWhere(m, w as Row)))) return false;
        continue;
      }
      if (k === 'OR') {
        const list = v as Row[];
        if (!list.some((w) => this.match(m, row, this.expandWhere(m, w)))) return false;
        continue;
      }
      if (k === 'NOT') {
        const list = Array.isArray(v) ? v : [v];
        if (list.some((w) => this.match(m, row, this.expandWhere(m, w as Row)))) return false;
        continue;
      }
      const f = m.fields.get(k);
      if (!f) throw new Error(`fake: حقل غير معروف في where ${m.name}.${k}`);
      if (f.relation) {
        if (!this.matchRelation(m, row, k, v)) return false;
        continue;
      }
      if (!this.matchScalar(row[k], v, f)) return false;
    }
    return true;
  }

  private matchRelation(m: ModelDef, row: Row, relName: string, filter: unknown): boolean {
    const rel = m.relations.get(relName);
    if (!rel) throw new Error(`fake: علاقة غير محلولة ${m.name}.${relName}`);
    const target = this.models.get(rel.target)!;
    const list = this.related(m, row, relName);
    if (rel.kind === 'one') {
      const r = list[0] ?? null;
      if (filter === null) return r === null;
      const fo = filter as Row;
      if ('is' in fo || 'isNot' in fo) {
        if ('is' in fo) {
          if (fo.is === null) { if (r !== null) return false; } else if (fo.is !== undefined && (!r || !this.match(target, r, this.expandWhere(target, fo.is as Row)))) return false;
        }
        if ('isNot' in fo) {
          if (fo.isNot === null) { if (r === null) return false; } else if (fo.isNot !== undefined && r && this.match(target, r, this.expandWhere(target, fo.isNot as Row))) return false;
        }
        return true;
      }
      return r !== null && this.match(target, r, this.expandWhere(target, fo));
    }
    const fo = filter as Row;
    if (fo.some !== undefined && !list.some((r) => this.match(target, r, this.expandWhere(target, fo.some as Row)))) return false;
    if (fo.every !== undefined && !list.every((r) => this.match(target, r, this.expandWhere(target, fo.every as Row)))) return false;
    if (fo.none !== undefined && list.some((r) => this.match(target, r, this.expandWhere(target, fo.none as Row)))) return false;
    return true;
  }

  private matchScalar(value: unknown, filter: unknown, f: FieldDef): boolean {
    if (filter === null) return value === null || value === undefined;
    if (!isPlainObject(filter)) return eqVal(value, filter);
    if (f.type === 'Json' && ('path' in filter || 'equals' in filter)) {
      let v: unknown = value;
      if (Array.isArray(filter.path)) {
        for (const p of filter.path as string[]) v = v && typeof v === 'object' ? (v as Row)[p] : undefined;
      }
      if ('equals' in filter) return v !== undefined && JSON.stringify(v) === JSON.stringify(filter.equals);
      return true;
    }
    const insensitive = filter.mode === 'insensitive';
    const str = (x: unknown) => (insensitive ? String(x).toLowerCase() : String(x));
    for (const [op, arg] of Object.entries(filter)) {
      if (arg === undefined || op === 'mode') continue;
      const nul = value === null || value === undefined;
      switch (op) {
        case 'equals': if (!eqVal(value, arg)) return false; break;
        case 'not':
          if (arg === null) { if (nul) return false; break; }
          if (isPlainObject(arg)) { if (this.matchScalar(value, arg, f)) return false; break; }
          if (nul || eqVal(value, arg)) return false;
          break;
        case 'in': {
          if (nul || !keySet(arg as unknown[]).has(keyOf(value))) return false;
          break;
        }
        case 'notIn': {
          if (nul || keySet(arg as unknown[]).has(keyOf(value))) return false;
          break;
        }
        case 'lt': if (nul || arg === null || cmpVal(value, arg) >= 0) return false; break;
        case 'lte': if (nul || arg === null || cmpVal(value, arg) > 0) return false; break;
        case 'gt': if (nul || arg === null || cmpVal(value, arg) <= 0) return false; break;
        case 'gte': if (nul || arg === null || cmpVal(value, arg) < 0) return false; break;
        case 'contains': if (nul || !str(value).includes(str(arg))) return false; break;
        case 'startsWith': if (nul || !str(value).startsWith(str(arg))) return false; break;
        case 'endsWith': if (nul || !str(value).endsWith(str(arg))) return false; break;
        case 'has': if (!Array.isArray(value) || !value.some((x) => eqVal(x, arg))) return false; break;
        case 'hasSome': if (!Array.isArray(value) || !(arg as unknown[]).some((a) => value.some((x) => eqVal(x, a)))) return false; break;
        default: throw new Error(`fake: عامل غير مدعوم ${op}`);
      }
    }
    return true;
  }

  private sort(m: ModelDef, rows: Row[], orderBy: unknown): Row[] {
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
    const keys: { get: (r: Row) => unknown; dir: 1 | -1; nulls: 'first' | 'last' | null }[] = [];
    const add = (model: ModelDef, spec: Row, path: string[]) => {
      for (const [k, v] of Object.entries(spec)) {
        const f = model.fields.get(k);
        if (!f) throw new Error(`fake: حقل ترتيب غير معروف ${model.name}.${k}`);
        if (f.relation) {
          const rel = model.relations.get(k)!;
          if (rel.kind !== 'one') throw new Error('fake: ترتيب بعلاقة to-many غير مدعوم');
          add(this.models.get(rel.target)!, v as Row, [...path, k]);
          continue;
        }
        const dir = (typeof v === 'string' ? v : (v as Row).sort) === 'desc' ? -1 : 1;
        const nulls = typeof v === 'object' && v ? ((v as Row).nulls as 'first' | 'last' | undefined) ?? null : null;
        const relPath = [...path];
        keys.push({
          dir, nulls,
          get: (r: Row) => {
            let cur: Row | null = r;
            let curModel = m;
            for (const p of relPath) {
              if (!cur) return null;
              cur = this.related(curModel, cur, p)[0] ?? null;
              curModel = this.models.get(curModel.relations.get(p)!.target)!;
            }
            return cur ? cur[k] : null;
          },
        });
      }
    };
    for (const s of specs) add(m, s, []);
    const decorated = rows.map((r, i) => ({ r, i, k: keys.map((k) => k.get(r)) }));
    decorated.sort((a, b) => {
      for (let j = 0; j < keys.length; j++) {
        const x = a.k[j];
        const y = b.k[j];
        const xn = x === null || x === undefined;
        const yn = y === null || y === undefined;
        if (xn || yn) {
          if (xn && yn) continue;
          // Postgres: NULLS LAST في asc وFIRST في desc ما لم يُحدَّد
          const nullsFirst = keys[j].nulls ? keys[j].nulls === 'first' : keys[j].dir === -1;
          return xn ? (nullsFirst ? -1 : 1) : (nullsFirst ? 1 : -1);
        }
        const c = cmpVal(x, y);
        if (c !== 0) return c * keys[j].dir;
      }
      return a.i - b.i;
    });
    return decorated.map((d) => d.r);
  }

  project(m: ModelDef, row: Row, args: Row): Row {
    const select = args.select as Row | undefined;
    const include = args.include as Row | undefined;
    const out: Row = {};
    if (!select) for (const s of m.scalars) out[s] = row[s] === undefined ? null : row[s];
    const spec = select ?? include ?? {};
    for (const [k, v] of Object.entries(spec)) {
      if (!v) continue;
      if (k === '_count') {
        const sel = (isPlainObject(v) ? (v.select as Row) : null) ?? {};
        const counts: Row = {};
        for (const [rk, rv] of Object.entries(sel)) {
          if (!rv) continue;
          const rel = m.relations.get(rk)!;
          const target = this.models.get(rel.target)!;
          let list = this.related(m, row, rk);
          if (isPlainObject(rv) && rv.where) list = list.filter((r) => this.match(target, r, rv.where as Row));
          counts[rk] = list.length;
        }
        out._count = counts;
        continue;
      }
      const f = m.fields.get(k);
      if (!f) throw new Error(`fake: حقل select غير معروف ${m.name}.${k}`);
      if (!f.relation) { out[k] = row[k] === undefined ? null : row[k]; continue; }
      const rel = m.relations.get(k)!;
      const target = this.models.get(rel.target)!;
      const nested = isPlainObject(v) ? v : {};
      if (rel.kind === 'one') {
        const r = this.related(m, row, k)[0];
        out[k] = r ? this.project(target, r, nested) : null;
      } else {
        let list = this.related(m, row, k);
        if (nested.where) list = list.filter((r) => this.match(target, r, this.expandWhere(target, nested.where as Row)));
        else list = [...list];
        if (nested.orderBy) list = this.sort(target, list, nested.orderBy);
        if (typeof nested.skip === 'number') list = list.slice(nested.skip);
        if (typeof nested.take === 'number') list = list.slice(0, nested.take);
        out[k] = list.map((r) => this.project(target, r, nested));
      }
    }
    return out;
  }

  private aggregate(m: ModelDef, rows: Row[], args: Row): Row {
    const out: Row = {};
    for (const op of ['_sum', '_min', '_max', '_avg'] as const) {
      const spec = args[op] as Row | undefined;
      if (!spec) continue;
      const res: Row = {};
      for (const [field, on] of Object.entries(spec)) {
        if (!on) continue;
        const vals = rows.map((r) => r[field]).filter((x) => x !== null && x !== undefined);
        if (vals.length === 0) { res[field] = null; continue; }
        if (op === '_sum' || op === '_avg') {
          const big = typeof vals[0] === 'bigint';
          const sum = big ? (vals as bigint[]).reduce((a, b) => a + b, 0n) : (vals as number[]).reduce((a, b) => a + b, 0);
          res[field] = op === '_sum' ? sum : (big ? Number(sum) : (sum as number)) / vals.length;
        } else {
          res[field] = vals.reduce((a, b) => ((op === '_min' ? cmpVal(b, a) < 0 : cmpVal(b, a) > 0) ? b : a));
        }
      }
      out[op] = res;
    }
    if (args._count !== undefined) {
      if (args._count === true) out._count = rows.length;
      else {
        const res: Row = {};
        for (const [field, on] of Object.entries(args._count as Row)) {
          if (!on) continue;
          res[field] = field === '_all' ? rows.length : rows.filter((r) => r[field] !== null && r[field] !== undefined).length;
        }
        out._count = res;
      }
    }
    return out;
  }

  private groupBy(m: ModelDef, args: Row): Row[] {
    const by = (Array.isArray(args.by) ? args.by : [args.by]) as string[];
    const rows = this.findMany(m, { where: args.where });
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = by.map((b) => keyOf(r[b])).join('|');
      const g = groups.get(k);
      if (g) g.push(r); else groups.set(k, [r]);
    }
    let out = [...groups.values()].map((g) => {
      const base: Row = {};
      for (const b of by) base[b] = g[0][b] === undefined ? null : g[0][b];
      return { ...base, ...this.aggregate(m, g, args) };
    });
    if (args.orderBy) out = this.sort(m, out, args.orderBy);
    if (typeof args.skip === 'number') out = out.slice(args.skip);
    if (typeof args.take === 'number') out = out.slice(0, args.take);
    return out;
  }

  /** نسخة JSON للحمولات (لاختبارات المساواة) */
  static json<T>(v: T): T { return jsonClone(v); }
}

// ═══ بانٍ لبيانات شركة تشغيلية متّسقة (فواتير بقيودها، سندات، استلامات، روابط دفع، مخزون) ═══

export interface FixtureLine {
  productId: string;
  qty: number;
  unitPrice: number;
  taxPct?: number;
  returnOfItemId?: string | null;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * يكتب صفوف التشغيل كما تكتبها المسارات الحقيقية: الفاتورة وبنودها وصفوف account_entries (النقدية بصفّين
 * INVOICE_DEBIT + RECEIPT_CREDIT)، والإلغاء بصفوفه، والسند (وللإلكتروني رابط الدفع وقيد COLLECTED)، والاسترداد REFUND،
 * والعمولة FEE، والتوريد PAYOUT، والاستلام، والاستيراد ADJUSTMENT_*، والوارد وتحميل السيارة وسجلّ الإعادة للمخزون.
 */
export class TenantFixture {
  private n = 0;
  constructor(readonly db: FakeDb, readonly tenantId = 't1', readonly decimals = 2) {}

  private id(p: string): string {
    this.n++;
    return `${p}-${String(this.n).padStart(6, '0')}`;
  }

  tenant(opts: Row = {}): void {
    this.db.seed('tenant', [{ id: this.tenantId, name: 'شركة الاختبار', ...opts }]);
  }

  company(opts: Row = {}): void {
    this.db.seed('companySettings', [{ tenantId: this.tenantId, name: 'شركة الاختبار', currency: 'SAR', countryCode: 'SA', ...opts }]);
  }

  customer(name: string, id = this.id('cus')): string {
    this.db.seed('customer', [{ id, tenantId: this.tenantId, name, code: id }]);
    return id;
  }

  rep(name: string, id = this.id('rep')): string {
    this.db.seed('salesRep', [{ id, tenantId: this.tenantId, name, username: id }]);
    return id;
  }

  product(name: string, opts: Row = {}, id = this.id('prd')): string {
    this.db.seed('product', [{ id, tenantId: this.tenantId, code: id, name, ...opts }]);
    return id;
  }

  private entry(row: Row): void {
    this.db.seed('accountEntry', [{ id: this.id('ae'), tenantId: this.tenantId, balance: 0, description: '', debit: 0, credit: 0, ...row }]);
  }

  /** فاتورة CASH/CREDIT/RETURN بقيودها؛ at = لحظة الإنشاء، entryDate = تاريخ الأثر (الافتراضي at) */
  invoice(opts: {
    type: 'CASH' | 'CREDIT' | 'RETURN'; customerId: string; repId?: string | null; lines: readonly FixtureLine[]; at: Date;
    entryDate?: Date; returnToStock?: boolean; documentKind?: string | null; id?: string;
  }): { id: string; itemIds: string[]; total: number; subtotal: number; tax: number } {
    const id = opts.id ?? this.id('inv');
    const items = opts.lines.map((l) => {
      const pct = l.taxPct ?? 15;
      const gross = r2(l.qty * l.unitPrice);
      const tax = r2((gross * pct) / 100);
      return { id: this.id('itm'), productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, taxPct: pct, taxAmt: tax, lineTotal: r2(gross + tax), gross, returnOfItemId: l.returnOfItemId ?? null };
    });
    const subtotal = r2(items.reduce((a, i) => a + i.gross, 0));
    const tax = r2(items.reduce((a, i) => a + i.taxAmt, 0));
    const total = r2(subtotal + tax);
    const effect = opts.entryDate ?? opts.at;
    this.db.seed('invoice', [{
      id, tenantId: this.tenantId, number: id, customerId: opts.customerId, salesRepId: opts.repId ?? null, type: opts.type,
      subtotal, taxAmt: tax, total, remainingAmt: opts.type === 'CREDIT' ? total : 0, invoiceDate: effect, createdAt: opts.at,
      returnToStock: opts.returnToStock ?? true, documentKind: opts.documentKind ?? null,
    }]);
    this.db.seed('invoiceItem', items.map((i) => ({
      id: i.id, invoiceId: id, productId: i.productId, qty: i.qty, unitPrice: i.unitPrice, taxPct: i.taxPct, taxAmt: i.taxAmt,
      lineTotal: i.lineTotal, baseQty: i.qty, returnOfItemId: i.returnOfItemId,
    })));
    if (opts.type === 'RETURN') {
      this.entry({ customerId: opts.customerId, invoiceId: id, type: 'INVOICE_CREDIT', credit: total, entryDate: effect, createdAt: opts.at });
    } else {
      this.entry({ customerId: opts.customerId, invoiceId: id, type: 'INVOICE_DEBIT', debit: total, entryDate: effect, createdAt: opts.at });
      if (opts.type === 'CASH') {
        this.entry({ customerId: opts.customerId, invoiceId: id, type: 'RECEIPT_CREDIT', credit: total, entryDate: effect, createdAt: new Date(opts.at.getTime() + 3) });
      }
    }
    return { id, itemIds: items.map((i) => i.id), total, subtotal, tax };
  }

  /** إلغاء فاتورة: صفّ العكس (ونقدية: RECEIPT_DEBIT ما لم يُبقَ التحصيل) */
  cancelInvoice(inv: { id: string; total: number }, type: 'CASH' | 'CREDIT' | 'RETURN', customerId: string, at: Date, opts: { keepCash?: boolean } = {}): void {
    if (type === 'RETURN') {
      this.entry({ customerId, invoiceId: inv.id, type: 'INVOICE_DEBIT', debit: inv.total, entryDate: at, createdAt: at });
    } else {
      this.entry({ customerId, invoiceId: inv.id, type: 'INVOICE_CREDIT', credit: inv.total, entryDate: at, createdAt: at });
      if (type === 'CASH' && !opts.keepCash) {
        this.entry({ customerId, invoiceId: inv.id, type: 'RECEIPT_DEBIT', debit: inv.total, entryDate: at, createdAt: new Date(at.getTime() + 2) });
      }
    }
    this.db.patch('invoice', inv.id, { status: 'CANCELLED' });
  }

  receipt(opts: { customerId: string; repId?: string | null; amount: number; method?: string; at: Date; entryDate?: Date; invoiceId?: string | null }): { id: string; linkId: string | null } {
    const id = this.id('rcp');
    const method = opts.method ?? 'CASH';
    const effect = opts.entryDate ?? opts.at;
    this.db.seed('receipt', [{
      id, tenantId: this.tenantId, number: id, customerId: opts.customerId, salesRepId: opts.repId ?? null, amount: opts.amount,
      paymentMethod: method, receiptDate: effect, createdAt: opts.at,
    }]);
    this.entry({ customerId: opts.customerId, receiptId: id, type: 'RECEIPT_CREDIT', credit: opts.amount, entryDate: effect, createdAt: opts.at });
    let linkId: string | null = null;
    if (method === 'ONLINE' && opts.invoiceId !== null) {
      linkId = this.id('lnk');
      this.db.seed('customerPaymentLink', [{
        id: linkId, tenantId: this.tenantId, token: linkId, invoiceId: opts.invoiceId ?? 'inv-none', customerId: opts.customerId,
        amount: opts.amount, status: 'paid', paidAt: opts.at, receiptId: id, expiresAt: new Date(opts.at.getTime() + 86400_000), createdAt: opts.at,
      }]);
      this.db.seed('settlementEntry', [{ id: this.id('se'), tenantId: this.tenantId, kind: 'COLLECTED', amount: opts.amount, linkId, createdAt: opts.at }]);
    }
    return { id, linkId };
  }

  cancelReceipt(rc: { id: string; linkId: string | null }, customerId: string, amount: number, at: Date, opts: { refund?: boolean } = {}): void {
    if (opts.refund && rc.linkId) {
      this.db.seed('settlementEntry', [{ id: this.id('se'), tenantId: this.tenantId, kind: 'REFUND', amount: -amount, linkId: rc.linkId, createdAt: at }]);
    }
    this.entry({ customerId, receiptId: rc.id, type: 'RECEIPT_DEBIT', debit: amount, entryDate: at, createdAt: new Date(at.getTime() + 1) });
    this.db.patch('receipt', rc.id, { status: 'CANCELLED' });
  }

  fee(linkId: string, amount: number, at: Date): string {
    const id = this.id('se');
    const vat = r2((amount * 15) / 115);
    this.db.seed('settlementEntry', [{ id, tenantId: this.tenantId, kind: 'FEE', amount: -amount, feeNet: r2(amount - vat), feeVat: vat, linkId, createdAt: at }]);
    return id;
  }

  payout(amount: number, at: Date): string {
    const id = this.id('po');
    this.db.seed('payout', [{ id, tenantId: this.tenantId, amount, bankReference: `BR-${id}`, createdAt: at }]);
    this.db.seed('settlementEntry', [{ id: this.id('se'), tenantId: this.tenantId, kind: 'PAYOUT', amount: -amount, payoutId: id, createdAt: at }]);
    return id;
  }

  settlement(opts: { repId: string; amount: number; at: Date; settledAt?: Date; method?: string }): string {
    const id = this.id('st');
    this.db.seed('repSettlement', [{
      id, tenantId: this.tenantId, salesRepId: opts.repId, amount: opts.amount, method: opts.method ?? 'CASH',
      settledAt: opts.settledAt ?? opts.at, createdAt: opts.at,
    }]);
    return id;
  }

  importEntry(opts: { customerId: string; debit?: number; credit?: number; entryDate: Date; at: Date }): string {
    const id = this.id('ae');
    this.db.seed('accountEntry', [{
      id, tenantId: this.tenantId, customerId: opts.customerId, type: (opts.debit ?? 0) > 0 ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT',
      debit: opts.debit ?? 0, credit: opts.credit ?? 0, balance: 0, description: 'رصيد مستورد', entryDate: opts.entryDate, createdAt: opts.at,
    }]);
    return id;
  }

  warehouse(opts: { type?: string; items: readonly { productId: string; qty: number; unitCost?: number | null }[]; at: Date; reason?: string | null }): string {
    const id = this.id('we');
    this.db.seed('warehouseEntry', [{ id, tenantId: this.tenantId, type: opts.type ?? 'RECEIVE', reason: opts.reason ?? null, createdAt: opts.at }]);
    this.db.seed('warehouseEntryItem', opts.items.map((i) => ({
      id: this.id('wei'), entryId: id, productId: i.productId, qty: i.qty, unitCost: i.unitCost ?? null, baseQty: i.qty,
    })));
    return id;
  }

  vanLoad(opts: { repId: string; type?: string; items: readonly { productId: string; qty: number }[]; at: Date }): string {
    const id = this.id('vl');
    this.db.seed('vanLoad', [{ id, tenantId: this.tenantId, salesRepId: opts.repId, type: opts.type ?? 'LOAD', createdAt: opts.at }]);
    this.db.seed('vanLoadItem', opts.items.map((i) => ({ id: this.id('vli'), vanLoadId: id, productId: i.productId, qty: i.qty, baseQty: i.qty })));
    return id;
  }

  restockLog(invoiceId: string, previous: boolean, next: boolean, at: Date): string {
    const id = this.id('rsl');
    this.db.seed('invoiceRestockLog', [{ id, tenantId: this.tenantId, invoiceId, previous, returnToStock: next, createdAt: at }]);
    this.db.patch('invoice', invoiceId, { returnToStock: next });
    return id;
  }
}

// ═══ خيارات معاينة افتراضية لاختبارات P1 (شركة سعودية، ربط من بداية ٢٠٢٧) ═══

export const FIX_TZ = 'Asia/Riyadh';
export const FIX_LINKED_FROM = '2027-01-01';
/** ساعة القاعدة داخل اللقطة */
export const FIX_DB_NOW = new Date('2027-06-15T09:00:00.000Z');

export function previewOptionsFor(over: Partial<PreviewOptions> = {}): PreviewOptions {
  return {
    basis: 'FY_RESTATED', linkedFrom: FIX_LINKED_FROM, templateKey: 'SA_6D', countryCode: 'SA', timezone: FIX_TZ,
    fiscalYearEndMonth: 12, fiscalYearEndDay: 31, weekStartsOn: 0, taxPeriodicity: 'QUARTERLY', currency: 'SAR', currencyDecimals: 2,
    receiptRouting: { ...LINKED_DEFAULT_RECEIPT_ROUTING }, cashInvoiceRouting: 'MAIN_CASH', inventoryMode: 'PERPETUAL',
    categoryIncomeAccounts: [], manualRows: [], midVatPeriod: false, settingsRow: null, draft: null, suiteEnabled: true, workerEnabled: true,
    ...over,
  };
}

/** T0 = ساعة القاعدة − نافذة الالتزام المتأخر (عشر دقائق) */
export const FIX_T0 = new Date(FIX_DB_NOW.getTime() - 10 * 60_000);
const at = (iso: string): Date => new Date(iso);

export interface LinkingScenario { db: FakeDb; f: TenantFixture; c1: string; c2: string; r1: string; p1: string; aeIncluded: (row: Record<string, unknown>) => boolean }

/** بيانات سنة كاملة تغطي معايير القبول (§17 P1 البند 2) */
export function buildLinkingScenario(db: FakeDb = new FakeDb({ now: () => FIX_DB_NOW })): LinkingScenario {
  const f = new TenantFixture(db);
  f.tenant({ accountingSuiteEnabled: true, warehouseEnabled: true });
  f.company();
  const c1 = f.customer('عميل أول');
  const c2 = f.customer('عميل ثانٍ');
  const r1 = f.rep('مندوب أول');
  const p1 = f.product('صنف أ');
  // ما قبل السنة (مشمول بالافتتاح)
  const pre = f.invoice({ type: 'CREDIT', customerId: c1, lines: [{ productId: p1, qty: 10, unitPrice: 10 }], at: at('2026-12-10T08:00:00Z') });
  f.receipt({ customerId: c1, amount: 50, at: at('2026-12-12T08:00:00Z') });
  // عهدة افتتاحية: سند نقدي بمندوب قبل البدء؛ ومخزون افتتاحي: وارد مسعَّر وتحميل سيارة
  f.receipt({ customerId: c1, repId: r1, amount: 25, at: at('2026-12-15T08:00:00Z') });
  f.warehouse({ items: [{ productId: p1, qty: 100, unitCost: 5 }], at: at('2026-11-01T08:00:00Z') });
  f.vanLoad({ repId: r1, items: [{ productId: p1, qty: 20 }], at: at('2026-11-05T08:00:00Z') });
  f.warehouse({ items: [{ productId: p1, qty: 50, unitCost: 6 }], at: at('2027-01-10T08:00:00Z') });
  // مؤرّخ مستقبلاً قبل T0 (أُنشئ في ديسمبر بتاريخ يناير) ⇒ scanFutureDatedRows
  f.invoice({ type: 'CREDIT', customerId: c2, lines: [{ productId: p1, qty: 3, unitPrice: 20 }], at: at('2026-12-20T08:00:00Z'), entryDate: at('2027-01-05T08:00:00Z') });
  // السنة
  f.invoice({ type: 'CREDIT', customerId: c1, repId: r1, lines: [{ productId: p1, qty: 4, unitPrice: 12.5 }], at: at('2027-02-01T08:00:00Z') });
  const cash = f.invoice({ type: 'CASH', customerId: c2, repId: r1, lines: [{ productId: p1, qty: 2, unitPrice: 33.33 }], at: at('2027-02-03T08:00:00Z') });
  f.invoice({ type: 'RETURN', customerId: c1, repId: r1, lines: [{ productId: p1, qty: 1, unitPrice: 12.5 }], at: at('2027-03-01T08:00:00Z') });
  // إلغاء فاتورة ما قبل السنة داخلها (BUILD_FROM_SOURCE)
  f.cancelInvoice(pre, 'CREDIT', c1, at('2027-02-15T08:00:00Z'));
  // سند نقدي بمندوب (عهدة) وسند إلكتروني برابط ثم إلغاؤه باسترداد، وعمولة وتوريد
  f.receipt({ customerId: c1, repId: r1, amount: 40, at: at('2027-03-05T08:00:00Z') });
  const online = f.receipt({ customerId: c2, amount: 76.66, method: 'ONLINE', at: at('2027-03-10T08:00:00Z'), invoiceId: cash.id });
  f.fee(online.linkId!, 2.3, at('2027-03-10T09:00:00Z'));
  const online2 = f.receipt({ customerId: c1, amount: 30, method: 'ONLINE', at: at('2027-03-11T08:00:00Z'), invoiceId: cash.id });
  f.cancelReceipt(online2, c1, 30, at('2027-03-12T08:00:00Z'), { refund: true });
  f.payout(50, at('2027-04-01T08:00:00Z'));
  // استلام المندوب (P7)
  f.settlement({ repId: r1, amount: 40, at: at('2027-03-20T08:00:00Z') });
  // استيراد أرصدة بعد البدء ⇒ 319002 معلَّم
  f.importEntry({ customerId: c2, debit: 120, entryDate: at('2027-04-02T00:00:00Z'), at: at('2027-04-02T08:00:00Z') });
  // وصول متأخر: أثر قبل البدء وإنشاء بعد T0 (داخل نافذة الذيل)
  f.invoice({ type: 'CREDIT', customerId: c2, lines: [{ productId: p1, qty: 1, unitPrice: 9 }], at: at('2027-06-15T08:55:00Z'), entryDate: at('2026-12-28T08:00:00Z') });
  const aeIncluded = (row: Record<string, unknown>) =>
    compareLocalDate(localDate(row.entryDate as Date, FIX_TZ), FIX_LINKED_FROM) < 0 && (row.createdAt as Date).getTime() <= FIX_T0.getTime();
  return { db, f, c1, c2, r1, p1, aeIncluded };
}

