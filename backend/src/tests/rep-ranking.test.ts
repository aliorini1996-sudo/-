// تقييم أداء المناديب (services/repRanking.ts + GET /reports/rep-ranking) — المسافة المرصودة والترتيب، وحارسٌ نصّي على المسار.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rankRows, trackedMeters, type TrackPoint } from '../services/repRanking';
import { productQtyByRep } from '../routes/reports';

// خط عرض الرياض تقريباً: ٠٫٠٠١ درجة طول ≈ ١٠٢ م، و٠٫٠٠١ درجة عرض ≈ ١١١ م
const T0 = Date.parse('2026-10-12T06:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const P = (lat: number, lng: number, min: number, accuracy: number | null = 10): TrackPoint => ({ lat, lng, accuracy, capturedAt: at(min) });

test('المسافة: مجموع المقاطع المتصلة', () => {
  const m = trackedMeters([P(24.7, 46.7, 0), P(24.701, 46.7, 1), P(24.702, 46.7, 2)]);
  assert.ok(m > 215 && m < 230, String(m)); // ≈ ٢٢٢ م
});

test('المسافة: التذبذب في المكان لا يُحسب، ويُبقي الحضور حيّاً فلا تُقطع الحركة بعده', () => {
  const still = Array.from({ length: 30 }, (_, i) => P(24.7 + (i % 2) * 0.00005, 46.7, i)); // ~٥ م ذهاباً وإياباً ٣٠ دقيقة
  assert.equal(trackedMeters(still), 0);
  // بعد وقفة ٣٠ دقيقة عند عميل يتحرّك ١١١ م بعد دقيقة — يُحسب (الحضور تجدّد بالتذبذب)
  const m = trackedMeters([...still, P(24.701, 46.7, 31)]);
  assert.ok(m > 100 && m < 120, String(m));
});

test('المسافة: فجوة تتبّع طويلة لا تُوصَل بخطٍّ وهمي، وقفزة GPS مستحيلة تُتجاهل', () => {
  // أُغلق التطبيق ساعة ثم فُتح على بعد ٥ كم: لا يُحسب
  assert.equal(trackedMeters([P(24.7, 46.7, 0), P(24.745, 46.7, 60)]), 0);
  // قفزة ١١ كم في دقيقة (٦٦٠ كم/س) ثم عودة: تُتجاهل القفزة
  const m = trackedMeters([P(24.7, 46.7, 0), P(24.8, 46.7, 1), P(24.701, 46.7, 2)]);
  assert.ok(m > 100 && m < 120, String(m));
});

test('المسافة: النقاط رديئة الدقّة تُسقط، إلا إن كانت كلّ ما نملك', () => {
  const m = trackedMeters([P(24.7, 46.7, 0), P(24.71, 46.7, 1, 900), P(24.701, 46.7, 2)]);
  assert.ok(m > 100 && m < 120, String(m)); // نقطة الـ٩٠٠ م أُسقطت
  assert.ok(trackedMeters([P(24.7, 46.7, 0, 500), P(24.701, 46.7, 1, 500)]) > 100);
  assert.equal(trackedMeters([P(24.7, 46.7, 0)]), 0);
  assert.equal(trackedMeters([]), 0);
});

test('الترتيب: تنازلي، والمتساويان بالمرتبة نفسها', () => {
  const r = rankRows([
    { repId: 'a', name: 'أحمد', value: 5 }, { repId: 'b', name: 'باسم', value: 9 },
    { repId: 'c', name: 'جمال', value: 5 }, { repId: 'd', name: 'دانة', value: 0 },
  ]);
  assert.deepEqual(r.map((x) => [x.repId, x.rank]), [['b', 1], ['a', 2], ['c', 2], ['d', 4]]);
});

test('حارس نصّي: المعياران الماليّان يُرفضان مع المحاسبة المطفأة، والمسافة مختزلة لكل مندوب بسقف ٣١ يوماً، والنطاق محترم', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.ts'), 'utf8').replace(/\r\n/g, '\n');
  const i = src.indexOf("router.get('/rep-ranking'");
  assert.ok(i > 0);
  const h = src.slice(i, src.indexOf('\nexport default router;'));
  assert.match(h, /if \(FINANCIAL_METRICS\.includes\(metric\)\)[\s\S]*?accountingEnabled === false[\s\S]*?ACCOUNTING_NOT_ALLOWED/);
  // قيد المستخدم وفلتر الفريق عنصران في AND: كلاهما قد يحمل teamMemberships (مشرف الفرق) فالنثر يمحو الأول
  assert.match(h, /where: \{ tenantId: tid, isActive: true, AND: \[await adminRepFilter\(req\), docMetric \? teamRepOrDocsWhere\(team\) : teamRepWhere\(team\)\] \}/, 'المناديب في نطاق المستخدم والفريق');
  assert.match(h, /SELECT DISTINCT ON \(date_trunc\('minute', "capturedAt"\)\)/, 'نقطة لكل دقيقة في القاعدة');
  assert.match(h, /"salesRepId" = \$\{repId\}/, 'مندوبٌ مندوب');
  assert.match(h, /const MAX_DISTANCE_DAYS = 31;/);
  assert.match(h, /product = await prisma\.product\.findFirst\(\{ where: \{ id: q\.productId, tenantId: tid \}/, 'الصنف من الشركة نفسها');
});

test('الوحدات المتعددة: معيار «الصنف» يجمع الكمية بالأساس — كرتونٌ وحبّات لا يُقارنان خاماً', () => {
  const m = productQtyByRep([
    { qty: 2, unitFactor: 24, baseQty: 48, invoice: { salesRepId: 'a' } },   // كرتونان = ٤٨ حبة
    { qty: 10, unitFactor: 1, baseQty: 10, invoice: { salesRepId: 'b' } },  // ١٠ حبّات
    { qty: 3, unitFactor: 1, baseQty: null, invoice: { salesRepId: 'b' } }, // صفٌّ لم يملأه الترحيل ⇒ من اللقطة
    { qty: 5, unitFactor: 1, baseQty: 5, invoice: { salesRepId: null } },   // بلا مندوب يسقط
  ]);
  assert.deepEqual([...m.entries()], [['a', 48], ['b', 13]]);
  // خاماً كان «ب» (١٣) يتقدّم «أ» (٢)؛ بالأساس «أ» الأوّل
  assert.deepEqual(rankRows([{ repId: 'a', name: 'أ', value: m.get('a')! }, { repId: 'b', name: 'ب', value: m.get('b')! }]).map((r) => r.repId), ['a', 'b']);
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /select: \{ qty: true, unitFactor: true, baseQty: true, invoice: \{ select: \{ salesRepId: true \} \} \}/);
  assert.match(src, /select: \{ id: true, name: true, unit: true, units: ACTIVE_UNITS_SELECT \}/, 'الصنف بوحداته للعرض');
});
