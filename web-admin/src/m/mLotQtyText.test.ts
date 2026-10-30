// «تتبّع اللوط» — البوابة E (البند ١٢): كميات التشغيلات بالأساس في تحميل السيارة (/m) كانت أرقاماً عارية بجانب سطرٍ
// بالكرتون («المتاح في المستودع 30» تُقرأ ٣٠ كرتوناً). القاعدة ٨ (docs/multi-unit/DESIGN.md): مفكَّكةً بوحداتها أو بجانب
// اسم الأساس — وبأربع خانات (D22) لا خانتين.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lotQtyText } from './mLotsLogic';
import type { UnitDef } from '../lib/units';

const carton = { id: 'c', name: 'كرتون', factor: 12, isActive: true } as UnitDef;
const p = { unit: 'حبة', units: [carton] };
const num = (n: number) => String(n);

test('lotQtyText: مفكَّكة بوحدات الصنف، وبجانب اسم الأساس لما دون الوحدة الكبرى، وبأربع خانات', () => {
  assert.equal(lotQtyText(30, p, num), '2 كرتون و6 حبة');
  assert.equal(lotQtyText(18, p, num), '1 كرتون و6 حبة');
  assert.equal(lotQtyText(24, p, num), '2 كرتون');
  assert.equal(lotQtyText(6, p, num), '6 حبة');
  assert.equal(lotQtyText(0.1234, p, num), '0.1234 حبة', 'لا تُقصّ إلى خانتين');
  assert.equal(lotQtyText(0.12345, { unit: 'كجم' }, num), '0.1235 كجم', 'تقريب اللوط نصف-لأعلى بأربع خانات');
});

test('lotQtyText: صنفٌ بلا وحدات أكبر — الرقم واسم الأساس، وبلا اسمٍ الرقم وحده كما كان', () => {
  assert.equal(lotQtyText(30, { unit: 'حبة', units: [] }, num), '30 حبة');
  assert.equal(lotQtyText(30, { unit: 'حبة' }, num), '30 حبة');
  assert.equal(lotQtyText(30, { unit: '' }, num), '30');
});

test('MRepLoad: معاينة FEFO ومصادر التنزيل بالأساس عبر lotQtyText لا fmtQty العاري', () => {
  const s = fs.readFileSync(path.join(process.cwd(), 'src', 'm', 'MRepLoad.tsx'), 'utf8');
  const blocks = ['function FefoPreview(', 'function OutLotsEditor('].map(h => {
    const a = s.indexOf(h);
    assert.ok(a > 0, `${h} مفقود`);
    const rest = s.slice(a);
    const end = /\r?\n\}\r?\n/.exec(rest);
    assert.ok(end, `${h} بلا نهاية`);
    return rest.slice(0, end.index);
  });
  for (const b of blocks) assert.ok(!/fmtQty\(/.test(b), 'كمية لوطٍ عارية بلا وحدة');
  assert.match(s, /<FefoPreview productId=\{r\.productId\} prod=\{prod\} /, 'المعاينة بلا وحدات الصنف');
  assert.match(s, /<OutLotsEditor sources=\{outSourcesOf\(r\)\} prod=\{prod\} /, 'مصادر التنزيل بلا وحدات الصنف');
});
