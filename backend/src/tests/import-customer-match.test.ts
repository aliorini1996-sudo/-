// البندان 3 و4 (مراجعة استيراد البيانات 2026-09-17): مطابقة العملاء في الاستيراد. منطق صرف بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildCustomerMatcher, normImportPhone, planCustomerImport, storedCustomerPhone } from '../services/importMatch';
import { IMPORT_ROW_MESSAGES, customerMatchError } from '../services/importLedger';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('normImportPhone: الصيغ الدولية والأرقام العربية ⇒ 05، والجوالات التافهة ⇒ null', () => {
  for (const s of ['+966 50 123 4567', '00966501234567', '501234567', '٠٥٠١٢٣٤٥٦٧', '050-123-4567', '966501234567', '۰۵۰۱۲۳۴۵۶۷']) {
    assert.equal(normImportPhone(s), '0501234567', s);
  }
  for (const s of ['0', '—', '-', '', '   ', '0500', '0000000000', '5555555555', null, undefined]) {
    assert.equal(normImportPhone(s), null, String(s));
  }
  // هاتف أرضي بثمانية أرقام فأكثر يبقى
  assert.equal(normImportPhone('011 234 5678'), '0112345678');
  assert.equal(storedCustomerPhone('0'), '—');
  assert.equal(storedCustomerPhone(' 0501234567 '), '0501234567');
});

test('سيناريو البند 4: فرعا «بنده» بجوال المركز نفسه ⇒ AMBIGUOUS لا الفرع الثاني بصمت، إلا إذا ميّزهما الاسم', () => {
  const match = buildCustomerMatcher([
    { id: 'olaya', code: 'B-1', phone: '0501234567', name: 'بنده العليا' },
    { id: 'naseem', code: 'B-2', phone: '+966501234567', name: 'بنده النسيم' },
  ]);
  assert.deepEqual(match({ phone: '0501234567' }), { error: 'AMBIGUOUS', value: '0501234567' });
  assert.deepEqual(match({ phone: '0501234567', customerName: 'بنده العليا' }), { id: 'olaya' });
  assert.deepEqual(match({ phone: '00966501234567', customerName: 'بنده النسيم' }), { id: 'naseem' });
  // الاسم لا يميّز ⇒ ملتبس
  assert.deepEqual(match({ phone: '0501234567', customerName: 'بنده' }), { error: 'AMBIGUOUS', value: '0501234567' });
  // الكود يحسم
  assert.deepEqual(match({ customerCode: 'B-2', phone: '0501234567' }), { id: 'naseem' });
  const err = customerMatchError(7, match({ phone: '0501234567' }))!;
  assert.deepEqual(err, { row: 7, code: 'CUSTOMER_AMBIGUOUS', message: IMPORT_ROW_MESSAGES.CUSTOMER_AMBIGUOUS, value: '0501234567' });
  assert.equal(IMPORT_ROW_MESSAGES.CUSTOMER_AMBIGUOUS, 'مطابقة ملتبسة: أكثر من عميل بهذا الجوال أو الاسم، أضف كود العميل');
});

test('سيناريو البند 4: «مؤسسة الأمل» و«مؤسسه الامل» عميلان ⇒ AMBIGUOUS بالاسم', () => {
  const match = buildCustomerMatcher([
    { id: 'a', code: 'C-1', phone: '—', name: 'مؤسسة الأمل' },
    { id: 'b', code: 'C-2', phone: '0', name: 'مؤسسه الامل' },
  ]);
  assert.deepEqual(match({ customerName: 'مؤسسة الأمل' }), { error: 'AMBIGUOUS', value: 'مؤسسة الأمل' });
  assert.deepEqual(match({ customerName: 'مؤسسه الامل' }), { error: 'AMBIGUOUS', value: 'مؤسسه الامل' });
  // جوال «—» و«0» في القاعدة لا يدخلان الخريطة: صف بجوال «0» لا يطابق أحداً ويسقط إلى الاسم
  assert.deepEqual(match({ phone: '0', customerName: 'مؤسسة الأمل' }), { error: 'AMBIGUOUS', value: 'مؤسسة الأمل' });
});

test('سيناريو البند 4: كود غير موجود C-105 مع اسم معروف ⇒ NOT_FOUND بلا سقوط إلى الاسم', () => {
  const match = buildCustomerMatcher([{ id: 'known', code: 'C-100', phone: '0501111111', name: 'تموينات الخير' }]);
  assert.deepEqual(match({ customerCode: 'C-105', customerName: 'تموينات الخير', phone: '0501111111' }), { error: 'NOT_FOUND' });
  assert.deepEqual(customerMatchError(3, { error: 'NOT_FOUND' }), { row: 3, code: 'CUSTOMER_NOT_FOUND', message: 'العميل غير موجود استورد العملاء أولا' });
  // بلا كود: الجوال ثم الاسم الفريد
  assert.deepEqual(match({ phone: '+966 50 111 1111' }), { id: 'known' });
  assert.deepEqual(match({ customerName: '  تموينات  الخير ' }), { id: 'known' });
  assert.deepEqual(match({ customerCode: '  ', customerName: 'تموينات الخير' }), { id: 'known' }, 'الكود الفارغ بعد القص غائب');
  // جوال صالح بلا مرشح ⇒ الاسم
  assert.deepEqual(match({ phone: '0509999999', customerName: 'تموينات الخير' }), { id: 'known' });
  assert.deepEqual(match({ phone: '0509999999' }), { error: 'NOT_FOUND' });
  assert.deepEqual(match({}), { error: 'NOT_FOUND' });
});

test('سيناريو البند 3(أ): خمسة فروع «صيدلية النهدي» بأكواد C101..C105 ⇒ خمسة إنشاءات مع تنبيه similar، وإعادة الاستيراد تتخطاها بالكود', () => {
  const rows = [1, 2, 3, 4, 5].map((n) => ({ code: `C10${n}`, name: 'صيدلية النهدي', phone: `05000000${n}${n}` }));
  const plan = planCustomerImport([], rows);
  assert.equal(plan.filter((d) => d.action === 'create').length, 5);
  assert.deepEqual(plan.map((d) => (d.action === 'create' ? d.similar ?? null : d.reason)), [null, 'name', 'name', 'name', 'name']);
  // مع عميل قائم بالاسم نفسه: الخمسة تُنشأ كلها مع التنبيه
  const withExisting = planCustomerImport([{ code: 'OLD-1', phone: '0555555551', name: 'صيدليه النهدي' }], rows);
  assert.deepEqual(withExisting.map((d) => d.action), ['create', 'create', 'create', 'create', 'create']);
  assert.ok(withExisting.every((d) => d.action === 'create' && d.similar === 'name'));
  // جوال مطابق ⇒ matchedBy phone
  const byPhone = planCustomerImport([{ code: 'X', phone: '0500000011', name: 'غيره' }], [rows[0]]);
  assert.deepEqual(byPhone.map((d) => d.action === 'create' && d.similar), ['phone']);
  // إعادة الاستيراد بعد الإنشاء ⇒ CODE_EXISTS لكل فرع (لا إنشاء مكرر)
  const again = planCustomerImport(rows.map((r) => ({ code: r.code, phone: r.phone, name: r.name })), rows);
  assert.deepEqual(again.map((d) => d.action === 'skip' && d.reason), Array(5).fill('CODE_EXISTS'));
  // الكود مكرر داخل الملف ⇒ الثاني يُتخطى
  const dupCode = planCustomerImport([], [rows[0], { ...rows[0], name: 'آخر' }]);
  assert.deepEqual(dupCode.map((d) => d.action), ['create', 'skip']);
});

test('سيناريو البند 3(ب): 800 صف بلا كود بجوال «0» وأسماء مختلفة ⇒ 800 إنشاء لا 401، ويخزَّن «—»', () => {
  const rows = Array.from({ length: 800 }, (_, i) => ({ name: `عميل رقم ${i + 1}`, phone: '0' }));
  const plan = planCustomerImport([{ code: 'Z', phone: '0', name: 'قائم' }], rows);
  const creates = plan.filter((d) => d.action === 'create');
  assert.equal(creates.length, 800);
  assert.ok(creates.every((d) => d.action === 'create' && d.phone === '—'));
  // بلا كود: الجوال الصالح المطابق ⇒ PHONE_EXISTS، ثم الاسم المطبَّع ⇒ NAME_EXISTS
  const skip = planCustomerImport(
    [{ code: 'A', phone: '0501234567', name: 'مؤسسة الأمل' }],
    [{ name: 'جديد', phone: '+966501234567' }, { name: 'مؤسسه الامل', phone: '' }, { name: 'آخر', phone: '0' }],
  );
  assert.deepEqual(skip.map((d) => (d.action === 'skip' ? d.reason : 'create')), ['PHONE_EXISTS', 'NAME_EXISTS', 'create']);
  assert.deepEqual(skip.map((d) => d.row), [2, 3, 4]);
});

test('حارس ثابت: /customers بالمخطِّط وskippedRows وwarnings.similar بلا أسماء قائمة؛ و/balances و/ledger و/prices بالمطابق والرموز', () => {
  const src = read('routes/import.ts');
  const body = (marker: string) => { const i = src.indexOf(marker); assert.ok(i >= 0, marker); return src.slice(i, src.indexOf('\n});', i)); };
  const customers = body("router.post('/customers'");
  assert.match(customers, /customerImportPlanner\(existing\)/);
  assert.doesNotMatch(customers, /names\.has\(|phones\.has\(/, 'التخطي بشرط OR القديم');
  assert.match(customers, /data: \{ \.\.\.result, skippedRows, attachedRows, warnings: \{ similar \} \}/);
  assert.doesNotMatch(src, /async function customerFinder\(/);
  for (const m of ["router.post('/balances'", "router.post('/prices'"]) {
    const b = body(m);
    assert.match(b, /customerMatchError\(/, m);
    assert.doesNotMatch(b, /'العميل غير موجود استورد العملاء أولا'/, `${m}: نص حرفي بلا رمز`);
  }
  assert.match(body("router.post('/ledger'"), /groupLedgerRows\(/);
  assert.doesNotMatch(body("router.post('/ledger'"), /result\.skipped\+\+/, '/ledger: غير المطابَق «مكرر تخطي»');
});

// ═══ مراجعة إصلاحات الدفعة 1: صيغ الجوال الناقصة، والكود الجديد مقابل عميل بكود تلقائي ═══

test('normImportPhone: «+966 05…» و«00966 05…» والجوال المخزَّن رقماً عشرياً «….0» ⇒ 05', () => {
  for (const s of ['+966 0501234567', '009660501234567', '+966 050 123 4567', '00966 0501234567', '0501234567.0', '501234567.0', ' 0501234567.00 ']) {
    assert.equal(normImportPhone(s), '0501234567', s);
  }
  // الأرضي والدولي الآخر لا يُمسّان، والعشري غير الصفري لا يُقصّ
  assert.equal(normImportPhone('011 234 5678'), '0112345678');
  assert.equal(normImportPhone('0.0'), null);
});

test('سيناريو «+966 05…»: لا عميل مكرر في استيراد العملاء، والمطابق يجد العميل في الاتجاهين', () => {
  const plan = planCustomerImport([{ code: 'C1', phone: '0501234567', name: 'بنده' }], [{ phone: '+966 0501234567', name: 'بنده العليا' }]);
  assert.deepEqual(plan.map((d) => (d.action === 'skip' ? d.reason : d.action)), ['PHONE_EXISTS']);
  assert.deepEqual(buildCustomerMatcher([{ id: 'x', phone: '0509999999', name: 'a' }])({ phone: '+966 0509999999' }), { id: 'x' });
  assert.deepEqual(buildCustomerMatcher([{ id: 'y', phone: '+966 0509999999', name: 'b' }])({ phone: '0509999999' }), { id: 'y' });
  for (const s of ['+966 050 123 4567', '00966 0501234567', '0501234567.0', '501234567.0']) {
    assert.deepEqual(buildCustomerMatcher([{ id: 'z', code: 'K-1', phone: '0501234567', name: 'c' }])({ phone: s }), { id: 'z' }, s);
  }
});

test('سيناريو الكود التلقائي: عميل مستورد بلا كود (cuid) ثم ملف أرصدة بكود النظام السابق ⇒ خطأ صريح لا «استورد العملاء أولا»', () => {
  const auto = 'clx9k2m7p0000abcd1234efgh';
  const match = buildCustomerMatcher([{ id: 'nour', code: auto, phone: '0501234567', name: 'بقالة النور' }]);
  const m = match({ customerCode: '1001', customerName: 'بقالة النور', phone: '0501234567' });
  assert.deepEqual(m, { error: 'CODE_NOT_FOUND', value: '1001' });
  const err = customerMatchError(5, m)!;
  assert.deepEqual(err, { row: 5, code: 'CUSTOMER_CODE_NOT_FOUND', message: IMPORT_ROW_MESSAGES.CUSTOMER_CODE_NOT_FOUND, value: '1001' });
  assert.doesNotMatch(err.message, /استورد العملاء أولا/);
  // بالاسم الفريد وحده أيضاً، وبكود فارغ في القاعدة
  assert.deepEqual(buildCustomerMatcher([{ id: 'n', code: null, phone: '—', name: 'بقالة النور' }])({ customerCode: '1001', customerName: 'بقالة النور' }), { error: 'CODE_NOT_FOUND', value: '1001' });
  // العميل ذو الكود البشري المختلف يبقى NOT_FOUND (فرع آخر في سلسلة)
  assert.deepEqual(buildCustomerMatcher([{ id: 'k', code: 'C-100', phone: '0501234567', name: 'بقالة النور' }])({ customerCode: '1001', customerName: 'بقالة النور', phone: '0501234567' }), { error: 'NOT_FOUND' });
  // الكود الموجود يطابق كما هو
  assert.deepEqual(match({ customerCode: auto }), { id: 'nour' });
});

test('سيناريو الكود التلقائي: إعادة استيراد ملف العملاء بالأكواد لا تكرر العملاء المستوردين بلا كود', () => {
  const existing = [
    { code: 'clx9k2m7p0000abcd1234efgh', phone: '0501234567', name: 'بقالة النور' },
    { code: 'clx9k2m7p0001abcd1234efgh', phone: '—', name: 'تموينات الخير' },
    { code: 'B-1', phone: '0555000000', name: 'بنده العليا' },
  ];
  const plan = planCustomerImport(existing, [
    { code: '1001', phone: '0501234567', name: 'بقالة النور' },   // جوال عميل بكود تلقائي
    { code: '1002', phone: '', name: 'تموينات الخير' },            // اسم فريد لعميل بكود تلقائي
    { code: 'B-2', phone: '0555000000', name: 'بنده النسيم' },     // فرع سلسلة: كود بشري ⇒ يُنشأ مع تنبيه
  ]);
  assert.deepEqual(plan.map((d) => (d.action === 'skip' ? d.reason : `${d.action}:${d.similar ?? ''}`)), ['CODE_ATTACHABLE', 'CODE_ATTACHABLE', 'create:phone']);
  // صف بلا كود أُنشئ في الملف نفسه يأخذ كوداً تلقائياً ⇒ الصف اللاحق بكود وجوالِه نفسه لا يُنشأ مكرراً
  const sameFile = planCustomerImport([], [{ phone: '0501234567', name: 'بقالة النور' }, { code: '1001', phone: '0501234567', name: 'بقالة النور' }]);
  assert.deepEqual(sameFile.map((d) => (d.action === 'skip' ? d.reason : d.action)), ['create', 'CODE_ATTACHABLE']);
});

// ═══ الدفعة 2: صيغ الجوال الباقية، وربط الكود بالعميل المستورد بلا كود، والاسم المشترك ═══

test('normImportPhone: الصفر قبل رمز الدولة، والصفر العشري بفاصلة أوروبية أو عربية، والصيغة العلمية، والخلية بجوالين', () => {
  for (const s of ['0966501234567', '0966 50 123 4567', '09660501234567', '0501234567,0', '٠٥٠١٢٣٤٥٦٧٫٠', '5.01234567E+08', '5,01234567E+08',
    '9.66501234567E+11', '0501234567 / 0551234567', '0501234567; 0551234567', '+966 50 123 4567 و 0551234567']) {
    assert.equal(normImportPhone(s), '0501234567', s);
  }
  assert.equal(normImportPhone('966501234567,0'), '0501234567');
  // القائم لا يتغير: الأرضي، والتافه، والرقم المفصول بشرطات مائلة داخل جوال واحد
  assert.equal(normImportPhone('011 234 5678'), '0112345678');
  assert.equal(normImportPhone('050/123/4567'), '0501234567');
  for (const s of ['0', '0,0', '—', '5E+3']) assert.equal(normImportPhone(s), null, s);
});

test('سيناريو «0966…»: لا عميل مكرر في استيراد العملاء، والمطابق يجد العميل بلا اسم', () => {
  const plan = planCustomerImport([{ code: 'C1', phone: '0501234567', name: 'بنده' }], [{ phone: '0966 50 123 4567', name: 'بنده العليا' }]);
  assert.deepEqual(plan.map((d) => (d.action === 'skip' ? d.reason : d.action)), ['PHONE_EXISTS']);
  const match = buildCustomerMatcher([{ id: 'z', code: 'K-1', phone: '0501234567', name: 'c' }]);
  for (const s of ['0966501234567', '0501234567,0', '5.01234567E+08', '0501234567 / 0551234567']) assert.deepEqual(match({ phone: s }), { id: 'z' }, s);
});

test('الانحدار 3(أ): إعادة استيراد العملاء بالأكواد تربط الكود بالعميل المستورد بلا كود (attach) ولا تكرره', () => {
  const autoA = 'clx9k2m7p0000abcd1234efgh';
  const autoB = 'clx9k2m7p0001abcd1234efgh';
  const existing = [
    { id: 'A', code: autoA, phone: '0501234567', name: 'مؤسسة النور' },
    { id: 'B', code: autoB, phone: '—', name: 'تموينات الخير' },
    { id: 'K', code: 'B-1', phone: '0555000000', name: 'بنده العليا' },
  ];
  const rows = [
    { code: 'C001', phone: '0501234567', name: 'مؤسسة النور' },
    { code: 'C002', phone: '', name: 'تموينات الخير' },
    { code: 'C003', phone: '0501234567', name: 'مؤسسة النور فرع 2' }, // الجوال نفسه بعد الربط: فرع جديد مع تنبيه
    { code: 'B-2', phone: '0555000000', name: 'بنده النسيم' },
  ];
  const plan = planCustomerImport(existing, rows);
  assert.deepEqual(plan.map((d) => (d.action === 'attach' ? `attach:${d.customerId}:${d.code}:${d.fromCode}:${d.matchedBy}` : d.action === 'skip' ? d.reason : `create:${d.similar ?? ''}`)), [
    `attach:A:C001:${autoA}:phone`, `attach:B:C002:${autoB}:name`, 'create:phone', 'create:phone',
  ]);
  // بعد الكتابة: ملف الأرصدة بالكود يطابق، وإعادة الملف نفسه تتخطى بالكود
  const after = existing.map((c) => ({ ...c, code: c.id === 'A' ? 'C001' : c.id === 'B' ? 'C002' : c.code }));
  const match = buildCustomerMatcher(after);
  assert.deepEqual(match({ customerCode: 'C001', customerName: 'مؤسسة النور', phone: '0501234567' }), { id: 'A' });
  assert.deepEqual(match({ customerCode: 'C002' }), { id: 'B' });
  assert.deepEqual(planCustomerImport(after, rows.slice(0, 2)).map((d) => d.action === 'skip' && d.reason), ['CODE_EXISTS', 'CODE_EXISTS']);
  // كودان مختلفان للعميل نفسه في الملف: الأول يُربط، والثاني لا يُربط به مرة ثانية
  const twice = planCustomerImport(existing, [{ code: 'X1', phone: '0501234567', name: 'مؤسسة النور' }, { code: 'X2', phone: '0501234567', name: 'مؤسسة النور' }]);
  assert.deepEqual(twice.map((d) => d.action), ['attach', 'create']);
  // عميلان بكود تلقائي بالجوال نفسه: لا يُعرف أيهما ⇒ تخطٍّ لا ربط عشوائي
  const two = planCustomerImport([{ id: 'P', code: autoA, phone: '0501234567', name: 'أ' }, { id: 'Q', code: autoB, phone: '0501234567', name: 'ب' }],
    [{ code: 'C9', phone: '0501234567', name: 'أ' }]);
  assert.deepEqual(two.map((d) => (d.action === 'skip' ? d.reason : d.action)), ['CODE_ATTACHABLE']);
});

test('الانحدار 3(ج): اسم يشترك فيه عميلان بكود تلقائي بلا جوال ⇒ لا عميل ثالث مكرر، والمطابق يعطي خطأ الكود الصريح', () => {
  const existing = [
    { id: 'g1', code: 'clx9k2m7p0000abcd1234efgh', phone: '—', name: 'بقالة' },
    { id: 'g2', code: 'clx9k2m7p0001abcd1234efgh', phone: '0', name: 'بقالة' },
  ];
  const plan = planCustomerImport(existing, [{ code: 'X1', phone: '', name: 'بقالة' }]);
  assert.deepEqual(plan.map((d) => (d.action === 'skip' ? d.reason : d.action)), ['CODE_AMBIGUOUS_NAME']);
  // بجوال جديد يميّزه ⇒ يُنشأ مع تنبيه
  const withPhone = planCustomerImport(existing, [{ code: 'X1', phone: '0509876543', name: 'بقالة' }]);
  assert.deepEqual(withPhone.map((d) => (d.action === 'create' ? d.similar : d.action)), ['name']);
  // اسم مشترك بين عملاء بأكواد بشرية كلهم (فروع سلسلة) ⇒ يُنشأ كما كان
  const chain = planCustomerImport([{ id: 'n1', code: 'N-1', phone: '—', name: 'النهدي' }, { id: 'n2', code: 'N-2', phone: '—', name: 'النهدي' }], [{ code: 'N-3', phone: '', name: 'النهدي' }]);
  assert.deepEqual(chain.map((d) => d.action), ['create']);
  const match = buildCustomerMatcher(existing);
  assert.deepEqual(match({ customerCode: 'X1', customerName: 'بقالة' }), { error: 'CODE_NOT_FOUND', value: 'X1' });
});

test('الانحدار 3(ب): ملف بالكود وحده والشركة فيها عملاء بلا كود ⇒ CUSTOMER_CODE_UNREGISTERED بتلميح لا «استورد العملاء أولا»', () => {
  const match = buildCustomerMatcher([{ id: 'a', code: 'clx9k2m7p0000abcd1234efgh', phone: '0501234567', name: 'مؤسسة النور' }]);
  const m = match({ customerCode: 'C001' });
  assert.deepEqual(m, { error: 'CODE_UNREGISTERED', value: 'C001' });
  const err = customerMatchError(4, m)!;
  assert.deepEqual(err, { row: 4, code: 'CUSTOMER_CODE_UNREGISTERED', message: IMPORT_ROW_MESSAGES.CUSTOMER_CODE_UNREGISTERED, value: 'C001' });
  assert.match(err.message, /استورد ملف العملاء بعمود الكود/);
  // كل العملاء بأكواد بشرية ⇒ NOT_FOUND العام كما كان
  assert.deepEqual(buildCustomerMatcher([{ id: 'k', code: 'K-1', phone: '0501234567', name: 'x' }])({ customerCode: 'C001' }), { error: 'NOT_FOUND' });
  // اسم لا يطابق أحداً مع الكود ⇒ NOT_FOUND
  assert.deepEqual(match({ customerCode: 'C001', customerName: 'غير موجود' }), { error: 'NOT_FOUND' });
});

test('حارس ثابت: /customers يكتب الكود المربوط بشرط الكود التلقائي نفسه، ولا يسجّله في سجلات الدفعة', () => {
  const src = read('routes/import.ts');
  const i = src.indexOf("router.post('/customers'");
  const customers = src.slice(i, src.indexOf('\n});', i));
  assert.match(customers, /select: \{ id: true, phone: true, code: true, name: true \}/);
  assert.match(customers, /planner\.commitAttach\(d\)/);
  assert.match(customers, /updateMany\(\{\s*where: \{ id: a\.customerId, tenantId: tid, \.\.\.\(a\.fromCode !== null \? \{ code: a\.fromCode \} : \{\}\) \}/);
  const attachLoop = customers.slice(customers.indexOf('for (let k = 0; k < attaches.length'), customers.indexOf('} finally {'));
  assert.doesNotMatch(attachLoop, /progress\.(write|commit)\(/, 'العميل المربوط لا يدخل سجلات الدفعة فيحذفه التراجع');
});
