// «تتبّع اللوط» — البوابة E (البند ١٢، تتمّة المدقّق): البند يسمّي أيضاً تفصيل تشغيلات المستودع (MWarehouse: WhLotBreakdown)
// و«المتاح» في منتقي التشغيلة (MLotFields) — أرقامٌ بالأساس عاريةٌ تحت صفٍّ أو سطرٍ بالكرتون. القاعدة ٨: عبر lotQtyText
// بوحدات الصنف، وبأربع خانات (D22) لا خانتين ولا ثلاث (formatNumber يقصّ إلى ثلاث).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lotQtyText } from './mLotsLogic';
import type { UnitDef } from '../lib/units';

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', 'm', f), 'utf8');
/** جسم دالةٍ من رأسها حتى أول «}» في أول السطر */
const block = (s: string, head: string) => {
  const a = s.indexOf(head);
  assert.ok(a >= 0, `${head} مفقود`);
  const rest = s.slice(a);
  const end = /\r?\n\}\r?\n/.exec(rest);
  assert.ok(end, `${head} بلا نهاية`);
  return rest.slice(0, end.index);
};

test('lotQtyText: العجز السالب مفكَّكاً بإشارته (تفصيل المستودع يعرض العجز)', () => {
  const p = { unit: 'حبة', units: [{ id: 'c', name: 'كرتون', factor: 12, isActive: true } as UnitDef] };
  assert.equal(lotQtyText(-30, p, String), '-2 كرتون و6 حبة');
});

test('MWarehouse: تفصيل تشغيلات المستودع بوحدات الصفّ لا fmtQty العاري', () => {
  const s = src('MWarehouse.tsx');
  const b = block(s, 'function WhLotBreakdown(');
  assert.ok(!/fmtQty\(/.test(b), 'كمية تشغيلةٍ عارية بلا وحدة في WhLotBreakdown');
  assert.match(b, /lotQtyText\(l\.usable\.SELLABLE, /);
  assert.match(b, /lotQtyText\(unknown, /);
  assert.match(s, /<WhLotBreakdown productId=\{r\.productId\} prod=\{r\} \/>/, 'التفصيل بلا وحدات الصفّ');
  // rep-offline-9: والرئيسية معها — وإلا فُكِّك «المتاح» بأكبر وحدة (الطبلية) لا بالكرتون
  assert.match(s, /<MLotFields productId=\{r\.productId\} prod=\{\{ unit: r\.baseUnit, units: r\.units, primaryUnitId: r\.primaryUnitId \}\} /, 'منتقي المستودع بلا وحدات الصنف ورئيسيته');
  const u: UnitDef[] = [{ id: 'u-c', name: 'كرتون', factor: 24, isActive: true }, { id: 'u-p', name: 'طبلية', factor: 1200, isActive: true }];
  assert.equal(lotQtyText(1250, { unit: 'قارورة', units: u, primaryUnitId: 'u-c' }, String), '52 كرتون و2 قارورة');
  assert.notEqual(lotQtyText(1250, { unit: 'قارورة', units: u }, String), '52 كرتون و2 قارورة', 'بلاها يُفكَّك بالطبلية');
  assert.match(src('MLotFields.tsx'), /prod\?: \{ unit\?: string \| null; units\?: UnitDef\[\] \| null; primaryUnitId\?: string \| null \};/);
});

test('MLotFields: «المتاح» في المنتقي بوحدات الصنف — وMRepLoad يمرّرها', () => {
  const s = src('MLotFields.tsx');
  assert.ok(!/formatNumber\(c\.usable\)/.test(s), '«المتاح» عارٍ في المنتقي');
  assert.match(s, /lotQtyText\(c\.usable, prod, /);
  assert.match(src('MRepLoad.tsx'), /<MLotFields productId=\{r\.productId\} mode="LOAD"[^>]*\sprod=\{prod\} /, 'منتقي التحميل بلا وحدات الصنف');
});
