// فوترة ZATCA المرحلة الثانية — حرّاس Z5 الثابتة (z5_plan §3 Z5.0 «Tests»): نصّية على المصدر، لا قاعدة بيانات ولا شبكة.
//   1) لا يكتب zatcaPhase2StartedAt إلا goLive (onboarding.ts عبر setPhase2StartedAtOnce في onboardingStore.ts).
//   2) مسار التفعيل يبقى 409 حتى Z5.8 (يُحدَّث هذا الحارس عمداً حينها).
//   3) compliance/zatca/* وroutes/invoicesZatca.ts لا تستورد services/gl.
//   4) لا مرشّح { not: … } على أعمدة المرحلة الثانية القابلة للإفراغ في ملفات Z5، وكل notIn عليها داخل OR مع null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['tests', 'node_modules', '__fixtures__'].includes(e.name)) walk(p, out);
    } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
      out.push(path.relative(SRC, p).split(path.sep).join('/'));
    }
  }
  return out;
}

test('zatcaPhase2StartedAt لا يكتبه إلا setPhase2StartedAtOnce (onboardingStore.ts)، ولا يستدعيه إلا goLive في onboarding.ts', () => {
  const ALLOWED_WRITER = 'compliance/zatca/onboardingStore.ts';
  const writers = new Set<string>();
  const callers = new Set<string>();
  for (const f of walk(SRC)) {
    const s = stripComments(read(f));
    // data: { zatcaPhase2StartedAt: x } — لا select (true) ولا where (null) ولا نوع (Date)
    if (/zatcaPhase2StartedAt\s*:(?!\s*(?:true|null|Date)\b)/.test(s)) writers.add(f);
    if (/\.zatcaPhase2StartedAt\s*=(?!=)/.test(s)) writers.add(f);
    if (/"zatcaPhase2StartedAt"\s*=(?!=)/.test(s)) writers.add(f);
    if (/\.setPhase2StartedAtOnce\(/.test(s)) callers.add(f);
  }
  assert.deepEqual([...writers], [ALLOWED_WRITER], `كاتب غير goLive: ${[...writers].join('، ')}`);
  assert.deepEqual([...callers], ['compliance/zatca/onboarding.ts']);
  const onboarding = stripComments(read('compliance/zatca/onboarding.ts'));
  const call = onboarding.indexOf('.setPhase2StartedAtOnce(');
  const goLiveStart = onboarding.indexOf('async function goLiveUnsafe(');
  assert.ok(goLiveStart > 0 && call > goLiveStart, 'الاستدعاء خارج goLive');
  assert.equal(onboarding.split('.setPhase2StartedAtOnce(').length - 1, 1);
  // مخطّطات الكتابة العامة لا تقبل العمود (zod يُسقط المفاتيح غير المعرّفة)
  const company = read('routes/company.ts');
  const schema = company.slice(company.indexOf('const companySchema'), company.indexOf('});', company.indexOf('const companySchema')));
  assert.doesNotMatch(schema, /zatcaPhase2StartedAt/);
  const tenants = read('routes/tenants.ts');
  assert.doesNotMatch(tenants, /zatcaPhase2StartedAt/);
});

test('مسار التفعيل ما زال 409 GO_LIVE_UNAVAILABLE (حتى Z5.8) والنظرة العامة goLiveAvailable: false', () => {
  const route = stripComments(read('routes/zatca.ts'));
  assert.match(route, /router\.post\('\/go-live', \(_req, res\) => \{\s*sendRouteError\(res, 409, 'GO_LIVE_UNAVAILABLE'\);\s*\}\);/);
  assert.match(route, /goLiveAvailable: false,/);
  assert.doesNotMatch(route, /\bgoLive\b(?!Available|UnavailableMessage)/, 'goLive موصول قبل Z5.8');
});

test('compliance/zatca/* وroutes/invoicesZatca.ts لا تستورد services/gl', () => {
  const files = walk(path.join(SRC, 'compliance', 'zatca')).filter(f => f.startsWith('compliance/zatca/'));
  assert.ok(files.includes('compliance/zatca/regime.ts') && files.includes('compliance/zatca/documentStore.prisma.ts'));
  if (fs.existsSync(path.join(SRC, 'routes', 'invoicesZatca.ts'))) files.push('routes/invoicesZatca.ts');
  for (const f of files) {
    const s = read(f);
    assert.doesNotMatch(s, /from\s+['"][^'"]*services\/gl[^'"]*['"]|require\(\s*['"][^'"]*services\/gl/, f);
  }
});

// أعمدة المرحلة الثانية القابلة للإفراغ (Invoice، InvoiceItem، Customer، Product، CompanySettings، SalesRep، ZatcaDocument)
const NULLABLE_PHASE2_COLUMNS = [
  'zatcaPhase', 'documentKind', 'invoiceSubtype', 'issuedAt', 'originalInvoiceId', 'billingReference', 'noteReason', 'einvoiceSnapshot',
  'einvoiceProvider', 'einvoiceStatus', 'einvoiceUuid', 'einvoiceQr', 'einvoiceSubmittedAt', 'einvoiceHash', 'einvoicePih', 'einvoiceIcv',
  'einvoiceWarnings', 'seq', 'itemName', 'unitCode', 'vatCategory', 'vatExemptionCode', 'vatExemptionReason', 'creditedItemId', 'buyerType',
  'buyerIdScheme', 'buyerIdValue', 'addrStreet', 'addrBuildingNo', 'addrAdditionalNo', 'addrPostalCode', 'zatcaPhase2StartedAt',
  'clientBundle', 'outboxPending', 'outboxTaxPending', 'outboxReportedAt', 'nextAttemptAt', 'leaseUntil', 'firstSubmitAt', 'finalizedAt',
  'reportDeadline', 'clearedQr', 'keyVersion', 'httpStatus',
];

/** الملفات التي يلمسها Z5 (الموجود منها). */
const Z5_FILES = [
  'compliance/zatca/regime.ts', 'compliance/zatca/status.ts', 'compliance/zatca/errors.ts', 'compliance/zatca/documentStore.ts',
  'compliance/zatca/documentStore.prisma.ts', 'compliance/zatca/settingsGuards.ts', 'routes/invoicesZatca.ts', 'routes/invoices.ts',
  'routes/receipts.ts', 'routes/customers.ts', 'routes/products.ts', 'routes/company.ts', 'routes/tenants.ts', 'routes/tracking.ts',
  'routes/zatca.ts', 'routes/customersZatca.ts', 'routes/productsZatca.ts', 'compliance/zatca/buyerData.ts', 'compliance/zatca/buyerParty.ts', 'compliance/zatca/productVat.ts', 'routes/import.ts', 'services/paylink.ts', 'services/repHeartbeat.ts', 'services/erp.ts', 'routes/dashboard.ts', 'routes/reports.ts',
];

test('فخّ NULL: لا { not: … } على أعمدة المرحلة الثانية في ملفات Z5، وكل notIn عليها داخل OR مع { col: null }', () => {
  const existing = Z5_FILES.filter(f => fs.existsSync(path.join(SRC, f)));
  assert.ok(existing.includes('compliance/zatca/regime.ts') && existing.includes('routes/company.ts'));
  const cols = NULLABLE_PHASE2_COLUMNS.join('|');
  for (const f of existing) {
    const s = stripComments(read(f));
    // { not: null } (IS NOT NULL) صحيح دلالياً؛ غيره يُسقط صفوف NULL
    const not = new RegExp(`\\b(${cols})\\s*:\\s*\\{\\s*not\\s*:(?!\\s*null\\b)`, 'g');
    const bad = [...s.matchAll(not)].map(m => m[1]);
    assert.deepEqual(bad, [], `${f}: مرشّح not على عمود قابل للإفراغ: ${bad.join('، ')}`);
    for (const m of s.matchAll(new RegExp(`\\b(${cols})\\s*:\\s*\\{\\s*notIn\\s*:`, 'g'))) {
      const before = s.slice(Math.max(0, (m.index ?? 0) - 300), m.index);
      assert.match(before, /\bOR\s*:\s*\[/, `${f}: notIn على ${m[1]} خارج OR`);
      assert.match(before, new RegExp(`\\b${m[1]}\\s*:\\s*null\\b`), `${f}: notIn على ${m[1]} بلا فرع null`);
    }
  }
});
