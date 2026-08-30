import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس منطق زرّ الرجوع.
 *
 * لماذا حرّاس نصّية لا تشغيلٌ لخطّاف React: منطق الخطّاف يعيش في تفاعله مع
 * `window.history` و`queueMicrotask`، ومحاكاتهما في node تختبر المحاكاة لا
 * السلوك. والأعطال التي نخشاها هنا ثلاثة، وكلّها **غياب سطر** لا خطأ حساب:
 * تنظيفٌ يسحب مدخلةً ثانية فيُغلق طبقتين بضغطة، وعدّادٌ يظنّ `go(-n)` يُطلق
 * n حدثاً فيبتلع ضغطةً حقيقية، ومزامنةٌ فورية تنقلب عند تبديل طبقتين.
 * الحارس هنا يسأل عن كلٍّ منها بالاسم.
 */

const SRC = path.join(process.cwd(), 'src');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');
const hook = read(path.join('lib', 'useBackClose.ts'));

test('يستمع لـpopstate — الحدث الوحيد الذي يصله زرّ أندرويد وسحبة آيفون', () => {
  assert.match(hook, /addEventListener\('popstate'/, 'لا مستمع لحدث الرجوع');
  assert.match(hook, /history\.pushState/, 'لا يدفع مدخلة عند فتح الطبقة');
});

test('المزامنة مؤجَّلة — تبديل طبقتين في لقطة واحدة لا يُنتج عملاً', () => {
  assert.match(hook, /queueMicrotask\(reconcile\)/, 'المزامنة فورية فتنقلب عند التبديل');
  assert.match(hook, /if \(want === pushed\) return/, 'لا فحص «العمق المطلوب = الحالي»');
});

test('popstate يُزيل الطبقة قبل استدعاء إغلاقها — وإلا سحب التنظيفُ مدخلةً ثانية', () => {
  const body = /function onPop[\s\S]*?\n\}/.exec(hook);
  assert.ok(body, 'دالّة onPop مفقودة');
  const src = body![0];
  const popAt = src.indexOf('layers.pop()');
  const closeAt = src.indexOf('.close()');
  assert.ok(popAt > 0 && closeAt > popAt, 'الإغلاق يسبق الإزالة — يُغلق طبقتين بضغطة واحدة');
});

test('التنظيف لا يسحب مدخلةً لطبقةٍ سحبها الرجوع أصلاً', () => {
  assert.match(hook, /findIndex\(l => l\.id === id\)/, 'لا يتحقّق من بقاء الطبقة في السجلّ');
  assert.match(hook, /if \(i === -1\) return/, 'يمضي التنظيف ولو أزال الرجوعُ الطبقة');
});

test('go(-n) يُعدّ حدثاً واحداً لا n — وإلا ابتلع العدّادُ ضغطةً حقيقية', () => {
  const rec = /function reconcile[\s\S]*?\n\}/.exec(hook);
  assert.ok(rec, 'دالّة reconcile مفقودة');
  assert.match(rec![0], /selfPops \+= 1;\s*\n\s*window\.history\.go\(-steps\)/,
    'العدّاد لا يُزاد بواحد قبل go(-n) مباشرةً');
});

test('الردّ في ref والتبعية [open] وحدها — وإلا تراكمت مدخلات مع كل تصيير', () => {
  assert.match(hook, /const ref = useRef\(close\)/, 'الردّ ليس في ref');
  assert.match(hook, /\}, \[open\]\);/, 'تبعيات التأثير أوسع من [open]');
});

test('يُطبّع العمق عند الإقلاع البارد — استعادة آيفون تترك مدخلات ميتة', () => {
  assert.match(hook, /function bind/, 'لا دالّة ربط');
  assert.match(hook, /pushed = depth/, 'لا يقرأ العمق من حالة التاريخ عند الإقلاع');
});

/**
 * الطبقات موصولة فعلاً: خطّافٌ مكتوبٌ لا يستورده أحد لا يفعل شيئاً — وهذا
 * بالضبط ما كشفه المسح عن المحاولة الأولى.
 */
test('تطبيق المندوب: الطبقات الأساسية موصولة', () => {
  const rep = read(path.join('rep', 'RepApp.tsx'));
  assert.match(rep, /import \{ useBackClose \}/, 'الخطّاف غير مستورد');
  for (const [what, re] of [
    ['الصفّ الصادر', /useBackClose\(showOutbox/],
    ['عارض المستند', /useBackClose\(!!docResult, closeDocResult\)/],
    ['ملفّ العميل', /useBackClose\(modal === 'customerDetail', closeCustomerDetail\)/],
    ['نماذج الإنشاء', /\|\| modal === 'createReceipt' \|\| modal === 'logVisit',/],
    ['ماسح الباركود', /useBackClose\(showScanner/],
    ['سلّة الأصناف', /useBackClose\(!showScanner && showCart/],
    ['ورقة رابط الدفع', /useBackClose\(payLinkOpen/],
    ['تحميل السيارة', /useBackClose\(view === 'load'/],
    ['العودة للتبويب الرئيسي', /screen !== 'home', \(\) => setScreen\('home'\)\)/],
  ] as const) {
    assert.match(rep, re, `غير موصول: ${what}`);
  }
});

/** إغلاق ملفّ العميل يُنهي مؤقّت الزيارة — رجوعٌ يتخطّاه يُضيّع زيارة مسجَّلة */
test('الرجوع من ملفّ العميل يمرّ بمنهي مؤقّت الزيارة', () => {
  const rep = read(path.join('rep', 'RepApp.tsx'));
  const fn = /const closeCustomerDetail = useCallback\([\s\S]*?\}, \[[^\]]*\]\);/.exec(rep);
  assert.ok(fn, 'دالّة إغلاق ملفّ العميل مفقودة');
  assert.match(fn![0], /finalizeVisit\(visitTimer\)/, 'الإغلاق لا يُنهي الزيارة');
  assert.match(fn![0], /setModal\(null\)/, 'الإغلاق لا يعود لقائمة العملاء');
});

test('لوحة الجوال: الطبقات موصولة والعودة لأول تبويب مسموح', () => {
  const app = read(path.join('m', 'MobileApp.tsx'));
  assert.match(app, /import \{ useBackClose \}/, 'الخطّاف غير مستورد في القوقعة');
  assert.match(app, /setScreen\(tabs\[0\]\.id\)/, "يعود إلى 'home' حرفياً بدل أول تبويب مسموح");
  assert.doesNotMatch(app, /useBackClose\([^)]*setScreen\('home'\)/, "لا يجوز تثبيت 'home' — قد تكون محجوبة");

  for (const [file, re, what] of [
    ['MCustomers.tsx', /useBackClose\(editing !== undefined/, 'نموذج العميل (الثلاثيّة undefined/null)'],
    ['MCustomers.tsx', /useBackClose\(editing === undefined && !!detail/, 'تفاصيل العميل'],
    ['MCustomers.tsx', /useBackClose\(!!doc/, 'إنشاء مستند من ملفّ العميل'],
    ['MDocList.tsx', /useBackClose\(!!cancelId/, 'حوار الإلغاء'],
    ['MDocList.tsx', /useBackClose\(!cancelId && !!openId/, 'شاشة المستند'],
    ['MTracking.tsx', /useBackClose\(confirmToggle/, 'تأكيد التتبّع'],
    ['MTracking.tsx', /useBackClose\(!!zoom/, 'تكبير صورة الزيارة'],
  ] as const) {
    assert.match(read(path.join('m', file)), re, `غير موصول: ${what}`);
  }
});

/**
 * الورقة السفلية في التتبّع تبدأ مفتوحة — فهي حالة عرض لا طبقة تنقّل،
 * وتسجيلها يجعل الرجوع يطويها بدل أن يخرج من التبويب.
 */
test('حالات العرض لا تُسجَّل طبقاتٍ للرجوع', () => {
  const trk = read(path.join('m', 'MTracking.tsx'));
  assert.doesNotMatch(trk, /useBackClose\(sheetOpen/, 'الورقة السفلية سُجّلت طبقةً وهي حالة عرض');
});

/**
 * الخلل الذي كان يمنع حوار الإلغاء من الظهور أصلاً: كُتب في فرع القائمة
 * وحده بينما يُفتح من شاشة المستند التي تعود قبله.
 */
test('حوار إلغاء المستند قابل للوصول من شاشة المستند', () => {
  const doc = read(path.join('m', 'MDocList.tsx'));
  assert.match(doc, /const cancelDialog = cancelId \?/, 'الحوار غير مشترك بين الفرعين');
  const openBranch = doc.slice(doc.indexOf('if (openId) {'), doc.indexOf('return (\n    <div className="h-full'));
  assert.match(openBranch, /\{cancelDialog\}/, 'شاشة المستند لا ترسم الحوار — الزرّ بلا أثر');
});

/** حالة القائمة كانت تتسرّب بين تبويبَي الفواتير والسندات فيلتبس الرجوع */
test('لكل تبويب مستندات مفتاحه — لا تتسرّب حالته للآخر', () => {
  const app = read(path.join('m', 'MobileApp.tsx'));
  assert.match(app, /key="invoice" kind="invoice"/, 'تبويب الفواتير بلا key');
  assert.match(app, /key="receipt" kind="receipt"/, 'تبويب السندات بلا key');
});
