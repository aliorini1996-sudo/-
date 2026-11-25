// «رقم العميل» والقوائم المقصوصة (مراجعة ٢٤ نوفمبر ٢٠٢٦): منتقيات العملاء ذات التصفية المحلية تجلب أول ١٠٠٠ عميل بالأحدث
// أولاً، فشركةٌ أكبر تفقد أقدم عملائها — أصحاب الأرقام الصغيرة (#1، #2…) أكثر ما يُكتب. حين تمتلئ القائمة بسقفها يُسأل الخادم
// عمّا يُكتب وتُضمّ نتائجه إلى الخيارات فيصفّيها المنتقي محلياً كالبقيّة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOCAL_CUSTOMER_CAP, REMOTE_CUSTOMER_LIMIT, REMOTE_SEARCH_DEBOUNCE_MS,
  isCappedList, mergeById, remoteCustomerSearcher, remoteSearchTerm,
} from './customerSearchFallback';
import { filterSelectOptions, type SelectOption } from '../components/SearchableSelect';

const SRC = path.join(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

test('السقف: القائمة الممتلئة بسقفها (١٠٠٠) مقصوصةٌ محتملة، ودونه كاملة فلا يُسأل الخادم', () => {
  assert.equal(LOCAL_CUSTOMER_CAP, 1000);
  assert.equal(isCappedList(999), false);
  assert.equal(isCappedList(1000), true);
  assert.equal(isCappedList(1500), true);
  assert.equal(isCappedList(0), false);
  assert.equal(isCappedList(30, 30), true);
});

test('ما يستحق سؤال الخادم: رقم عميل ولو خانةً واحدة (#12، ١٢)، أو حرفان فأكثر — والفارغ والحرف الواحد لا', () => {
  assert.equal(remoteSearchTerm(''), null);
  assert.equal(remoteSearchTerm('   '), null);
  assert.equal(remoteSearchTerm('س'), null, 'حرفٌ واحد يطابق نصف الشركة');
  assert.equal(remoteSearchTerm('0'), null, 'الصفر ليس رقم عميل');
  assert.equal(remoteSearchTerm('3'), '3');
  assert.equal(remoteSearchTerm(' #12 '), '#12');
  assert.equal(remoteSearchTerm('١٢'), '١٢');
  assert.equal(remoteSearchTerm('05'), '05', 'بادئة جوال: بحثٌ نصّي');
  assert.equal(remoteSearchTerm('سمارة'), 'سمارة');
  assert.equal(remoteSearchTerm('x'.repeat(150))?.length, 100, 'يُقصّ كحدّ بحث الخادم');
});

test('الضمّ بالمعرّف: المحمَّل أوّلاً بترتيبه ثم الجديد وحده — والمحمَّل يبقى مصدر صفّه', () => {
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  assert.equal(mergeById(base, []), base, 'بلا جديد: القائمة نفسها');
  assert.deepEqual(mergeById(base, [{ id: 'b', v: 2 }, { id: 'c', v: 2 }, { id: 'c', v: 3 }]),
    [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 2 }]);
});

const flush = () => new Promise<void>(r => setImmediate(r));

test('المُسائل: مهلة الكتابة طلبٌ واحد لآخر كلمة، والكلمة تُسأل مرّة، والفاشلة تُعاد، والإلغاء يُسقط المؤجَّل', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked: string[] = [];
  const got: { id: string }[][] = [];
  let fail = false;
  const s = remoteCustomerSearcher<{ id: string }>(async (term) => {
    asked.push(term);
    if (fail) throw new Error('offline');
    return term === 'لا شيء' ? [] : [{ id: `r-${term}` }];
  }, rows => got.push(rows));

  // «1» ثم «12» خلال المهلة ⇒ طلبٌ واحد لـ«12»
  s.query('1'); t.mock.timers.tick(100); s.query('12');
  t.mock.timers.tick(REMOTE_SEARCH_DEBOUNCE_MS - 1);
  assert.deepEqual([...asked], []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual([...asked], ['12']);
  assert.deepEqual([...got], [[{ id: 'r-12' }]]);

  // الكلمة نفسها لا تُسأل ثانية
  s.query('12'); t.mock.timers.tick(REMOTE_SEARCH_DEBOUNCE_MS); await flush();
  assert.deepEqual([...asked], ['12']);

  // ما لا يستحقّ (حرف واحد، فارغ) يلغي المؤجَّل ولا يُسأل
  s.query('سم'); s.query(''); t.mock.timers.tick(REMOTE_SEARCH_DEBOUNCE_MS); await flush();
  assert.deepEqual([...asked], ['12']);

  // نتيجةٌ فارغة لا تُسلَّم
  s.query('لا شيء'); t.mock.timers.tick(REMOTE_SEARCH_DEBOUNCE_MS); await flush();
  assert.equal(got.length, 1);

  // الفاشلة تُنسى فتُعاد عند الكتابة التالية
  fail = true;
  s.query('#7'); t.mock.timers.tick(REMOTE_SEARCH_DEBOUNCE_MS); await flush();
  fail = false;
  s.query('#7'); t.mock.timers.tick(REMOTE_SEARCH_DEBOUNCE_MS); await flush();
  assert.deepEqual(asked.slice(-2), ['#7', '#7']);
  assert.deepEqual(got[got.length - 1], [{ id: 'r-#7' }]);

  // الإلغاء (إزالة المنتقي) يُسقط المؤجَّل
  s.query('بقالة'); s.cancel(); t.mock.timers.tick(REMOTE_SEARCH_DEBOUNCE_MS); await flush();
  assert.ok(!asked.includes('بقالة'));
});

test('المنتقي على المجموعة المضمومة: #12 القديم (خارج الألف) يظهر أوّلاً لـ«12» ولـ«#12» بعد ضمّ نتيجة الخادم', () => {
  const opt = (c: { id: string; name: string; number: number | null; phone: string }): SelectOption =>
    ({ value: c.id, label: c.name, num: c.number, keywords: [c.phone] });
  // المحمَّل: الأحدث، أرقامٌ كبيرة وجوالٌ يحوي «12»
  const loaded = [
    { id: 'n1', name: 'بقالة الحيّ', number: 1500, phone: '0551200000' },
    { id: 'n2', name: 'تموينات الريف', number: 1499, phone: '0533333333' },
  ];
  // قبل الضمّ: صاحب #12 غائب
  assert.deepEqual(filterSelectOptions(loaded.map(opt), '12').map(o => o.value), ['n1']);
  const fromServer = [{ id: 'old', name: 'مؤسسة سمارة', number: 12, phone: '0509999999' }, loaded[0]];
  const pool = mergeById(loaded, fromServer).map(opt);
  // «12»: صاحب الرقم أوّلاً ثم الجوال الذي يحوي الأرقام (مطابقة «أو»)؛ «#12» و«١٢» لا يحويهما جوالٌ فصاحب الرقم وحده
  assert.deepEqual(filterSelectOptions(pool, '12').map(o => o.value), ['old', 'n1']);
  for (const q of ['#12', '١٢']) assert.deepEqual(filterSelectOptions(pool, q).map(o => o.value), ['old'], q);
  // ولا يُدخل «1» صاحب #12 بالاحتواء
  assert.ok(!filterSelectOptions(pool, '1').some(o => o.value === 'old'));
});

test('SearchableSelect: onQueryChange يُبلَّغ بالكتابة وبالتفريغ عند الاختيار والنقر خارجاً — والتصفية تبقى محلية', () => {
  const sel = read('components', 'SearchableSelect.tsx');
  assert.ok(sel.includes('onQueryChange?: (q: string) => void;'));
  // أثرٌ على q وحده يُبلِّغ كل تغيّر (الكتابة وتفريغ الاختيار والنقر خارجاً) — ومسارات التفريغ كما كانت حرفاً (سطر الإغلاق
  // مثبَّتٌ في repTargetsAudit.test)
  assert.ok(sel.includes('useEffect(() => { queryCb.current?.(q); }, [q]);'));
  assert.ok(sel.includes("setOpen(false); setQ(''); } };"));
  assert.ok(sel.includes("    setOpen(false);\n    setQ('');\n"));
  assert.ok(sel.includes('onChange={e => { setQ(e.target.value); onSearchChange?.(e.target.value); }}'));
  // onQueryChange لا يعطّل التصفية المحلية (onSearchChange وحده يفعل)
  assert.ok(sel.includes('const filtered = onSearchChange ? exactNumberFirst(options, q) : filterSelectOptions(options, q);'));
});

test('الربط: نافذتا الفاتورة والسند والأرصدة اليدوية وتطبيق المندوب تضمّ بحث الخادم إلى قوائمها المقصوصة', () => {
  const cases: [string, string, RegExp][] = [
    [read('components', 'forms', 'InvoiceModal.tsx'), 'onQueryChange={onCustomerQuery}',
      /useCustomerSearchFallback\(loadedCustomers,\s+async \(term\) => \(await customerApi\.list\(\{ search: term, limit: REMOTE_CUSTOMER_LIMIT \}\)\)\.data\.data as Customer\[\]\);/],
    [read('components', 'forms', 'ReceiptModal.tsx'), 'onQueryChange={onCustomerQuery}',
      /useCustomerSearchFallback\(loadedCustomers,\s+async \(term\) => \(await customerApi\.list\(\{ search: term, limit: REMOTE_CUSTOMER_LIMIT \}\)\)\.data\.data as Customer\[\]\);/],
    [read('pages', 'ledger', 'setup', 'ManualBalances.tsx'), 'onCustomerQuery?.(e.target.value);',
      /useCustomerSearchFallback\(customersQ\.data,\s+async \(term\) => \(\(await customerApi\.list\(\{ search: term, limit: REMOTE_CUSTOMER_LIMIT \}\)\)\.data\?\.data \?\? \[\]\) as PickCustomer\[\]\);/],
    [read('rep', 'RepApp.tsx'), 'onQueryChange={onQueryChange}',
      /useCustomerSearchFallback\(customers,\s+async \(term\) => \(await repApi\.get\('\/customers', \{ params: \{ search: term, limit: REMOTE_CUSTOMER_LIMIT \} \}\)\)\.data\.data,\s+\{ enabled: typeof navigator === 'undefined' \|\| navigator\.onLine \}\);/],
  ];
  for (const [src, wire, hook] of cases) {
    assert.match(src, hook);
    assert.ok(src.includes(wire), wire);
  }
  // الجلب الأول بسقفه كما كان — و«customers-all» يبقى مصفوفةً (يُبطَل بعد السندات ويُملأ في الاختبارات)
  const inv = cases[0][0];
  assert.ok(inv.includes("queryKey: ['customers-all'],") && inv.includes('const res = await customerApi.list({ limit: 1000 });'));
  // المختار من الخادم يُوجد في المجموعة (pool باسم customers) — العميل المختار لا يضيع
  assert.ok(inv.includes('const { pool: customers, onQueryChange: onCustomerQuery } = useCustomerSearchFallback('));
  // تطبيق المندوب: الكاش دون اتصال كما كان، والخيارات والاختيار من المجموعة
  const rep = cases[3][0];
  assert.ok(rep.includes("(await repApi.get('/customers', { params: { limit: 1000 } })).data.data);"));
  assert.ok(rep.includes('options={pool.map(c => ({'));
  assert.ok(rep.includes('const c = pool.find(x => x.id === v); if (c) onSelect(c);'));
  assert.ok(REMOTE_CUSTOMER_LIMIT > 0 && REMOTE_CUSTOMER_LIMIT <= 50);
});
