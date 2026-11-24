import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CUSTOMER_DUPLICATE, DEDUP_FIELDS, DEDUP_KEYS, DEDUP_LABELS, LOCATION_DUP_RADIUS_M, customerDupFormKey, customerDupOf, customerDupText, dedupAnyOn,
  dedupChecksOf, dedupColumns, dedupToggleMaster,
} from './customerDedup';
import { API_DOC_GROUPS } from './apiDocsCatalog';
import { API_SYNC_RESOURCES } from './apiDocsData';
import { PHRASES } from '../i18n/strings';

// «منع تكرار العملاء عند فتح عميل جديد» (طلب المالك ٢٣ نوفمبر ٢٠٢٦): إعداد المندوب في اللوحة والجوال (مفتاحٌ رئيس وثلاث خانات وسطر
// الموقع الإعلاميّ)، وردّ الخادم 409 CUSTOMER_DUPLICATE تحت حقله في نموذجَي العميل بتطبيق المندوب — المنطق الصرف هنا، والربط بحرّاسٍ على
// المصدر، وعقد الخادم متى وُجد في الشجرة.

const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const id = (s: string) => s; // tr العربية: النصّ نفسه
const NONE = { phone: false, name: false, address: false };

test('الخانات من صفّ المندوب: الغائب والقيمة غير المنطقية مطفأة (تقييديّ يُقرأ بـ=== true)، والمفتاح الرئيس = أيّ خانة', () => {
  assert.deepEqual(dedupChecksOf(undefined), NONE);
  assert.deepEqual(dedupChecksOf(null), NONE);
  assert.deepEqual(dedupChecksOf({}), NONE, 'صفّ خادمٍ أقدم بلا الأعمدة');
  assert.deepEqual(dedupChecksOf({ dedupCustomerPhone: true, dedupCustomerAddress: true }), { phone: true, name: false, address: true });
  assert.deepEqual(dedupChecksOf({ dedupCustomerName: 'true' as unknown as boolean }), NONE, 'نصٌّ لا يُفعّل قيداً');
  assert.equal(dedupAnyOn(NONE), false);
  for (const f of DEDUP_FIELDS) assert.equal(dedupAnyOn({ ...NONE, [f]: true }), true, f);
  // الأعمدة والعناوين بالترتيب المعروض
  assert.deepEqual([...DEDUP_FIELDS], ['phone', 'name', 'address']);
  assert.deepEqual(DEDUP_KEYS, { phone: 'dedupCustomerPhone', name: 'dedupCustomerName', address: 'dedupCustomerAddress' });
  assert.deepEqual(DEDUP_LABELS, { phone: 'رقم الجوال', name: 'الاسم', address: 'العنوان' });
  assert.equal(CUSTOMER_DUPLICATE, 'CUSTOMER_DUPLICATE');
  assert.equal(LOCATION_DUP_RADIUS_M, 30);
});

test('المفتاح الرئيس: تشغيله بلا خانة يختار «رقم الجوال» ومعها يُبقيها، وإطفاؤه يُفرغ الثلاث — والأعمدة صريحةً دائماً', () => {
  assert.deepEqual(dedupToggleMaster(NONE, true), { phone: true, name: false, address: false });
  assert.deepEqual(dedupToggleMaster({ phone: false, name: true, address: true }, true), { phone: false, name: true, address: true }, 'المختار قبلاً يبقى');
  assert.deepEqual(dedupToggleMaster({ phone: true, name: true, address: true }, false), NONE);
  assert.deepEqual(dedupColumns({ phone: true, name: false, address: true }),
    { dedupCustomerPhone: true, dedupCustomerName: false, dedupCustomerAddress: true });
  assert.deepEqual(dedupColumns(NONE), { dedupCustomerPhone: false, dedupCustomerName: false, dedupCustomerAddress: false }, 'false صريحة لا غياب');
});

test('ردّ الخادم: 409 CUSTOMER_DUPLICATE وحده يُقرأ، والحقل المجهول null، والاسم من الخادم وحده (مقصوصاً، والفارغ null)', () => {
  const axiosErr = (data: unknown) => ({ response: { status: 409, data } });
  assert.equal(customerDupOf(null), null);
  assert.equal(customerDupOf(new Error('Network Error')), null, 'خطأ شبكة بلا ردّ');
  assert.equal(customerDupOf(axiosErr({ success: false, code: 'CUSTOMER_LOCATION_EXISTS', message: 'x' })), null, 'رمزٌ آخر');
  assert.equal(customerDupOf(axiosErr('نصّ')), null);
  assert.deepEqual(customerDupOf(axiosErr({ success: false, code: CUSTOMER_DUPLICATE, field: 'phone', message: 'رقم الجوال مسجل لعميل آخر في الشركة' })),
    { field: 'phone', message: 'رقم الجوال مسجل لعميل آخر في الشركة', existingName: null });
  assert.deepEqual(customerDupOf(axiosErr({ code: CUSTOMER_DUPLICATE, field: 'name', message: 'م', existingId: 'c1', existingName: '  بقالة النخيل ' })),
    { field: 'name', message: 'م', existingName: 'بقالة النخيل' });
  assert.deepEqual(customerDupOf(axiosErr({ code: CUSTOMER_DUPLICATE, field: 'email', message: 'رسالة', existingName: '   ' })),
    { field: null, message: 'رسالة', existingName: null });
  assert.deepEqual(customerDupOf(axiosErr({ code: CUSTOMER_DUPLICATE })), { field: null, message: '', existingName: null });
});

test('نصّ الرفض: قوالب الخادم نفسها حرفاً بالعربية — باسم العميل الآخر لمن يراه وإلا «عميل آخر»، والاسم يُكتب حرفاً لا نمطاً', () => {
  const dup = (field: 'phone' | 'name' | 'address' | null, existingName: string | null, message = 'رسالة الخادم') => ({ field, existingName, message });
  assert.equal(customerDupText(dup('phone', 'بقالة النخيل'), id), 'رقم الجوال مسجل للعميل «بقالة النخيل»');
  assert.equal(customerDupText(dup('phone', null), id), 'رقم الجوال مسجل لعميل آخر في الشركة');
  assert.equal(customerDupText(dup('name', 'أسواق الريم'), id), 'اسم العميل مسجل للعميل «أسواق الريم»');
  assert.equal(customerDupText(dup('name', null), id), 'يوجد عميل آخر بالاسم نفسه في الشركة');
  assert.equal(customerDupText(dup('address', 'محل ١'), id), 'العنوان مسجل للعميل «محل ١»');
  assert.equal(customerDupText(dup('address', null), id), 'يوجد عميل آخر بالعنوان نفسه في الشركة');
  assert.equal(customerDupText(dup(null, null), id), 'رسالة الخادم', 'حقلٌ مجهول ⇒ رسالة الخادم');
  assert.equal(customerDupText(dup(null, null, ''), id), 'يوجد عميل آخر بالبيانات نفسها في الشركة');
  assert.equal(customerDupText(dup('phone', 'محل $& و$1'), id), 'رقم الجوال مسجل للعميل «محل $& و$1»');
  // بلغةٍ أخرى: القالب المترجم والاسم كما هو
  const en = (ar: string) => PHRASES[ar]?.en ?? ar;
  assert.equal(customerDupText(dup('phone', 'بقالة النخيل'), en), 'This mobile number is registered to the customer “بقالة النخيل”');
});

test('موضع الرفض في «إضافة عميل»: رفض الاسم والاسم المُرسَل فارغ ⇒ تحت «اسم المنشأة» (بديل الخادم المفحوص)، وغيره تحت حقله', () => {
  assert.equal(customerDupFormKey('name', ''), 'businessName');
  assert.equal(customerDupFormKey('name', '   '), 'businessName', 'مسافاتٌ وحدها فارغة (الخادم يقصّ)');
  assert.equal(customerDupFormKey('name', null), 'businessName');
  assert.equal(customerDupFormKey('name', undefined), 'businessName');
  assert.equal(customerDupFormKey('name', 'بقالة'), 'name', 'الاسم المكتوب هو المفحوص');
  for (const f of ['phone', 'address'] as const) {
    assert.equal(customerDupFormKey(f, ''), f, `${f}: لا بديل`);
    assert.equal(customerDupFormKey(f, 'بقالة'), f);
  }
  assert.equal(customerDupFormKey(null, ''), null, 'حقلٌ مجهول ⇒ رسالة النموذج وحدها');
});

test('الترجمة: كل نصٍّ جديد في القاموس بلغاته الأربع، والفرنسية بلا فاصلةٍ عليا لاتينية', () => {
  const keys = [
    'منع تكرار العملاء عند فتح عميل جديد', 'منع تكرار العملاء', 'لم تختر حقلا فلا يمنع أي تكرار', 'الموقع (ضمن 30 متراً): مفعّل لكل المناديب',
    'عند التفعيل لا يفتح المندوب عميلا جديدا ولا يعدل عميلا إلى رقم جوال أو اسم أو عنوان مما تختاره مسجل لعميل آخر في الشركة، والمقارنة بعد توحيد الكتابة والهمزات وصيغ الجوال، ولا يمس الإدارة ولا العميل المضاف دون اتصال',
    'رقم الجوال مسجل للعميل «{name}»', 'رقم الجوال مسجل لعميل آخر في الشركة', 'اسم العميل مسجل للعميل «{name}»', 'يوجد عميل آخر بالاسم نفسه في الشركة',
    'العنوان مسجل للعميل «{name}»', 'يوجد عميل آخر بالعنوان نفسه في الشركة', 'يوجد عميل آخر بالبيانات نفسها في الشركة',
    'لا يقبل إن كان مسجلا لعميل آخر في الشركة', ...Object.values(DEDUP_LABELS),
  ];
  for (const k of keys) {
    const p = PHRASES[k];
    assert.ok(p, `غائب عن القاموس: ${k}`);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(p[l] && !/[؀-ۿ]/.test(p[l]), `${k} [${l}]`);
    assert.ok(!p.fr.includes("'"), `${k}: فاصلة عليا لاتينية في الفرنسية`);
    if (k.includes('{name}')) for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(p[l].includes('{name}'), `${k} [${l}] بلا {name}`);
  }
});

test('حارس الإعداد في اللوحة: المفتاح الرئيس فوق الخانات الثلاث المسجّلة في النموذج، وسطر الموقع، والقيم صريحةً لكل مندوب', () => {
  const modal = read('src', 'components', 'forms', 'SalesRepModal.tsx');
  const block = modal.slice(modal.indexOf('data-rep-customer-dedup'), modal.indexOf('</div>\n          </div>', modal.indexOf('data-rep-customer-dedup')));
  assert.ok(modal.indexOf("tr('صلاحيات العملاء')") < modal.indexOf('data-rep-customer-dedup'), 'في قسم صلاحيات العملاء');
  assert.ok(modal.indexOf('data-rep-customer-dedup') < modal.indexOf("tr('قيود الموقع الميداني')"));
  assert.match(block, /<PermToggle label=\{tr\('منع تكرار العملاء عند فتح عميل جديد'\)\} checked=\{dedupOn\} onChange=\{e => toggleDedup\(e\.target\.checked\)\} \/>/);
  assert.match(block, /\{dedupOn && \([\s\S]{0,200}DEDUP_FIELDS\.map\(f => <PermToggle key=\{f\} label=\{tr\(DEDUP_LABELS\[f\]\)\} \{\.\.\.register\(DEDUP_KEYS\[f\]\)\} \/>\)/);
  assert.match(block, /\{dedupOn && !dedupAnyOn\(dedupChecks\) && <p [^>]*>\{tr\('لم تختر حقلا فلا يمنع أي تكرار'\)\}<\/p>\}/);
  assert.ok(block.includes("tr('الموقع (ضمن 30 متراً): مفعّل لكل المناديب')"), 'سطر الموقع الإعلامي');
  // الخانات حقول النموذج (ما يُحفظ)، والقيم الافتراضية صريحة، وقلب المفتاح الرئيس يكتبها كلها
  assert.match(modal, /\.\.\.dedupColumns\(dedupChecksOf\(defaults\)\),/);
  assert.match(modal, /const \[dedupOn, setDedupOn\] = useState\(\(\) => dedupAnyOn\(dedupChecksOf\(defaults\)\)\);/);
  assert.match(modal, /const next = dedupToggleMaster\(dedupChecks, on\);\s*DEDUP_FIELDS\.forEach\(f => setValue\(DEDUP_KEYS\[f\], next\[f\], \{ shouldDirty: true \}\)\);/);
  // لا خيار موقعٍ جديد: قاعدة الشركة القائمة لا تُضبط من هنا
  assert.doesNotMatch(modal, /dedupCustomerLocation|register\('dedupCustomer/);
});

test('حارس الإعداد في الجوال: مجموعةٌ بمفتاحٍ رئيس وخاناتٍ ثلاث خارج PermKey («تحديد الكل» لا يمسّها)، والحفظ يرسل الأعمدة صريحةً', () => {
  const m = read('src', 'm', 'MSalesReps.tsx');
  assert.match(m, /<Group title=\{tr\('منع تكرار العملاء'\)\} flush>\s*<MToggle label=\{tr\('منع تكرار العملاء عند فتح عميل جديد'\)\} checked=\{dedupOn\} onChange=\{toggleDedup\}/);
  assert.match(m, /const toggleDedup = \(on: boolean\) => \{ setDedupOn\(on\); setDedupChecks\(c => dedupToggleMaster\(c, on\)\); \};/);
  assert.match(m, /DEDUP_FIELDS\.map\(f => \{\s*const on = dedupChecks\[f\];[\s\S]{0,200}role="checkbox" aria-checked=\{on\}\s*onClick=\{\(\) => setDedupChecks\(c => \(\{ \.\.\.c, \[f\]: !c\[f\] \}\)\)\}/);
  assert.ok(m.includes("<Hint text={tr('الموقع (ضمن 30 متراً): مفعّل لكل المناديب')} />"));
  assert.ok(m.includes("{dedupOn && !dedupAnyOn(dedupChecks) && <Hint text={tr('لم تختر حقلا فلا يمنع أي تكرار')} bad />}"));
  const save = m.slice(m.indexOf('const save = useMutation({', m.indexOf('function RepPerms(')), m.indexOf('onSuccess:', m.indexOf('const save = useMutation({', m.indexOf('function RepPerms('))));
  assert.match(save, /\.\.\.dedupColumns\(dedupChecks\),/);
  for (const [name, at] of [['PermKey', 'type PermKey'], ['GRANTS', 'const GRANTS = [']] as const) {
    const s = m.slice(m.indexOf(at), m.indexOf(';', m.indexOf(at)));
    assert.doesNotMatch(s, /dedup/i, `${name}: قيدٌ يسلب لا يُقلب مع «تحديد الكل»`);
  }
});

test('حارس تطبيق المندوب: رفض التكرار تحت حقله في الإضافة والتعديل، والإضافة دون اتصال كما هي قبله، والتلميح تحت الحقل المفحوص', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  const add = app.slice(app.indexOf('function AddCustomer('), app.indexOf('function EditCustomer('));
  const edit = app.slice(app.indexOf('function EditCustomer('), app.indexOf('// ============ قائمة بسيطة'));
  for (const [name, s] of [['AddCustomer', add], ['EditCustomer', edit]] as const) {
    assert.match(s, /const \{ dup, dupAt, setDup, clearOn \} = useCustomerDup\(\);/, `${name}: الحالة`);
    assert.match(s, /setForm\(f => \(\{ \.\.\.f, \[k\]: v \}\)\);\s*clearOn\(k\);/, `${name}: يزول بتغيير حقله`);
    assert.match(s, /setLoading\(true\); setMsg\(''\);\s*setDup\(null\);/, `${name}: يُمحى مع كل إرسال`);
    assert.match(s, /d \? customerDupText\(d, tr\) : \(err\?\.response\?\.data\?\.message \|\| tr\(/, `${name}: رسالة النموذج بلغة المندوب`);
    assert.match(s, /<RepCustomerInput label=\{label\} value=\{\(form as any\)\[key\]\} onChange=\{v => set\(key, v\)\} dup=\{dup\} dupAt=\{dupAt\} dupKey=\{key\} unique=\{/, `${name}: الحقل`);
  }
  // الإضافة: الاسم المُرسَل فارغاً يأخذ في الخادم اسم المنشأة ⇒ رفض الاسم وتلميحه تحت «اسم المنشأة» (موضعٌ يُثبَّت لحظة الردّ)
  assert.match(add, /const d = customerDupOf\(err\);\s*setDup\(d, customerDupFormKey\(d\?\.field \?\? null, body\.name\)\);/, 'AddCustomer: موضع الرفض');
  assert.match(add, /key === 'businessName' && !form\.name\.trim\(\) && dedupChecked\(uniqueFields, 'name'\)/, 'AddCustomer: تلميح اسم المنشأة');
  assert.match(add, /unique=\{uniqueHere\(key\)\}/);
  // التعديل لا يأخذ بديلاً للاسم: الرفض تحت حقله نفسه
  assert.match(edit, /const d = customerDupOf\(err\);\s*setDup\(d\);/, 'EditCustomer: يُقرأ من الردّ');
  assert.match(edit, /unique=\{dedupChecked\(uniqueFields, key\)\}/);
  // الإضافة دون اتصال: الصفّ أولاً كما كان — الخادم لا يفحص إعادة رفع الصندوق، فلا رفض تكرارٍ يُنتظر هناك
  assert.ok(add.indexOf('if (isNetworkError(err) && !strictRepNow()) {') < add.indexOf('const d = customerDupOf(err);'));
  assert.match(add, /if \(isNetworkError\(err\) && !strictRepNow\(\)\) \{\s*await outboxAdd\(/);
  const input = app.slice(app.indexOf('function RepCustomerInput('), app.indexOf('// ============ إضافة عميل جديد'));
  assert.match(input, /const dupHere = !!dup && dupAt === dupKey;/);
  assert.match(input, /<div data-customer-dup=\{dupHere \? dupKey : undefined\}>/);
  assert.match(input, /\{customerDupText\(dup, tr\)\}/);
  assert.match(input, /tr\('لا يقبل إن كان مسجلا لعميل آخر في الشركة'\)/);
  const hook = app.slice(app.indexOf('function useCustomerDup('), app.indexOf('function RepCustomerInput('));
  assert.match(hook, /document\.querySelector\(`\[data-customer-dup="\$\{state\.at\}"\]`\)\?\.scrollIntoView/);
  assert.match(hook, /at: string \| null = dup\?\.field \?\? null/, 'الموضع افتراضاً حقل الرفض نفسه');
  assert.match(hook, /s\.at === k \|\| s\.dup\.field === k/, 'يزول بتغيير موضعه أو الحقل المفحوص');
  // الحقول المفحوصة من إعدادات المندوب (GET /auth/me) — تلميحٌ لا يمنع، والحكم للخادم
  assert.equal(app.split('uniqueFields={dedupChecksOf(user)}').length - 1, 2, 'الإضافة والتعديل');
  for (const k of ['dedupCustomerPhone', 'dedupCustomerName', 'dedupCustomerAddress']) {
    const repUser = app.slice(app.indexOf('interface RepUser {'), app.indexOf('\n}', app.indexOf('interface RepUser {')));
    assert.match(repUser, new RegExp(`\\b${k}\\?: boolean;`), `RepUser.${k}`);
  }
});

test('النوع والمستند: الأعمدة الثلاثة في SalesRep وفي جسم POST /sales-reps وقائمة المناديب ومورد المزامنة، و409 CUSTOMER_DUPLICATE للمندوب وحده', () => {
  const types = read('src', 'types', 'index.ts');
  const rep = types.slice(types.indexOf('export interface SalesRep {'), types.indexOf('\n}', types.indexOf('export interface SalesRep {')));
  for (const k of Object.values(DEDUP_KEYS)) assert.match(rep, new RegExp(`\\b${k}\\?: boolean;`), k);
  const ep = (method: string, p: string) => API_DOC_GROUPS.flatMap((g) => g.endpoints).find((e) => e.method === method && e.path === p)!;
  for (const k of Object.values(DEDUP_KEYS)) {
    const f = ep('POST', '/sales-reps').body.find((b) => b.name === k);
    assert.ok(f && f.type === 'boolean' && f.required === false && /false افتراضاً/.test(f.desc), `POST /sales-reps: ${k}`);
    assert.ok(ep('PUT', '/sales-reps/:id').body.some((b) => b.desc.includes(k)), `PUT /sales-reps/:id: ${k}`);
    assert.match(ep('GET', '/sales-reps').response, new RegExp(`\\b${k}\\b`), `GET /sales-reps: ${k}`);
    assert.match(API_SYNC_RESOURCES.find((r) => r.name === 'sales-reps')!.what, new RegExp(k), `مورد المزامنة: ${k}`);
  }
  for (const [m, p] of [['POST', '/customers'], ['PUT', '/customers/:id']] as const) {
    const r = ep(m, p).rules.find((x) => x.includes('CUSTOMER_DUPLICATE'));
    assert.ok(r && /المفتاح لا يُفحص/.test(r), `${m} ${p}: الرمز للمندوب وحده`);
  }
  assert.match(ep('POST', '/customers').rules.find((x) => x.includes('CUSTOMER_DUPLICATE'))!, /field:'phone'\|'name'\|'address', message, existingId\?, existingName\?/);
});

test('عقد الخادم (متى وُجد في الشجرة): الرمز وقوالب الرسائل كما يقرؤها التطبيق، والأعمدة في مخطّط المندوب واختياره و/auth/me والمزامنة', (t) => {
  const backend = path.resolve(process.cwd(), '..', 'backend', 'src');
  const svcPath = path.join(backend, 'services', 'customerDedup.ts');
  if (!fs.existsSync(svcPath)) { t.skip('الخادم بلا الميزة في هذه الشجرة'); return; }
  const svc = read('..', 'backend', 'src', 'services', 'customerDedup.ts');
  assert.ok(svc.includes(`export const CUSTOMER_DUPLICATE = '${CUSTOMER_DUPLICATE}';`));
  // القوالب حرفاً: تطبيق المندوب يعيد بناء الرسالة بلغته من field وexistingName
  for (const [field, seen, hidden] of [
    ['phone', 'رقم الجوال مسجل للعميل «${n}»', 'رقم الجوال مسجل لعميل آخر في الشركة'],
    ['name', 'اسم العميل مسجل للعميل «${n}»', 'يوجد عميل آخر بالاسم نفسه في الشركة'],
    ['address', 'العنوان مسجل للعميل «${n}»', 'يوجد عميل آخر بالعنوان نفسه في الشركة'],
  ] as const) {
    assert.ok(svc.includes(`${field}: { seen: (n) => \`${seen}\`, hidden: '${hidden}' }`), `قالب ${field}`);
    assert.equal(customerDupText({ field, existingName: 'س', message: '' }, id), seen.replace('${n}', 'س'));
    assert.equal(customerDupText({ field, existingName: null, message: '' }, id), hidden);
  }
  assert.match(svc, /\.\.\.\(canSee && \{ existingId: dup\.id, existingName: dup\.name \}\)/, 'الاسم لمن يراه وحده');
  const reps = read('..', 'backend', 'src', 'routes', 'salesReps.ts');
  const schema = reps.slice(reps.indexOf('const repSchema = z.object({'), reps.indexOf('});', reps.indexOf('const repSchema = z.object({')));
  const select = reps.slice(reps.indexOf('const repSelect = {'), reps.indexOf('} as const;', reps.indexOf('const repSelect = {')));
  const auth = read('..', 'backend', 'src', 'routes', 'auth.ts');
  const sync = read('..', 'backend', 'src', 'services', 'apiSync.ts');
  const cols = sync.slice(sync.indexOf('const SALES_REP_COLS = ['), sync.indexOf('];', sync.indexOf('const SALES_REP_COLS = [')));
  for (const k of Object.values(DEDUP_KEYS)) {
    assert.match(schema, new RegExp(`\\b${k}: z\\.boolean\\(\\)\\.optional\\(\\),`), `repSchema.${k}`);
    assert.match(select, new RegExp(`\\b${k}: true`), `repSelect.${k}`);
    assert.match(auth, new RegExp(`\\b${k}: true`), `/auth/me.${k}`);
    assert.ok(cols.includes(`'${k}'`), `SALES_REP_COLS.${k}`);
  }
  // مسارا العميل اللذان يستعملهما تطبيق المندوب (POST /customers وPUT /customers/:id) يرسلان الجسم نفسه
  const customers = read('..', 'backend', 'src', 'routes', 'customers.ts');
  assert.ok((customers.match(/res\.status\(409\)\.json\(customerDupBody\(dup, await canAccessCustomer\(req, tid, dup\.id\)\)\)/g) ?? []).length >= 2);
});
