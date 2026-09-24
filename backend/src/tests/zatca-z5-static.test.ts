// فوترة ZATCA المرحلة الثانية — حرّاس Z5 الثابتة (z5_plan §3 Z5.0 «Tests»): نصّية على المصدر، لا قاعدة بيانات ولا شبكة.
//   1) لا يكتب zatcaPhase2StartedAt إلا goLive (onboarding.ts عبر setPhase2StartedAtOnce في onboardingStore.ts).
//   2) Z5.8: مسار التفعيل موصولٌ بـ goLive ومحروسٌ بعلم البيئة (بلا مخزن/بعلم مطفأ يبقى 409 GO_LIVE_UNAVAILABLE).
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

/**
 * هل هذا الموضع داخل حمولة كتابة في Prisma (`data: { … }`)؟ مسحٌ بالأقواس إلى الخلف حتى الكائن الحاوي.
 * لازمٌ لأنّ **قراءةً** تُمرَّر باسمها و**كتابةً** تنسخ العمود من صفٍّ آخر لهما الشكل نفسه:
 *   `zatcaPhase2StartedAt: company?.zatcaPhase2StartedAt` (قراءة، مُدخل النظام الضريبي في مسار الإصدار)
 *   `data: { zatcaPhase2StartedAt: src.zatcaPhase2StartedAt }` (كتابة: نسخ إعدادات/استيراد يُرجع التفعيل أو يُقدّمه)
 * فاستثناء «القراءة» بشكل القيمة وحده يُعمي الحارس عن أقرب طريقٍ لإفساد العمود.
 */
function insideDataPayload(s: string, at: number): boolean {
  for (const m of s.matchAll(/\bdata\s*:/g)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 0;
    let i = start;
    for (; i < s.length; i++) {                     // مدى قيمة data بالأقواس المتوازنة
      const c = s[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') { if (depth === 0) break; depth--; }
      else if ((c === ',' || c === ';') && depth === 0) break;
    }
    if (at > start && at < i) return true;          // يشمل data: rows.map(r => ({ … }))
  }
  return false;
}

/**
 * هل يكتب هذا المصدر عمودَ التفعيل؟
 * كتابةٌ = قيمةٌ ليست select (true) ولا where (null) ولا نوعاً (Date)، **أو** أيّ ورودٍ داخل حمولة data مهما كان شكل
 * قيمته — فالقراءة المُمرَّرة باسمها (Z5.2: `zatcaPhase2StartedAt: company?.zatcaPhase2StartedAt` عند بناء مُدخل
 * النظام الضريبي) مستثناةٌ خارج data وحدها.
 */
function writesPhase2StartedAt(s: string): boolean {
  for (const m of s.matchAll(/zatcaPhase2StartedAt\s*:\s*([^,\n}]*)/g)) {
    const val = m[1].trim();
    const meta = /^(?:true|null|Date\b)/.test(val);                                // select / where / نوع
    const readThrough = /^[A-Za-z_$][\w$]*\??\.zatcaPhase2StartedAt\b/.test(val);   // قراءةٌ تُمرَّر باسمها
    if (insideDataPayload(s, m.index ?? 0) || !(meta || readThrough)) return true;
  }
  return /\.zatcaPhase2StartedAt\s*=(?!=)/.test(s) || /"zatcaPhase2StartedAt"\s*=(?!=)/.test(s);
}

test('حارس عمود التفعيل يفرّق بين قراءةٍ تُمرَّر باسمها وكتابةٍ تنسخه داخل data', () => {
  // يمرّ: القراءة الوحيدة المسموح بها (routes/invoices.ts) وselect وwhere والنوع
  assert.equal(writesPhase2StartedAt('regimeCandidate({ settings: { zatcaPhase2StartedAt: company?.zatcaPhase2StartedAt ?? null } })'), false);
  assert.equal(writesPhase2StartedAt('select: { zatcaPhase2StartedAt: true }'), false);
  assert.equal(writesPhase2StartedAt('where: { tenantId, zatcaPhase2StartedAt: null }'), false);
  assert.equal(writesPhase2StartedAt('interface S { zatcaPhase2StartedAt: Date | null; }'), false);
  // يُمسك: النسخ والإرجاع والتقديم بكل أشكالها
  assert.equal(writesPhase2StartedAt('prisma.companySettings.create({ data: { zatcaPhase2StartedAt: src.zatcaPhase2StartedAt } })'), true);
  assert.equal(writesPhase2StartedAt('update({ where: { tenantId }, data: { zatcaPhase2StartedAt: null } })'), true);
  assert.equal(writesPhase2StartedAt('createMany({ data: rows.map(r => ({ tenantId: r.id, zatcaPhase2StartedAt: r.zatcaPhase2StartedAt })) })'), true);
  assert.equal(writesPhase2StartedAt('data: { zatcaPhase2StartedAt: at }'), true);
  assert.equal(writesPhase2StartedAt('s.zatcaPhase2StartedAt = new Date()'), true);
});

test('zatcaPhase2StartedAt لا يكتبه إلا setPhase2StartedAtOnce (onboardingStore.ts)، ولا يستدعيه إلا goLive في onboarding.ts', () => {
  const ALLOWED_WRITER = 'compliance/zatca/onboardingStore.ts';
  const writers = new Set<string>();
  const callers = new Set<string>();
  for (const f of walk(SRC)) {
    const s = stripComments(read(f));
    if (writesPhase2StartedAt(s)) writers.add(f);
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

test('Z5.8: مسار التفعيل موصولٌ بـ goLive ومحروسٌ بعلم البيئة (بلا مخزن/بعلم مطفأ يبقى 409 GO_LIVE_UNAVAILABLE)', () => {
  const route = stripComments(read('routes/zatca.ts'));
  // المسار الآن معالجٌ غير متزامن يستدعي آلة الحالة goLive
  assert.match(route, /router\.post\('\/go-live', h\(log, async \(req, res\) => \{/);
  assert.match(route, /goLive\(\{\s*store: deps\.store, policy, now: deps\.now, tenantId: ctx\.tenantId, actorId: ctx\.actorId, confirmations\s*\}\)/);
  // شبكة الأمان: بلا مخزن التفعيل أو بعلم ZATCA_GO_LIVE مطفأ ⇒ 409 GO_LIVE_UNAVAILABLE كما اليوم
  assert.match(route, /if \(!deps\.goLiveStore \|\| !goLiveEnvAllows\(goLiveEnvOf\(\), ctx\.tenantId\)\) \{ sendRouteError\(res, 409, 'GO_LIVE_UNAVAILABLE'\); return; \}/);
  // النظرة العامة: goLiveAvailable محسوبة لا حرفية false
  assert.match(route, /goLiveAvailable: goLiveGate\?\.available \?\? false,/);
  // ما زال goLive وحده يكتب zatcaPhase2StartedAt (يحرسه اختبار الكاتب أعلاه)
});

test('compliance/zatca/* وroutes/invoicesZatca.ts لا تستورد services/gl', () => {
  const files = walk(path.join(SRC, 'compliance', 'zatca')).filter(f => f.startsWith('compliance/zatca/'));
  assert.ok(files.includes('compliance/zatca/regime.ts') && files.includes('compliance/zatca/documentStore.prisma.ts'));
  for (const r of ['routes/invoicesZatca.ts', 'routes/invoicesZatcaDeps.ts']) {
    if (fs.existsSync(path.join(SRC, r))) files.push(r);
  }
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
  'compliance/zatca/documentStore.prisma.ts', 'compliance/zatca/settingsGuards.ts', 'routes/invoicesZatca.ts', 'routes/invoicesZatcaDeps.ts', 'routes/invoices.ts',
  'routes/receipts.ts', 'routes/customers.ts', 'routes/products.ts', 'routes/company.ts', 'routes/tenants.ts', 'routes/tracking.ts',
  'routes/zatca.ts', 'routes/customersZatca.ts', 'routes/productsZatca.ts', 'compliance/zatca/buyerData.ts', 'compliance/zatca/buyerParty.ts', 'compliance/zatca/productVat.ts', 'compliance/zatca/issue.ts', 'compliance/zatca/issueChain.ts', 'compliance/zatca/issueSigner.ts', 'compliance/zatca/issueTx.ts', 'compliance/zatca/issueStore.prisma.ts', 'routes/import.ts', 'services/paylink.ts', 'services/repHeartbeat.ts', 'services/erp.ts', 'routes/dashboard.ts', 'routes/reports.ts',
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
