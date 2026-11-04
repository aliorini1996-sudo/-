// حرّاس حداثة المستند (R-G1/D-G1، D-G3/D-G4، D-G6): تعديل «نصوص المطبوعات» يصل المستندات المفتوحة وطباعتها في كل واجهة.
// المكوّنات ضخمة تعتمد على المتصفّح وIndexedDB فلا تُرسَم هنا؛ والحارس يثبت موضع الشرط في المصدر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

test('/m: إعدادات الشركة تتجدّد عند العودة والاتصال وبنبضة دورية (لا مرة عند الدخول فقط)', () => {
  const app = read('m/MobileApp.tsx');
  assert.match(app, /import \{ COMPANY_REFRESH_TICK_MS, DOC_OPEN_EVENT, companyRefreshDue, docOpenRefreshDue \} from '\.\.\/rep\/companyRefresh';/);
  const i = app.indexOf('const { data } = await companyApi.get();');
  assert.ok(i > 0, 'جلب الشركة في /m لم يعد بهذا الشكل — راجع الحارس');
  const start = app.lastIndexOf('useEffect(() => {', i);
  const effect = app.slice(start, app.indexOf('}, [token]);', i));
  assert.match(effect, /companyRefreshDue\(last, Date\.now\(\)\)/, 'التجديد غير محروس بفجوة الدقائق الخمس');
  assert.match(effect, /document\.addEventListener\('visibilitychange', refresh\);/);
  assert.match(effect, /window\.addEventListener\('online', refresh\);/);
  assert.match(effect, /window\.setInterval\(refresh, COMPANY_REFRESH_TICK_MS\)/);
  // تنظيف عند تبدّل الجلسة
  assert.match(effect, /document\.removeEventListener\('visibilitychange', refresh\);/);
  assert.match(effect, /window\.removeEventListener\('online', refresh\);/);
  assert.match(effect, /window\.clearInterval\(iv\);/);
  // وفتح مستند يطلبها في الخلفية بفجوة الثلاثين ثانية (حفظ النصوص من اللوحة ثم فتح الفاتورة على الجوال)
  assert.match(effect, /const onDocOpen = \(\) => \{\s*if \(!navigator\.onLine \|\| !docOpenRefreshDue\(last, Date\.now\(\)\)\) return;\s*last = Date\.now\(\);\s*void pull\(\);\s*\};/);
  assert.match(effect, /window\.addEventListener\(DOC_OPEN_EVENT, onDocOpen\);/);
  assert.match(effect, /window\.removeEventListener\(DOC_OPEN_EVENT, onDocOpen\);/);
  // فشل الجلب يعيد المحاولة في المحفِّز التالي
  assert.match(effect, /catch \{ last = 0;/);
  // التحديث يصل العملة والأرقام كالجلب الأول
  assert.match(effect, /setActiveCurrency\(/);
  assert.match(effect, /setActiveNumerals\(/);
  // MDocScreen يبني المستند من company كل رسم (لا نسخة محفوظة) — فتجدّد الخاصية يكفي
  const screen = read('m/MDocScreen.tsx');
  assert.match(screen, /invoiceDocFromDetail\(raw, stampName, company as Company \| null\)/);
  assert.match(screen, /receiptDocFromDetail\(raw, stampName, company as Company \| null\)/);
});

test('تطبيق المندوب: المستند المفتوح يأخذ الشركة المتجدّدة، وفتحه يطلبها في الخلفية', () => {
  const app = read('rep/RepApp.tsx');
  assert.match(app, /import \{ COMPANY_REFRESH_TICK_MS, companyRefreshDue, docOpenRefreshDue, withLiveCompany \} from '\.\/companyRefresh';/);
  assert.match(app, /useEffect\(\(\) => \{\s*setDocResult\(d => \(d \? withLiveCompany\(d, company\) : d\)\);\s*\}, \[company\]\);/,
    'تجدّد الشركة لا يصل المستند المفتوح: إعادة الطباعة بالنصوص القديمة');
  // وقت آخر جلب مشترك بين المجدِّد الدوري وفتح المستند
  const i = app.indexOf('let last = Date.now(); // الجلب الأول في المؤثّر أعلاه');
  assert.ok(i > 0);
  const effect = app.slice(i, app.indexOf('}, [token, refreshUser]);', i));
  assert.match(effect, /companyFetchedAt\.current = Date\.now\(\);\s*repApi\.get\('\/company', \{ background: true \}\)/);
  assert.match(effect, /await cacheSet\('company', fresh\);/, 'الكاش لا يُحدَّث: الأوف‑لاين يبقى على النصوص القديمة');
  assert.match(effect, /last = companyFetchedAt\.current;/);
  assert.match(effect, /pullCompanyRef\.current = pull;/);
  // فتح المستند: خلفيّ (بلا await) ومحروس بالاتصال وبفجوة 30 ثانية
  const at = app.indexOf('const docOpen = docResult !== null;');
  assert.ok(at > i, 'مؤثّر فتح المستند غائب أو قبل تسجيل الجلب');
  assert.match(app.slice(at), /^const docOpen = docResult !== null;\s*useEffect\(\(\) => \{\s*if \(!token \|\| !docOpen \|\| !navigator\.onLine\) return;\s*if \(docOpenRefreshDue\(companyFetchedAt\.current, Date\.now\(\)\)\) pullCompanyRef\.current\(\);\s*\}, \[token, docOpen\]\);/);
});

test('لوحة الويب: فتح فاتورة أو سند ينتظر إعدادات الشركة إن لم تكتمل، ويأخذ تجدّدها وهو مفتوح', () => {
  for (const [rel, call] of [
    ['pages/InvoicesPage.tsx', "invoiceDocFromDetail(res.data.data, '', co)"],
    ['pages/ReceiptsPage.tsx', "receiptDocFromDetail(res.data.data, '', co)"],
  ] as const) {
    const s = read(rel);
    assert.match(s, /const fetchCompany = async \(\) => \{ const res = await companyApi\.get\(\); return res\.data\.data as Company; \};/);
    assert.match(s, /useQuery\(\{ queryKey: \['company'\], queryFn: fetchCompany \}\)/, `${rel}: الاستعلام والضمان بدالّة واحدة`);
    const c = s.indexOf(call);
    assert.ok(c > 0, `${rel}: بناء المستند لا يستعمل الشركة المضمونة`);
    const ensure = s.lastIndexOf("company ?? await qc.ensureQueryData({ queryKey: ['company'], queryFn: fetchCompany })", c);
    assert.ok(ensure > 0 && c - ensure < 400, `${rel}: الشركة لا تُضمن قبل بناء المستند`);
    assert.match(s.slice(Math.max(0, ensure - 40), c), /try \{ co = company \?\? await/, `${rel}: فشل الضمان يجب ألا يمنع فتح المستند`);
    assert.match(s, /useEffect\(\(\) => \{ setDocResult\(d => \(d \? withLiveCompany\(d, company\) : d\)\); \}, \[company\]\);/);
  }
});

test('DocumentResult يعلن فتح المستند (فيجلب /m الشركة في الخلفية) — مرة عند الفتح لا مع كل تجدّد للشركة', () => {
  const src = read('rep/RepDocuments.tsx');
  assert.match(src, /import \{ announceDocOpen \} from '\.\/companyRefresh';/);
  const i = src.indexOf('export function DocumentResult(');
  assert.ok(i > 0);
  const head = src.slice(i, src.indexOf('const isReceipt = doc.kind ===', i));
  assert.match(head, /useEffect\(\(\) => \{ announceDocOpen\(\); \}, \[\]\);/);
});
