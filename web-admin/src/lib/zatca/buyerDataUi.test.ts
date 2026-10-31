import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * فوترة ZATCA (Z5.1a، D2) — حرّاس نصّية: كل ما أضافه جمع بيانات المشتري في الواجهات (قسم البطاقة، الشارة، الفلتر، الملخّص،
 * اللافتة، الشريحة، نقطة المندوب الضيّقة، الفئة الضريبية للصنف) لا يُرسم ولا يُرسل ولا يُطلب إلا حين zatcaCollectOn(company)
 * — فالشركة غير المعلَّمة وغير المفعّلة ترى ما تراه اليوم وترسل ما ترسله اليوم.
 */

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') ? [full] : [];
  });
}

/** كل ظهور لـneedle مسبوق (ضمن نافذة) بأحد الحرّاس. */
function guarded(src: string, needle: string, guards: readonly string[], window = 400): void {
  let i = src.indexOf(needle);
  assert.ok(i >= 0, `غير موجود: ${needle}`);
  while (i >= 0) {
    const before = src.slice(Math.max(0, i - window), i);
    assert.ok(guards.some(g => before.includes(g)), `«${needle}» بلا حارس الجمع قبله:\n${before.slice(-200)}`);
    i = src.indexOf(needle, i + needle.length);
  }
}

test('قسم بيانات المشتري لا يُرسم في أي شاشة إلا خلف zatcaCollect (أو نموذج المندوب الضيّق الذي لا يُفتح إلا من اللافتة المحروسة)', () => {
  const users = walk(path.join(root, 'src')).filter(f => fs.readFileSync(f, 'utf8').includes('<BuyerDataFields'));
  const rel = users.map(f => path.relative(path.join(root, 'src'), f).split(path.sep).join('/')).sort();
  assert.deepEqual(rel, ['components/forms/CustomerModal.tsx', 'm/MCustomerForm.tsx', 'rep/RepApp.tsx', 'rep/RepBuyerData.tsx']);
  guarded(read('components', 'forms', 'CustomerModal.tsx'), '<BuyerDataFields', ['{zatcaCollect && watched && (']);
  guarded(read('m', 'MCustomerForm.tsx'), '<BuyerDataFields', ['{showBuyer && (']);
  guarded(read('rep', 'RepApp.tsx'), '<BuyerDataFields', ['{zatcaCollect && (']);
  assert.match(read('m', 'MCustomerForm.tsx'), /const showBuyer = zatcaCollect && accountingOn;/);

  const app = read('rep', 'RepApp.tsx');
  assert.match(app, /const zatcaCollect = zatcaCollectOn\(company\);/);
  // نموذج المندوب الضيّق: يُفتح بـsetModal('buyerData') من onCompleteBuyer وحده، واللافتة التي تستدعيه محروسة
  assert.equal(app.split("setModal('buyerData')").length - 1, 1);
  assert.match(app, /onCompleteBuyer=\{\(\) => setModal\('buyerData'\)\}/);
  guarded(app, '<RepBuyerBanner', ['{zatcaCollect && !unassigned && (']);
  guarded(app, '<RepBuyerDataForm', ["modal === 'buyerData' && selectedCustomer ? ("]);
});

test('الحمولة: الحقول الجديدة لا تُرسل إلا للجامعة (لوحة الإدارة ترسل قيم البطاقة كما كانت — والخادم يُسقطها لغير الجامعة)', () => {
  const app = read('rep', 'RepApp.tsx');
  assert.ok(app.includes('...(zatcaCollect ? buyerCreatePayload(buyer) : {}),'), 'إضافة عميل من المندوب');
  assert.ok(app.includes('if (zatcaCollect) Object.assign(payload, buyerUpdatePayload(buyer, customer));'), 'تعديل عميل من المندوب');
  const add = app.slice(app.indexOf('function AddCustomer('), app.indexOf('function EditCustomer('));
  assert.match(add, /if \(zatcaCollect\) \{\n\s*const check = buyerFormCheck\(buyerView, null, BUYER_BILLING_FIELDS, \{ relaxed: buyerRelax \}\);/);
  const form = read('m', 'MCustomerForm.tsx');
  assert.match(form, /if \(showBuyer\) \{\n\s*Object\.assign\(payload, customer \? buyerUpdatePayload\(buyer, customer as BuyerRowLike\) : buyerCreatePayload\(buyer\)\);/);
  const modal = read('components', 'forms', 'CustomerModal.tsx');
  assert.match(modal, /zatcaCollect = false \}: Props\)/);
  assert.ok(modal.includes('if (!zatcaCollect) { onSave(data); return; }'), 'غير الجامعة: الحمولة كما هي');
  assert.ok(modal.includes('onSave({ ...data, ...pickPhase2(buyer) } as CustomerForm);'));
  const product = read('components', 'forms', 'ProductModal.tsx');
  assert.ok(product.includes('...(zatcaCollect ? productVatPayload({ vatCategory: cat, vatExemptionCode, vatExemptionReason }) : {})'));
  guarded(product, 'data-zatca-product-vat', ['{zatcaCollect && ('], 200);
});

test('القوائم: الفلتر والشارات والملخّص والشريحة وطلباتها خلف zatcaCollect — ولا طلب لنقطة بيانات الفوترة لغير الجامعة', () => {
  const page = read('pages', 'CustomersPage.tsx');
  assert.match(page, /const zatcaCollect = zatcaCollectOn\(company\);\n\s*const bucketMode = zatcaCollect && buyerBucket !== '';/);
  assert.match(page, /queryFn: async \(\) => \(await customerApi\.buyerData\(\{ limit: 0, status: buyerStatus \}\)\)\.data\.summary as BuyerSummary,\n\s*enabled: zatcaCollect,/);
  assert.match(page, /return res\.data as \{ data: BuyerListRow\[\]; nextCursor: string \| null \};\n\s*\},\n\s*enabled: bucketMode,/);
  guarded(page, '<option value="incomplete">', ['{zatcaCollect && ('], 250);
  assert.ok(page.includes('const badge = !zatcaCollect ? null :'));
  assert.ok(page.includes('{zatcaCollect && buyerSummary.data && ('));
  // قائمة الفوترة: summary: '0' في كل صفحة (العدّادات من استعلام الملخّص وحده)، وبحث مؤجَّل، و«جميع الحالات» = ALL للقائمة والملخّص
  const listQ = page.slice(page.indexOf('const buyerList = useQuery({'), page.indexOf('const buyerSummary = useQuery({'));
  assert.ok(listQ.includes("queryKey: ['customers', 'zatca-buyer-data', buyerBucket, bucketSearch, buyerStatus, bucketCursor],"));
  assert.ok(listQ.includes("customerApi.buyerData({ bucket: buyerBucket, search: bucketSearch, status: buyerStatus, limit: 50, summary: '0', ...(bucketCursor ? { cursor: bucketCursor } : {}) });"));
  assert.doesNotMatch(page, /status \|\| 'ACTIVE'/);
  assert.ok(page.includes("const buyerStatus = status || 'ALL';"));
  assert.ok(page.includes("queryKey: ['customers', 'zatca-buyer-summary', buyerStatus],"));
  assert.match(page, /useEffect\(\(\) => \{\n\s*if \(!zatcaCollect\) return;\n\s*const t = setTimeout\(\(\) => \{ setBucketSearch\(search\); setBucketCursors\(\[null\]\); \}, 300\);\n\s*return \(\) => clearTimeout\(t\);\n\s*\}, \[search, zatcaCollect\]\);/);
  assert.ok(page.includes("onChange={e => { setSearch(e.target.value); setPage(1); }} />"), 'القائمة العادية كما كانت');
  assert.ok(page.includes("value={bucketMode ? '' : channel} disabled={bucketMode}"), 'القناة لا تُرى مطبَّقة وهي معطّلة');

  const m = read('m', 'MCustomers.tsx');
  // /m: الشريحة والشارة مع المحاسبة وحدها — كقسم بيانات الفوترة في نموذجه (لا «ناقصة» بلا حقول تُكملها)
  assert.match(m, /const zatcaCollect = accountingOn && zatcaCollectOn\(company as ZatcaCompanyLike \| null\);/);
  assert.match(read('m', 'MCustomerForm.tsx'), /const showBuyer = zatcaCollect && accountingOn;/);
  assert.match(m, /const incompleteMode = zatcaCollect && onlyIncomplete;/);
  assert.match(m, /summary: '0' \}\)\)\.data\?\.data, 'العملاء'\),\n\s*enabled: incompleteMode,/);
  assert.match(m, /\.data\?\.summary \?\? null\) as \{ incomplete: number \} \| null,\n\s*enabled: zatcaCollect,/);
  assert.ok(m.includes('const badge = zatcaCollect ? buyerBadge(c as BuyerRowLike, buyerRelax) : null;'));
  assert.ok(m.includes('{zatcaCollect && accountingOn && (() => {'));

  const app = read('rep', 'RepApp.tsx');
  assert.ok(app.includes('if (!zatcaCollect || !navigator.onLine) return;\n    let alive = true;\n    fetchIncompleteBuyers()'));
  assert.equal(app.split('fetchIncompleteBuyers(').length - 1, 1, 'نداء واحد محروس');
  assert.ok(read('rep', 'RepBuyerData.tsx').includes("await repApi.get('/customers/zatca-buyer-data', { params: { bucket: 'incomplete', limit: 200 } });"));
  assert.ok(app.includes('{zatcaCollect && buyerBadge(c) && ('));
  assert.ok(app.includes('{zatcaCollect && incomplete && incomplete.count > 0 && ('));

  // لا ملف آخر يطلب النقطة — عدا فهرس مستند API (lib/apiDocsCatalog.ts): نصٌّ يصف المسار لمبرمج الشركة لا طلبٌ إليه
  const callers = walk(path.join(root, 'src')).filter(f => /zatca-buyer-data|buyer-data`|buyerData\(|updateBuyerData\(|applySuggestedType\(/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(path.join(root, 'src'), f).split(path.sep).join('/'))
    .filter(f => f !== 'lib/apiDocsCatalog.ts').sort();
  assert.deepEqual(callers, ['api/client.ts', 'm/MCustomers.tsx', 'pages/CustomersPage.tsx', 'rep/RepBuyerData.tsx']);
});

test('نقطة المندوب الضيّقة: PATCH لحقول الفوترة وحدها — والشاشة لا ترسل مالاً ولا موقعاً ولا حالة', () => {
  const form = read('rep', 'RepBuyerData.tsx');
  assert.ok(form.includes('await repApi.patch(`/customers/${customer.id}/buyer-data`, payload);'));
  assert.ok(form.includes('const payload = buyerUpdatePayload(values, customer, fields);'));
  // Q3: بلا «تعديل بيانات العميل» — حقول Q3 وحدها، والمحفوظ وغير Q3 مقفل، والفحص قبل الإرسال بقاعدة الخادم نفسها
  assert.ok(form.includes('export function RepBuyerDataForm({ customer, canEditCustomer = false, onClose, onSaved, buyerRelax = false }: {'), 'الافتراض: إكمال فقط (والقيد قائم)');
  assert.ok(form.includes('const fields = canEditCustomer ? BUYER_BILLING_FIELDS : BUYER_REP_COMPLETE_FIELDS;'));
  assert.ok(form.includes('const locked = canEditCustomer ? undefined : (f: BuyerField) => repCompleteLocked(customer, f);'));
  assert.ok(form.includes('const restricted = canEditCustomer ? check.cleared : repCompleteOnlyDenied(customer, check.patch);'));
  assert.ok(form.includes('stored={customer} errors={errors} locked={locked}'));
  assert.ok(read('rep', 'RepApp.tsx').includes('<RepBuyerDataForm customer={selectedCustomer} canEditCustomer={user.canEditCustomer === true}'));
  const fields = read('components', 'BuyerDataFields.tsx');
  assert.equal(fields.split('disabled={isLocked(').length - 1, 4, 'النص الحرّ والقوائم الثلاث');
  for (const f of ['buyerType', 'countryCode', 'buyerIdScheme']) assert.ok(fields.includes(`value={values.${f} ?? ''} disabled={isLocked('${f}')}`), f);
  for (const f of ['creditLimit', 'paymentDays', 'status:', 'lat', 'lng', 'locationUrl', 'balance']) assert.ok(!form.includes(f), `الشاشة تذكر ${f}`);
  // تعديل العميل العامّ لم يكتسب حقلاً مالياً (حارس الخادم rep-customer-edit يفحص الشيء نفسه)
  const app = read('rep', 'RepApp.tsx');
  const edit = app.slice(app.indexOf('function EditCustomer('), app.indexOf('\nfunction ', app.indexOf('function EditCustomer(') + 30));
  for (const f of ['creditLimit', 'paymentDays', 'status:']) assert.ok(!edit.includes(f), `EditCustomer يرسل ${f}`);
});

/**
 * طلب المالك ٣١ أكتوبر ٢٠٢٦ (فكّ قيد الرقم الضريبي والعنوان الوطني): كل ما يضيفه للشاشات خلف buyerRelax (= buyerRelaxOn(company)
 * الذي يشترط الجمع) — فالشركة التي لم تفكّ القيد ترسل الفحص نفسه وترى القسم نفسه والشارة نفسها.
 */
test('فكّ القيد: سطر المبسطة والتنبيهات تُمرَّر خلف buyerRelax وحده، والفحص بقيمته، والشارة بالشرط نفسه', () => {
  const sources: Array<[string, string]> = [
    ['components/forms/CustomerModal.tsx', read('components', 'forms', 'CustomerModal.tsx')],
    ['m/MCustomerForm.tsx', read('m', 'MCustomerForm.tsx')],
    ['rep/RepApp.tsx', read('rep', 'RepApp.tsx')],
    ['rep/RepBuyerData.tsx', read('rep', 'RepBuyerData.tsx')],
  ];
  let passed = 0;
  for (const [name, src] of sources) {
    const n = src.split('relaxed: true, warnings: buyerRelaxWarnings(').length - 1 + src.split('relaxed: true,\n').length - 1;
    assert.ok(n >= 1, `${name}: لا يمرّر فكّ القيد`);
    guarded(src, 'buyerRelaxWarnings(', ['{...(buyerRelax && {'], 200);
    // كل فحصٍ قبل الإرسال بقيمة الشركة — لا relaxed: true ثابتة
    for (const m of src.matchAll(/buyerFormCheck\([^;]*\);/g)) assert.match(m[0], /\{ relaxed: buyerRelax \}\);$/, `${name}: ${m[0]}`);
    passed += n;
  }
  assert.equal(passed, 5, 'الإدارة و/m وإضافة المندوب وتعديله ونموذجه الضيّق');
  // المصدر الواحد: buyerRelaxOn (الجمع && === true) في كل مضيف
  assert.match(read('pages', 'CustomersPage.tsx'), /const buyerRelax = buyerRelaxOn\(company\);/);
  assert.match(read('m', 'MCustomers.tsx'), /const buyerRelax = zatcaCollect && buyerRelaxOn\(company as ZatcaCompanyLike \| null\);/);
  const app = read('rep', 'RepApp.tsx');
  assert.match(app, /const buyerRelax = buyerRelaxOn\(company\);/);
  assert.ok(app.includes('relaxed={buyerRelaxOn(company)} />'), 'لافتة ملف العميل');
  // الشارة في المندوب: الظهور بشرط اليوم حرفياً، وفكّ القيد يغيّر الصياغة وحدها
  assert.ok(app.includes("{buyerBadge(c, buyerRelax) === 'simplified' ? tr('ناقصة تصدر مبسطة') : buyerBadge(c) === 'incomplete'"));
});

/**
 * طلب المالك ٣١ أكتوبر ٢٠٢٦: بطاقة «فك قيد الرقم الضريبي والعنوان الوطني» في إعدادات الشركة — تظهر لمدير الشركة غير المقيّد في
 * الشركة الجامعة وحدها (والخادم مرجع: 403 BUYER_RELAX_*)، والتحذير الضريبي ظاهر دائماً لا عند التفعيل وحده، والتفعيل وحده يُؤكَّد،
 * والحفظ بمساره المستقلّ (PATCH /company/buyer-relax) لا مع زرّ حفظ الإعدادات.
 */
test('فكّ القيد — بطاقة الإعدادات: لمدير الشركة غير المقيّد في الجامعة، والتحذير دائم، والتأكيد للتفعيل وحده، وبمسارها المستقل', () => {
  const s = read('pages', 'CompanySettingsPage.tsx');
  assert.ok(s.includes("const buyerRelaxCardOn = accountingOn && zatcaCollectOn(data) && role === 'ADMIN' && !scopeEnabled;"));
  assert.equal((s.match(/<BuyerRelaxCard\b/g) || []).length, 1);
  const mount = s.indexOf('{buyerRelaxCardOn && <BuyerRelaxCard value={(data as { buyerVatAddressRelaxed?: unknown } | null | undefined)?.buyerVatAddressRelaxed === true} />}');
  assert.ok(mount > 0, 'البطاقة خلف حارسها وبقيمة === true');
  // بعد بطاقة طباعة التشغيلة وقبل بطاقة الفوترة الإلكترونية (الربط الحكومي)
  assert.ok(s.indexOf('{lotCardOn && <LotOnInvoiceCard') < mount && mount < s.indexOf('{/* الفوترة الإلكترونية (الربط الحكومي)'));
  const start = s.indexOf('function BuyerRelaxCard(');
  const card = s.slice(start, s.indexOf('\n/**', start));
  assert.ok(card.length > 500, 'البطاقة لم تُقتطع');
  assert.ok(card.includes('mutationFn: (enabled: boolean) => companyApi.buyerRelax.set(enabled),'));
  assert.ok(card.includes("if (on && !window.confirm(tr('تأكيد فك القيد ستصدر فواتير مبسطة لعملاء منشآت بياناتهم ناقصة ولا يستطيعون خصم ضريبتها هل تتابع'))) return;"));
  assert.equal(card.split('window.confirm(').length - 1, 1, 'الإطفاء بلا تأكيد');
  assert.ok(card.includes("<p>{tr('عند التفعيل يحفظ الرقم الضريبي ورقم المبنى والرمز البريدي ولو لم تكن بالصيغة المعتمدة وتصدر فاتورة ضريبية مبسطة بدل الفاتورة الضريبية لكل منشأة بياناتها ناقصة أو غير صحيحة فلا يستطيع العميل خصم ضريبة المدخلات بها والمسؤولية الضريبية على شركتك')}</p>"));
  assert.ok(card.includes("<p>{tr('الإشعار الدائن أو المدين على فاتورة ضريبية سابقة يبقى ضريبيا ويحتاج بيانات العميل كاملة')}</p>"));
  assert.doesNotMatch(card, /\{(checked|value|save\.\w+) && /, 'التحذير لا يُخفى خلف الحالة');
  assert.ok(read('api', 'client.ts').includes("set: (enabled: boolean) => api.patch('/company/buyer-relax', { enabled }),"));
});
