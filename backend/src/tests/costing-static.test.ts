// «ربط الدفاتر» L3 — حارس نصّي لمحرّك التكلفة (services/costing) — العقد §0 القاعدة 5 و§17 C1-4:
//  - لا قيمةَ من prisma (config/database أو @prisma/client أو مخازن *.prisma) إلا streams.ts وsnapshots.ts — والنوع مسموح للجميع؛
//  - ولا شيء من services/gl إلا ../gl/money و../gl/dates (قيمة أو نوعاً) و../gl/types (نوعاً فقط) — فالشاشات تستورده لاحقاً
//    بلا مساس بحارس gl-hooks-static؛ ولا routes/؛
//  - والوحدات الصرفة (types/math/keys/stepper/accounts) بلا ساعة ولا عشوائية، ولا تستورد إلا بعضها و../gl/money؛
//  - والشاشات لا تستدعي المحرّك في هذه الدفعة (D6 — «مظلم» حتى L3b بإذن المالك).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const COSTING = path.join(SRC, 'services', 'costing');
const read = (abs: string): string => fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
/** مسار نسبي إلى src بشرطة أمامية */
const rel = (abs: string): string => path.relative(SRC, abs).split(path.sep).join('/');

/** يزيل التعليقات (الكتلية والسطرية) مع إبقاء النصوص — لا يُخدع الحارس بشيفرة معلَّقة ولا بـ«//» داخل نص */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface ImportRef {
  spec: string;
  /** النوع وحده (import type / export type / كل المحدِّدات type) — يُمحى عند الترجمة */
  typeOnly: boolean;
}

/** كل الاستيرادات الثابتة والتصديرات-من والمطلوبات والاستيراد الديناميكي */
function importsOf(src: string): ImportRef[] {
  const s = stripComments(src);
  const out: ImportRef[] = [];
  const re = /\b(import|export)\s+(type\s+)?([^;'"`]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const clause = m[3].trim();
    let typeOnly = Boolean(m[2]);
    if (!typeOnly) {
      const braces = /^\{([\s\S]*)\}$/.exec(clause);
      if (braces) {
        const specs = braces[1].split(',').map((x) => x.trim()).filter(Boolean);
        typeOnly = specs.length > 0 && specs.every((x) => /^type\s/.test(x));
      }
    }
    out.push({ spec: m[4], typeOnly });
  }
  for (const r of [/\bimport\s*['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (let m = r.exec(s); m; m = r.exec(s)) out.push({ spec: m[1], typeOnly: false });
  }
  return out;
}

/** مسار الاستيراد محلولاً إلى src (للنسبي)، أو المواصفة كما هي للحزم */
function resolved(fileAbs: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  return rel(path.resolve(path.dirname(fileAbs), spec));
}

const VALUE_PRISMA_ALLOWED = new Set(['streams.ts', 'snapshots.ts']);
const PURE = ['types.ts', 'math.ts', 'keys.ts', 'stepper.ts', 'accounts.ts'];
const GL_ALLOWED: Record<string, 'any' | 'type'> = {
  'services/gl/money': 'any',
  'services/gl/dates': 'any',
  'services/gl/types': 'type',
};

function isPrismaModule(r: string): boolean {
  return r === '@prisma/client' || r === '.prisma/client' || /(^|\/)config\/database$/.test(r) || /\.prisma$/.test(r) || /(^|\/)prisma$/.test(r);
}

/** مخالفات ملفّ في services/costing (بالاسم) لنصّه */
function costingViolations(name: string, fileAbs: string, src: string): string[] {
  const v: string[] = [];
  for (const imp of importsOf(src)) {
    const r = resolved(fileAbs, imp.spec);
    if (isPrismaModule(r) && !imp.typeOnly && !VALUE_PRISMA_ALLOWED.has(name)) v.push(`${name}: قيمة prisma من ${imp.spec}`);
    if (r.startsWith('services/gl/') || r === 'services/gl') {
      const allowed = GL_ALLOWED[r];
      if (!allowed) v.push(`${name}: يستورد ${imp.spec} من services/gl`);
      else if (allowed === 'type' && !imp.typeOnly) v.push(`${name}: قيمة من ${imp.spec} (النوع وحده مسموح)`);
    }
    if (/(^|\/)routes(\/|$)/.test(r)) v.push(`${name}: يستورد routes (${imp.spec})`);
    if (PURE.includes(name)) {
      const internal = imp.spec.startsWith('./') && r.startsWith('services/costing/');
      if (!internal && r !== 'services/gl/money' && !(r === 'services/gl/types' && imp.typeOnly)) {
        v.push(`${name}: وحدة صرفة تستورد ${imp.spec}`);
      }
    }
  }
  if (PURE.includes(name)) {
    const code = stripComments(src);
    for (const [re, what] of [
      [/\bDate\.now\b/, 'Date.now'], [/\bMath\.random\b/, 'Math.random'], [/\bnew\s+Date\s*\(\s*\)/, 'new Date()'],
      [/\bperformance\.now\b/, 'performance.now'], [/\bprocess\.hrtime\b/, 'process.hrtime'], [/\bcrypto\.random/, 'crypto.random*'],
    ] as const) {
      if (re.test(code)) v.push(`${name}: ${what} في وحدة صرفة`);
    }
  }
  return v;
}

function costingFiles(): { name: string; abs: string }[] {
  return fs.readdirSync(COSTING, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => ({ name: e.name, abs: path.join(COSTING, e.name) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

test('الحارس نفسه يلتقط المخالفات (نصوص مصطنعة) ولا يخطئ في المسموح', () => {
  const f = path.join(COSTING, 'x.ts');
  const bad = (name: string, src: string) => costingViolations(name, f, src);
  assert.equal(bad('x.ts', "import prisma from '../../config/database';").length, 1);
  assert.equal(bad('x.ts', "import { Prisma } from '@prisma/client';").length, 1);
  assert.equal(bad('x.ts', "import { Prisma, type PrismaClient } from '@prisma/client';").length, 1);
  assert.deepEqual(bad('x.ts', "import type { Prisma } from '@prisma/client';"), []);
  assert.deepEqual(bad('x.ts', "import { type Prisma, type PrismaClient } from '@prisma/client';"), []);
  assert.deepEqual(bad('streams.ts', "import { Prisma } from '@prisma/client';"), []);
  assert.equal(bad('x.ts', "import { createPrismaReconcilerStore } from '../gl/sync/reconcilerStore.prisma';").length, 2, 'gl وprisma معاً');
  assert.equal(bad('x.ts', "import { deriveSourceEvents } from '../gl/sync/desired';").length, 1);
  assert.equal(bad('x.ts', "import { LedgerError } from '../gl/types';").length, 1);
  assert.deepEqual(bad('x.ts', "import type { LocalDate } from '../gl/types';\nimport { toMilli } from '../gl/money';\nimport { zonedStartOfDay } from '../gl/dates';"), []);
  assert.equal(bad('x.ts', "export { a } from '../../routes/warehouse';").length, 1);
  assert.equal(bad('x.ts', "const r = require('../../routes/x');").length, 1);
  assert.equal(bad('x.ts', "const m = await import('../gl/post');").length, 1);
  assert.equal(bad('x.ts', 'import {\n  a,\n  b,\n} from "../gl/builders/invoice";').length, 1, 'استيراد متعدد الأسطر');
  assert.deepEqual(bad('x.ts', "// import prisma from '../../config/database';\n/* import { x } from '../gl/post'; */"), [], 'المعلَّق لا يُحسب');
  assert.equal(bad('stepper.ts', 'const t = Date.now();').length, 1);
  assert.equal(bad('math.ts', 'const r = Math.random();').length, 1);
  assert.equal(bad('keys.ts', 'const d = new Date();').length, 1);
  assert.deepEqual(bad('keys.ts', 'const d = new Date(x.getTime());'), []);
  assert.equal(bad('stepper.ts', "const s = 'Date.now()';").length, 1, 'النصوص تبقى في الفحص (لا تحايل بها)');
  assert.equal(bad('stepper.ts', "import { valueStock } from '../warehouseCost';").length, 1, 'الوحدة الصرفة لا تستورد خارج المحرّك');
  assert.deepEqual(bad('streams.ts', "import { baseQtyOf } from '../units';"), []);
});

test('services/costing: لا قيمة prisma إلا streams/snapshots، ولا services/gl إلا money/dates/types(نوعاً)، ولا routes، والصرف بلا ساعة', () => {
  const files = costingFiles();
  const names = files.map((f) => f.name);
  for (const must of PURE) assert.ok(names.includes(must), `${must} مفقود من services/costing`);
  const violations = files.flatMap((f) => costingViolations(f.name, f.abs, read(f.abs)));
  assert.deepEqual(violations, []);
});

test('types.ts نسخة العقد الحرفية: الأنواع الستة عشر والتحذيرات بالترتيب المتّفق عليه', () => {
  const s = read(path.join(COSTING, 'types.ts'));
  assert.match(s, /هذا الملف يُنسخ من العقد حرفياً/);
  const kinds = /export const MOVE_KINDS = \[([\s\S]*?)\] as const;/.exec(s)?.[1] ?? '';
  const listed = [...stripComments(kinds).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(listed, [
    'RECEIVE', 'VENDOR_RETURN', 'WH_ADJUST', 'ZERO_RUN', 'VAN_LOAD', 'VAN_UNLOAD', 'VAN_ADJUST', 'DAMAGE_OUT', 'VAN_SALE',
    'WAREHOUSE_SALE', 'SALE_CANCEL', 'VAN_RETURN_RESTOCK', 'WAREHOUSE_RETURN_RESTOCK', 'RETURN_WRITE_OFF', 'RETURN_CANCEL', 'RESTOCK_TOGGLE',
  ]);
  // stepper يرتّب تحذيرات اللقطة بهذا الترتيب — تغييره يغيّر اللقطات المخزَّنة
  const warns = /export const STEP_WARNINGS = \[([\s\S]*?)\] as const;/.exec(s)?.[1] ?? '';
  assert.deepEqual([...stripComments(warns).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]), [
    'NEGATIVE_STOCK', 'HOLE_FILLED', 'UNCOSTED_OUT', 'LINK_NOT_FOUND', 'RETURN_UNLINKED', 'WH_RATE_FALLBACK', 'ZERO_RATE_DEFICIT',
  ]);
});

// D6: «الشاشات لا تتغيّر في هذه الدفعة» — التحويل إليها L3b بعد وثيقة فروق C3 وإذن المالك (يُحدَّث هذا الاختبار حينها)
const SCREENS_DARK = [
  'services/warehouseCost.ts', 'services/warehouseStock.ts', 'routes/warehouse.ts', 'routes/invoices.ts', 'routes/receipts.ts',
  'services/accounting.ts', 'services/settlement.ts',
];

test('D6: الشاشات والمسارات التشغيلية لا تستورد services/costing في هذه الدفعة', () => {
  for (const f of SCREENS_DARK) {
    const abs = path.join(SRC, f);
    if (!fs.existsSync(abs)) continue;
    for (const imp of importsOf(read(abs))) {
      const r = resolved(abs, imp.spec);
      assert.ok(!r.startsWith('services/costing'), `${f} يستورد ${imp.spec} (D6)`);
    }
  }
});
