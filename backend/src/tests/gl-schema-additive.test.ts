// M2 — حارس الإضافة على schema.prisma (DESIGN.md §3.0، §3.1، §5.7، §10.1 صف M2: gl-schema-additive.test.ts).
// النطاق أسطر gl وحدها: لا لقطة للملف كله، ولا حظر لإضافات غير محاسبية (جلسة ZATCA تضيف إلى الملف نفسه).
// (أ) داخل الكتلة بين علامتي §3.0، (ب) الأسطر المملوكة للدفاتر خارجها، (ج) العلامتان.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_PATH = path.join(__dirname, '../../prisma/schema.prisma');
const RESET_PATH = path.join(__dirname, '../services/gl/reset.ts');
const OPEN = '// ═══ النظام المحاسبي المتكامل (gl_*) ═══';
const CLOSE = '// ═══ نهاية النظام المحاسبي المتكامل ═══';

const schema = fs.readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');

interface Field { name: string; type: string; attrs: string; raw: string }
interface Model { name: string; body: string[]; fields: Field[]; start: number; end: number }

/** محلّل بسيط: كتل `model X { ... }` مع أسطرها (بلا تعليقات ذيلية) ومواضعها في النص */
function parseModels(src: string): Model[] {
  const out: Model[] = [];
  const re = /^model\s+(\w+)\s*\{[^\n]*\n([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = m[2].split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
    const fields: Field[] = [];
    for (const l of body) {
      if (l.startsWith('@@')) continue;
      const fm = /^(\w+)\s+([\w]+)(\[\])?(\?)?\s*(.*)$/.exec(l);
      if (fm) fields.push({ name: fm[1], type: fm[2], attrs: fm[5] ?? '', raw: l });
    }
    out.push({ name: m[1], body, fields, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const openIdx = schema.indexOf(OPEN);
const closeIdx = schema.indexOf(CLOSE);
const allModels = parseModels(schema);
const modelNames = new Set(allModels.map((x) => x.name));
const inBlock = (x: Model) => openIdx >= 0 && closeIdx > openIdx && x.start > openIdx && x.end < closeIdx;
const glModels = allModels.filter(inBlock);
const outside = allModels.filter((x) => !inBlock(x));
const byName = new Map(allModels.map((x) => [x.name, x]));

function onDeleteOf(f: Field): string | null {
  const od = /onDelete:\s*(\w+)/.exec(f.attrs);
  return od ? od[1] : null;
}
/** علاقات يملكها النموذج (تحمل fields:) نحو نماذج أخرى */
function ownedRelations(x: Model): Field[] {
  return x.fields.filter((f) => modelNames.has(f.type) && /@relation\([^)]*fields:/.test(f.attrs));
}

// ── (ج) العلامتان ─────────────────────────────────────────────────────────────
test('(ج) علامتا الكتلة موجودتان مرة واحدة والختامية بعد الافتتاحية', () => {
  assert.equal(schema.split(OPEN).length - 1, 1, 'العلامة الافتتاحية يجب أن تظهر مرة واحدة');
  assert.equal(schema.split(CLOSE).length - 1, 1, 'العلامة الختامية يجب أن تظهر مرة واحدة');
  assert.ok(closeIdx > openIdx, 'الختامية بعد الافتتاحية');
});

// ── (أ) داخل الكتلة ──────────────────────────────────────────────────────────
test('(أ) الكتلة تحوي نماذج فقط، كلها Gl* بـ@@map("gl_…") وtenantId', () => {
  assert.ok(glModels.length > 0, 'لا نماذج داخل الكتلة');
  const blockText = schema.slice(openIdx + OPEN.length, closeIdx);
  // لا enum ولا تعريفات أخرى داخل الكتلة
  for (const l of blockText.split('\n')) {
    // التعريفات العليا تبدأ من العمود 0 (حقل `type String` داخل نموذج لا يُحتسب)
    assert.ok(!/^(enum|type|view|generator|datasource)\s+\w+\s*(\{|=)/.test(l), `تعريف غير نموذج داخل الكتلة: ${l}`);
  }
  for (const x of glModels) {
    assert.match(x.name, /^Gl[A-Z]\w*$/, `${x.name}: الاسم يبدأ بـGl`);
    const map = x.body.find((l) => l.startsWith('@@map('));
    assert.ok(map && /^@@map\("gl_[a-z0-9_]+"\)$/.test(map), `${x.name}: @@map("gl_…") مفقود أو غير صالح`);
    const tid = x.fields.find((f) => f.name === 'tenantId');
    assert.ok(tid && tid.type === 'String', `${x.name}: tenantId String مطلوب (§3.0)`);
  }
});

test('(أ) لا نموذج Gl* خارج الكتلة', () => {
  for (const x of outside) assert.ok(!/^Gl[A-Z]/.test(x.name), `${x.name} خارج الكتلة`);
});

test('(أ) كل علاقة داخل الكتلة: Tenant بـCascade، وبين gl إما Cascade من الأب أو NoAction، ولا علاقة بجدول قائم آخر', () => {
  for (const x of glModels) {
    for (const f of ownedRelations(x)) {
      const od = onDeleteOf(f);
      if (f.type === 'Tenant') {
        assert.equal(od, 'Cascade', `${x.name}.${f.name}: علاقة Tenant يجب أن تكون Cascade`);
        continue;
      }
      assert.ok(/^Gl[A-Z]/.test(f.type) && inBlock(byName.get(f.type)!),
        `${x.name}.${f.name}: علاقة بنموذج قائم غير Tenant (${f.type}) ممنوعة — المعرّفات نصوص بلا FK (§3.0)`);
      assert.ok(od === 'Cascade' || od === 'NoAction', `${x.name}.${f.name}: onDelete يجب أن يكون Cascade أو NoAction صراحةً`);
    }
    // لا علاقات نحو نماذج قائمة غير Tenant ولو من الجهة العكسية
    for (const f of x.fields) {
      if (modelNames.has(f.type) && f.type !== 'Tenant') {
        assert.ok(/^Gl[A-Z]/.test(f.type), `${x.name}.${f.name}: يشير إلى ${f.type} خارج gl`);
      }
    }
  }
});

test('(أ) كل نموذج Gl* يرتبط بـTenant بـCascade أو بأبٍ متسلسل', () => {
  const memo = new Map<string, boolean>();
  const cascades = (name: string, seen: Set<string>): boolean => {
    if (memo.has(name)) return memo.get(name)!;
    if (seen.has(name)) return false;
    seen.add(name);
    const x = byName.get(name)!;
    const ok = ownedRelations(x).some((f) => onDeleteOf(f) === 'Cascade'
      && (f.type === 'Tenant' || (/^Gl[A-Z]/.test(f.type) && cascades(f.type, seen))));
    memo.set(name, ok);
    return ok;
  };
  for (const x of glModels) assert.ok(cascades(x.name, new Set()), `${x.name}: لا يتسلسل حذفه من Tenant`);
  // المذكوران صراحةً في §10.1
  for (const n of ['GlPartialReconcile', 'GlRepAnalyticDefault']) {
    if (byName.has(n)) {
      const t = ownedRelations(byName.get(n)!).find((f) => f.type === 'Tenant');
      assert.ok(t && onDeleteOf(t) === 'Cascade', `${n}: علاقة Tenant بـCascade`);
    }
  }
});

test('(أ) من M3: كل نموذج Gl* في GL_RESET_ORDER أو GL_RESET_KEEP (GlAuditLog وحده)', async (t) => {
  // TODO(M3): services/gl/reset.ts يُنشأ في M3 (§5.7)؛ حتى ذلك الحين يُتخطى هذا البند.
  if (!fs.existsSync(RESET_PATH)) { t.skip('services/gl/reset.ts غير موجود بعد (M3)'); return; }
  const mod = (await import(RESET_PATH)) as { GL_RESET_ORDER?: readonly string[]; GL_RESET_KEEP?: readonly string[] };
  const order = new Set((mod.GL_RESET_ORDER ?? []).map(String));
  const keep = new Set((mod.GL_RESET_KEEP ?? []).map(String));
  const norm = (s: string) => s.charAt(0).toUpperCase() + s.slice(1); // يقبل glMove أو GlMove
  const orderN = new Set([...order].map(norm));
  const keepN = new Set([...keep].map(norm));
  assert.deepEqual([...keepN].sort(), ['GlAuditLog'], 'GL_RESET_KEEP لا يحوي إلا GlAuditLog');
  for (const x of glModels) {
    assert.ok(orderN.has(x.name) || keepN.has(x.name), `${x.name}: غير مُدرج في GL_RESET_ORDER`);
  }
});

// ── (ب) خارج الكتلة: الأسطر المملوكة للدفاتر وحدها ─────────────────────────────
test('(ب) Tenant.accountingSuiteEnabled Boolean @default(false)', () => {
  const f = byName.get('Tenant')!.fields.find((x) => x.name === 'accountingSuiteEnabled');
  assert.ok(f, 'الحقل مفقود');
  assert.equal(f.type, 'Boolean');
  assert.equal(f.attrs.trim(), '@default(false)');
  assert.ok(!/\?/.test(f.raw.split(/\s+/)[1]), 'غير اختياري');
});

test('(ب) أعمدة الصلاحيات الست في Admin بـ@default(false)', () => {
  const admin = byName.get('Admin')!;
  for (const n of ['canViewLedger', 'canPostJournals', 'canManagePayables', 'canManageBank', 'canCloseLedgerPeriods', 'canConfigureLedger']) {
    const f = admin.fields.find((x) => x.name === n);
    assert.ok(f, `Admin.${n} مفقود`);
    assert.equal(f.type, 'Boolean', `Admin.${n}`);
    assert.equal(f.attrs.trim(), '@default(false)', `Admin.${n}`);
  }
});

test('(ب) فهرس AccountEntry @@index([tenantId, createdAt, id]) غير فريد', () => {
  const ae = byName.get('AccountEntry')!;
  const norm = (l: string) => l.replace(/\s+/g, '');
  assert.ok(ae.body.some((l) => norm(l) === '@@index([tenantId,createdAt,id])'), 'الفهرس مفقود');
  assert.ok(!ae.body.some((l) => /^@@(unique|id)\(\[tenantId,createdAt,id\]/.test(norm(l))), 'يجب ألا يكون فريداً');
  // يتسع في M3 لـRepSettlement وSettlementEntry وفي M9 لـVanLoad وWarehouseEntry (§3.0)
});

test('(ب) علاقات Tenant العكسية Gl* بلا سمات، ولا حقل Gl* على نموذج قائم غير Tenant', () => {
  const tenant = byName.get('Tenant')!;
  const glRev = tenant.fields.filter((f) => /^Gl[A-Z]/.test(f.type));
  for (const f of glRev) {
    assert.equal(f.attrs.trim(), '', `Tenant.${f.name}: علاقة عكسية بلا سمات`);
    assert.ok(/^gl[A-Z]/.test(f.name), `Tenant.${f.name}: الاسم يبدأ بـgl`);
    assert.ok(byName.has(f.type) && inBlock(byName.get(f.type)!), `Tenant.${f.name}: ${f.type} ليس في الكتلة`);
  }
  // كل نموذج gl مرتبط بـTenant له علاقته العكسية
  for (const x of glModels) {
    if (ownedRelations(x).some((f) => f.type === 'Tenant')) {
      assert.ok(glRev.some((f) => f.type === x.name), `Tenant: العلاقة العكسية لـ${x.name} مفقودة`);
    }
  }
  for (const x of outside) {
    if (x.name === 'Tenant') continue;
    for (const f of x.fields) assert.ok(!/^Gl[A-Z]/.test(f.type), `${x.name}.${f.name}: حقل Gl* على نموذج قائم`);
  }
});

test('(ب) لا @unique ولا @@unique على سطر خارج الكتلة يذكر gl أو Gl أو ledger', () => {
  const before = schema.slice(0, openIdx);
  const after = schema.slice(closeIdx + CLOSE.length);
  for (const l of (before + '\n' + after).split('\n')) {
    if (/@@?unique/.test(l) && /(\bgl|Gl[A-Z]|gl_|[lL]edger)/.test(l)) {
      assert.fail(`قيد فريد خارج الكتلة على سطر محاسبي: ${l.trim()}`);
    }
  }
});
