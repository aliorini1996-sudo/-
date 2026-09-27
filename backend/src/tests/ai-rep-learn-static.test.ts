// حلقة التعلّم — حرّاس ثابتون على المصدر: لا تنتقل خبرة شركة إلى أخرى، ولا كتابة على إعدادات الشركة من التعلّم،
// ومفاتيح الرتبة مستثناة من حارس الأرقام. يقرأ المصدر من src (ويتأكد من وجود الملفات فلا ينجح فارغاً).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const LEARN = path.join(SRC, 'ai-rep', 'learn');
const read = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const learnFiles = fs.readdirSync(LEARN).filter(f => f.endsWith('.ts')).map(f => ({ f, s: read(path.join(LEARN, f)) }));

/** نصّ الوسائط بين القوسين المتوازنين بدءاً من موضع «(». */
function argsAt(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return s.slice(open + 1, i); }
  }
  return s.slice(open + 1);
}

test('ملفات حلقة التعلّم موجودة', () => {
  const names = learnFiles.map(x => x.f);
  for (const f of ['store.ts', 'jobs.ts', 'field.ts', 'policy.ts', 'calibration.ts', 'lessons.ts', 'reflect.ts', 'budget.ts', 'signals.ts', 'stats.ts', 'types.ts', 'view.ts']) {
    assert.ok(names.includes(f), `مفقود: ${f}`);
  }
});

test('كل نداء Prisma في learn/* مقيّد بالشركة (tenantId) — إلا قائمة الشركات الموسومة', () => {
  const bad: string[] = [];
  for (const { f, s } of learnFiles) {
    const re = /\b(?:prisma|tx)\.(ai[A-Za-z]+|tenant|customer|invoice|invoiceItem|salesRep|companySettings)\.(findMany|findFirst|findUnique|count|groupBy|aggregate|updateMany|update|deleteMany|delete|create|createMany|upsert)\(/g;
    for (const m of s.matchAll(re)) {
      const at = m.index ?? 0;
      const lineStart = s.lastIndexOf('\n', at);
      const prevLines = s.slice(Math.max(0, s.lastIndexOf('\n', lineStart - 1) - 200), at);
      if (/cross-tenant: tenant-list/.test(prevLines)) continue;
      const args = argsAt(s, at + m[0].length - 1);
      if (!/tenantId/.test(args)) bad.push(`${f}: ${m[0]} …${args.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('كل استعلام SQL خام في learn/* يقيّد كل جدول فعلي بالشركة', () => {
  const bad: string[] = [];
  // الجداول التي فيها عمود tenantId (invoice_items بلا عمود — تُقيَّد عبر ربطها بفاتورة مقيّدة)
  const tableRe = /\b(?:FROM|JOIN)\s+(ai_[a-z_]+|invoices|customers)\b/gi;
  for (const { f, s } of learnFiles) {
    for (const m of s.matchAll(/(?:\$queryRaw|Prisma\.sql)\s*`([\s\S]*?)`/g)) {
      const sql = m[1];
      const tables = [...sql.matchAll(tableRe)].length;
      const filters = [...sql.matchAll(/"tenantId"\s*=\s*\$\{\s*tid\s*\}/g)].length;
      if (tables > 0 && filters < tables) bad.push(`${f}: ${tables} جداول و${filters} قيود — ${sql.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('التعلّم لا يكتب إعدادات الشركة إلا في «إعادة الضبط»', () => {
  const offenders: string[] = [];
  for (const { f, s } of learnFiles) {
    for (const m of s.matchAll(/aiRepSettings\.(update|upsert|create|updateMany)\(/g)) {
      const fnStart = s.lastIndexOf('export async function', m.index ?? 0);
      const fnName = /export async function (\w+)/.exec(s.slice(fnStart))?.[1];
      if (!(f === 'store.ts' && fnName === 'resetLearning')) offenders.push(`${f}:${fnName}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('حارس الأرقام يستثني مفاتيح الترتيب المتعلَّم، والمسارات بلا «مفتاح الشركة»', () => {
  const adv = read(path.join(SRC, 'ai-rep', 'advisor.ts'));
  assert.match(adv, /SKIP_KEYS = new Set\(\[[^\]]*'recommended_order'/);
  const routes = read(path.join(SRC, 'routes', 'aiRep.ts'));
  assert.ok(!routes.includes('مفتاح الشركة'));
});

test('سجلّ الدورة لا يحوي نص السؤال أو الرد', () => {
  const store = read(path.join(LEARN, 'store.ts'));
  const body = store.slice(store.indexOf('export async function recordTurn'), store.indexOf('// ───────────── نسخ المعاملات'));
  assert.ok(body.length > 50);
  assert.ok(!/\b(text|question|answer|content|messages)\s*:/.test(body), 'recordTurn لا يكتب نصاً');
});
