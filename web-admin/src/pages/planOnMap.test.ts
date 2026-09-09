import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس على عيوب الخطّ البنفسجيّ التي كشفتها المراجعة وأُصلحت.
 *
 * أربع عدساتٍ مستقلّة وجدت عيبَي العزل واليوم الماضي، وثلاثٌ وجدت الترقيم.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};
const tracking = () => read('src', 'pages', 'TrackingPage.tsx');
const routes = () => read('..', 'backend', 'src', 'routes', 'repRoutes.ts');

test('رقم الدبّوس من seq لا من موضعه بعد التصفية', () => {
  // محطّةٌ بلا إحداثيّات تسقط من الرسم، فيصير i+1 مخالفاً لرقمها في بطاقتها
  // نفسها وفي تطبيق المندوب: مشرفٌ يقول «العميل ٣» ومندوبٌ يرى غيره
  const s = tracking();
  assert.match(s, /icon=\{planStopIcon\(p\.seq, p\.done\)\}/, 'الرقم يجب أن يأتي من seq');
  assert.doesNotMatch(s, /planStopIcon\(i \+ 1/, 'الترقيم بالموضع يعود بالعيب');
});

test('الخطّة تدخل إطار الخريطة', () => {
  // مندوبٌ لم يتحرّك وله خطّ: كانت الخريطة تبقى على السعودية والخطّ خارجها
  const s = tracking();
  const i = s.indexOf('const focusPoints');
  const block = s.slice(i, i + 700);
  assert.match(block, /\.\.\.planLatLng/, 'نقاط الخطّة يجب أن تدخل حساب الإطار');
  assert.match(block, /planLatLng, reps\]/, 'التبعيّة مفقودة فلا يُعاد الحساب');
});

test('الخطّة تتحدّث مع بقيّة الخريطة', () => {
  // كانت متجمّدة والزيارات تتحدّث كل ٢٠ ثانية: زيارةٌ خضراء ومحطّتها «لم تتم»
  const s = tracking();
  const i = s.indexOf("queryKey: ['rep-plan'");
  const block = s.slice(i, i + 700);
  assert.match(block, /refetchInterval: enabled && !!selected \? 20000 : false/, 'الخطّة لا تتحدّث');
});

test('العزل يُطبَّق على الجميع لا على المندوب وحده', () => {
  const s = routes();
  // استثناء الإداريّ كان يفتح لطبقة الخطّة ما تُغلقه طبقة مواقع العملاء
  assert.doesNotMatch(s, /if \(!isRep \|\| \(await canAccessCustomer/, 'استثناء الإداريّ يعود بالعيب');
  assert.match(s, /if \(await canAccessCustomer\(req, tid, st\.customerId\)\) visible\.push\(st\);/, 'العزل غير مطبَّق');
  // والمحجوب يُقال لا يُخفى
  assert.match(s, /hiddenByScope: hidden/, 'عدد المحجوب لا يُرسَل');
  assert.match(tracking(), /plan\.hiddenByScope/, 'الواجهة لا تعرض المحجوب');
});

test('الخطّ الدائم لا يسري على يومٍ سبق إنشاءه', () => {
  // خطٌّ أُنشئ اليوم كان يُرسم على الأسبوع الماضي و«0 / N» تتّهم المندوب
  // بتقصيرٍ في خطّةٍ لم تكن موجودة
  const s = routes();
  assert.match(s, /isPermanent: true, createdAt: \{ lt: endOfDay \}/, 'الخطّ الدائم بلا قيدٍ زمنيّ');
  assert.match(s, /const endOfDay = /, 'حدّ اليوم غير محسوب');
});
