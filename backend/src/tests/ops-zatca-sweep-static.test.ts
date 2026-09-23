// ZATCA المرحلة الثانية (Z5.3) — حرّاس ثابتة على نقطة التشغيل ومحرّك الإرسال (نصّية على المصدر: لا خادم ولا قاعدة ولا شبكة).
//   1) /api/ops/zatca-sweep مركّبة **قبل** محدِّد المعدّل العام، وحارسها مقارنة زمنية ثابتة مع ZATCA_SWEEP_TOKEN، وبلا
//      المتغيّر تردّ 401 دائماً (النقطة مغلقة افتراضياً).
//   2) المسح يبدأ في كتلة الاستماع كبقيّة المجدوِلات، ومفتاح إطفائه ZATCA_SWEEP_ENABLED.
//   3) كل متغيّرات البيئة الجديدة اختيارية: لا قراءة بلا قيمة افتراضية آمنة.
//   4) لا وورك فلو GitHub جديد (قرار المالك: الوورك فلوهات موقوفة — الجدولة داخل العملية).
//   5) محرّك الإرسال نقيّ: لا يستورد config/database ولا services/gl، ولا يستدعي الهيئة داخل معاملة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const ROOT = path.join(SRC, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

test('نقطة /api/ops/zatca-sweep قبل محدِّد المعدّل العام وبعد نقطة التقارير', () => {
  const s = read('index.ts');
  const sweep = s.indexOf("app.post('/api/ops/zatca-sweep'");
  const limiter = s.indexOf("app.use('/api', apiLimiter)");
  assert.ok(sweep > 0, 'النقطة مفقودة');
  assert.ok(limiter > 0, 'محدِّد المعدّل مفقود');
  assert.ok(sweep < limiter, 'النقطة يجب أن تُركَّب قبل محدِّد المعدّل');
});

test('الحارس: x-ops-token بمقارنة زمنية ثابتة مع ZATCA_SWEEP_TOKEN، وبلا المتغيّر 401', () => {
  const s = read('index.ts');
  const start = s.indexOf("app.post('/api/ops/zatca-sweep'");
  const body = s.slice(start, start + 1600);
  assert.match(body, /process\.env\.ZATCA_SWEEP_TOKEN/);
  assert.match(body, /req\.get\('x-ops-token'\)/);
  assert.match(body, /crypto\.timingSafeEqual/);
  assert.match(body, /!expected \|\| a\.length !== b\.length/);
  assert.match(body, /res\.sendStatus\(401\)/);
  // لا مقارنة نصّية مباشرة للرمز
  assert.doesNotMatch(body, /got\s*===\s*expected/);
});

test('المسح يبدأ مع بقيّة المجدوِلات في كتلة الاستماع', () => {
  const s = read('index.ts');
  assert.match(s, /import \{ startZatcaSweep \} from '\.\/services\/zatcaSubmit'/);
  const listen = s.slice(s.indexOf('server.listen(PORT'));
  assert.match(listen, /startZatcaSweep\(\);/);
  const paylink = listen.indexOf('startPaylinkScheduler()');
  assert.ok(paylink > 0 && listen.indexOf('startZatcaSweep()') > paylink, 'يبدأ مع المجدوِلات لا قبلها');
});

test('كل متغيّرات البيئة الجديدة اختيارية بقيم افتراضية آمنة', () => {
  const sweep = read('compliance/zatca/sweep.ts');
  const submit = read('compliance/zatca/submit.ts');
  const svc = read('services/zatcaSubmit.ts');
  // الإطفاء: القيمة الافتراضية «مفعَّل»، ولا رمي حين يغيب المتغيّر
  assert.match(sweep, /export function sweepEnabled/);
  assert.match(sweep, /SWEEP_ENABLED_VAR = 'ZATCA_SWEEP_ENABLED'/);
  assert.match(sweep, /SWEEP_INTERVAL_VAR = 'ZATCA_SWEEP_INTERVAL_MS'/);
  assert.match(submit, /STALE_KEY_VAR = 'ZATCA_SUBMIT_STALE_KEY'/);
  assert.match(svc, /SUBMIT_CONCURRENCY_VAR = 'ZATCA_SUBMIT_CONCURRENCY'/);
  for (const [name, src] of [['sweep.ts', sweep], ['submit.ts', submit], ['services/zatcaSubmit.ts', svc]] as const) {
    assert.doesNotMatch(src, /throw new Error\([^)]*ENV/i, `${name} يرمي عند غياب متغيّر بيئة`);
  }
});

test('لا وورك فلو GitHub جديد للمسح (الجدولة داخل العملية بقرار المالك)', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  assert.equal(files.some(f => /zatca/i.test(f)), false, `وورك فلو ZATCA جديد: ${files.filter(f => /zatca/i.test(f)).join(',')}`);
});

test('محرّك الإرسال نقيّ: لا قاعدة بيانات مباشرة ولا دفاتر، والاستدعاء خارج المعاملة', () => {
  for (const f of ['compliance/zatca/submit.ts', 'compliance/zatca/sweep.ts']) {
    const s = read(f);
    assert.doesNotMatch(s, /from\s+['"][^'"]*config\/database['"]/, `${f} يستورد قاعدة البيانات`);
    assert.doesNotMatch(s, /from\s+['"][^'"]*services\/gl[^'"]*['"]/, `${f} يستورد services/gl`);
  }
  const submit = read('compliance/zatca/submit.ts');
  // الاستدعاء (client.report/clear) خارج أي deps.transaction — لا نداء شبكة داخل معاملة
  const txStart = submit.indexOf('await deps.transaction(async tx =>');
  assert.ok(txStart > 0, 'معاملة النتيجة مفقودة');
  const txBody = submit.slice(txStart, submit.indexOf('});', txStart));
  assert.doesNotMatch(txBody, /client\.(report|clear)\(/, 'استدعاء الهيئة داخل معاملة');
  assert.match(submit, /const outcome: Outcome = claimed\.flow === 'CLEARANCE'/);
});

test('الإرسال لا يلمس صفّ فاتورة ليست من المرحلة الثانية (المرآة عبر المخزن وحده)', () => {
  const submit = read('compliance/zatca/submit.ts');
  assert.doesNotMatch(submit, /\binvoice\.update(Many)?\(/, 'كتابة مباشرة على جدول الفواتير');
  const store = read('compliance/zatca/documentStore.prisma.ts');
  const mirror = store.slice(store.indexOf('async mirrorInvoice'), store.indexOf('async writeApiLog'));
  assert.match(mirror, /where: \{ id: invoiceId, zatcaPhase: 2 \}/, 'المرآة غير مقيّدة بصفوف المرحلة الثانية');
});

test('الاستيلاء الجماعي يستبعد الشركات الموقوفة بربط خارجي (شركة بلا إعدادات لا تُحرم)', () => {
  const store = read('compliance/zatca/documentStore.prisma.ts');
  const claim = store.slice(store.indexOf('async claimBatch'), store.indexOf('async applyOutcome'));
  assert.match(claim, /LEFT JOIN company_settings cs ON cs\."tenantId" = d\."tenantId"/);
  assert.match(claim, /cs\."zatcaSubmitPausedAt" IS NULL/);
  assert.match(claim, /FOR UPDATE OF d SKIP LOCKED/);
});

/* مراجعة عدائية ٢ (النتيجة 7): تمريرة التأخّر تدّعي «استعلاماً مفهرساً واحداً كلّ عشر دورات» — والفهرسان القائمان
 * لا يخدمان شرطها (status مع notIn ليس انتقائياً)، فكان مسحاً تسلسلياً وترتيباً لجدولٍ يحمل بايتات XML كلّ عشر دقائق
 * على قاعدةٍ هي عنق الزجاجة. */
test('جدول المستندات مفهرس لتمريرة التأخّر (reportDeadline + overdueAlertLevel)، ودليل الإرسال عمودٌ مستقلّ', () => {
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  const model = schema.slice(schema.indexOf('model ZatcaDocument {'), schema.indexOf('model ZatcaApiLog {'));
  assert.ok(model.length > 0, 'نموذج ZatcaDocument مفقود');
  assert.match(model, /@@index\(\[reportDeadline, overdueAlertLevel\]\)/, 'تمريرة التأخّر بلا فهرس يخدمها');
  assert.match(model, /sentAttempts\s+Int\s+@default\(0\)/, 'دليل الإرسال (sentAttempts) مفقود من المخطّط');
  // وشرط الاستعلام هو عين أعمدة الفهرس (لا يتباعدان بصمت)
  const store = read('compliance/zatca/documentStore.prisma.ts');
  const overdue = store.slice(store.indexOf('async listOverdue'), store.indexOf('async bumpOverdueAlertLevel'));
  assert.match(overdue, /reportDeadline: \{ lte/);
  assert.match(overdue, /overdueAlertLevel: \{ lt/);
  assert.match(overdue, /orderBy: \[\{ reportDeadline: 'asc' \}/);
});
