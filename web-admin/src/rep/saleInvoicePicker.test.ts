// اختيار فاتورة البيع للمرتجع (SaleInvoicePicker.tsx) — حارسٌ نصّي لدرسٍ كشفته المراجعة: `tr` من useTr تتجدّد في كل رسم،
// فوضعها في اعتماديات تأثير التحميل كان يعيد طلب فواتير العميل بلا نهاية (وحلقة رسمٍ تجمّد الجوال دون اتصال).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isPhase2Company, manualReturnRefAllowed, returnLinkRequired } from '../lib/returnPolicy';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), 'src', rel), 'utf8').replace(/\r\n/g, '\n');

test('التحميل مرّةً لكل عميل — لا `tr` في اعتماديات التأثير', () => {
  const src = read('rep/SaleInvoicePicker.tsx');
  assert.match(src, /\}, \[customerId\]\);/, 'اعتماديات التحميل');
  assert.doesNotMatch(src, /\[customerId, tr\]/, 'tr في الاعتماديات تعيد الطلب في كل رسم');
});

test('بند فاتورة البيع يحفظ سعر استرداده — أسعار العميل المتأخّرة لا تستبدله', () => {
  const app = read('rep/RepApp.tsx');
  const i = app.indexOf('setLines(prev => prev.map(l => {');
  assert.ok(i > 0);
  assert.match(app.slice(i, i + 300), /if \(l\.saleItemId\) return l;/);
});

// ═══ «اشتراط اختيار فاتورة البيع للمرتجع» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — المنتقي والأوضاع الثلاثة في تطبيق المندوب ═══

/** مرآة أعلام CreateInvoice (يثبت النصّ أدناه أنها هي): retLinkOnly للأولى مع الاشتراط، وretManualOk للثانية المطفأة */
const flags = (phase2: boolean, setting: boolean | null) => {
  const c = { ...(phase2 ? { zatcaRegime: { phase: 2, mode: 'live' } } : {}), returnRequiresSaleInvoice: setting };
  const retPhase2 = isPhase2Company(c);
  const retLinkRequired = returnLinkRequired(c);
  return { retLinkOnly: retLinkRequired && !retPhase2, retManualOk: manualReturnRefAllowed(c), retPhase2 };
};

test('الأعلام من lib/returnPolicy.ts — والإعداد null لا يُشعل شيئاً في المرحلتين (لا تغيير مرئي)', () => {
  const app = read('rep/RepApp.tsx');
  assert.match(app, /const retPhase2 = isReturn && isPhase2Company\(company\);/);
  assert.match(app, /const retLinkRequired = isReturn && returnLinkRequired\(company\);/);
  assert.match(app, /const retLinkOnly = retLinkRequired && !retPhase2;/);
  assert.match(app, /const retManualOk = isReturn && manualReturnRefAllowed\(company\);/);
  assert.match(app, /const retManual = retManualOk && manualMode && !saleRef;/);
  for (const phase2 of [false, true]) {
    const f = flags(phase2, null);
    assert.deepEqual([f.retLinkOnly, f.retManualOk], [false, false], `الافتراض في المرحلة ${phase2 ? 2 : 1}`);
  }
  // الصريح المساوي للافتراض (true في الثانية، false في الأولى) كالافتراض تماماً
  assert.deepEqual([flags(true, true).retLinkOnly, flags(true, true).retManualOk], [false, false]);
  assert.deepEqual([flags(false, false).retLinkOnly, flags(false, false).retManualOk], [false, false]);
  assert.deepEqual([flags(false, true).retLinkOnly, flags(false, true).retManualOk], [true, false], 'الأولى مع الاشتراط');
  assert.deepEqual([flags(true, false).retLinkOnly, flags(true, false).retManualOk], [false, true], 'الثانية بلا اشتراط');
});

test('المرحلة الأولى مع الاشتراط: المنتقي يُفتح تلقائياً، ولا صنف قبل الفاتورة، ولا «إلغاء الربط»، ولافتة دون اتصال', () => {
  const app = read('rep/RepApp.tsx');
  assert.match(app, /if \(!retLinkOnly \|\| autoPicked\.current \|\| saleRef \|\| customer\._offline \|\| !navigator\.onLine\) return;\n\s+autoPicked\.current = true;\n\s+setPickSale\(true\);/);
  assert.match(app, /: retLinkOnly \? tr\('الشركة تشترط اختيار فاتورة البيع للمرتجع — اختر الفاتورة أولا'\)/);
  // returnBlock: بعد فاتورة البيع وقبل قيد الصلاحية — يمنع النقر والماسح والقائمة معاً
  const rb = app.slice(app.indexOf('const returnBlock = (p: any): string | null => {'), app.indexOf('const addLine = '));
  assert.ok(rb.indexOf('if (retSourceBlock) return retSourceBlock;') > rb.indexOf('if (saleRef)'));
  assert.ok(rb.indexOf('if (retSourceBlock) return retSourceBlock;') < rb.indexOf('shelfLifeEnabled'));
  // البحث والماسح مخفيّان، والشبكة عبارةٌ مكانها
  assert.match(app, /\{!retSourceBlock && \(\n\s+<div className="mb-2 flex items-stretch gap-2">/);
  assert.match(app, /\) : retSourceBlock \? \(\n\s+<div className="text-center text-amber-700 py-10 px-4 text-xs leading-5" role="status">\{retSourceBlock\}<\/div>/);
  assert.match(app, /\{!retLinkOnly && <button onClick=\{clearSale\} className="text-gray-400">\{tr\('إلغاء الربط'\)\}<\/button>\}/);
  assert.match(app, /\{retLinkOnly && !saleRef && !online && \(/);
  assert.match(app, /onManual=\{retManualOk \? goManual : undefined\} required=\{retLinkOnly\}/);
});

test('المنتقي: زرّ «الفاتورة غير موجودة — اكتب رقمها» بـonManual وحده، والقائمة الفارغة مع الاشتراط تقول السبب', () => {
  const src = read('rep/SaleInvoicePicker.tsx');
  assert.match(src, /export default function SaleInvoicePicker\(\{ customerId, products, onPick, onClose, onManual, required = false \}/);
  assert.match(src, /\{onManual && \(\n\s+<div className="p-3 border-t">\n\s+<button type="button" onClick=\{onManual\}/);
  assert.match(src, /\{tr\('الفاتورة غير موجودة — اكتب رقمها'\)\}/);
  assert.match(src, /\{required && <p className="text-amber-700 text-\[11px\] mt-1">\{tr\('لا يصدر مرتجع لهذا العميل دون فاتورة بيع — الشركة تشترط اختيارها'\)\}<\/p>\}/);
});

test('المرحلة الثانية بلا اشتراط: «من فاتورة بيع في النظام» أو «فاتورة من خارج النظام» برقمٍ وطريقة دفع، وبنود فاتورة البيع لا تبقى', () => {
  const app = read('rep/RepApp.tsx');
  assert.match(app, /\) : retManualOk \? \(/, 'الخياران مكان زرّ المنتقي');
  assert.match(app, /onClick=\{goSystem\}/);
  assert.match(app, /onClick=\{goManual\}/);
  assert.match(app, /<input dir="ltr" maxLength=\{RETURN_REF_MAX\} value=\{manualNo\}/);
  assert.match(app, /\(\['CASH', 'CREDIT'\] as const\)\.map\(v => \(\n\s+<button key=\{v\} type="button" onClick=\{\(\) => setManualPay\(v\)\}/);
  const gm = app.slice(app.indexOf('const goManual = () => {'), app.indexOf('const goSystem = '));
  assert.match(gm, /if \(saleRef\) \{ setSaleRef\(null\); setLines\(\[\]\); setShowCart\(false\); \}/);
  assert.match(gm, /setManualMode\(true\);/);
  // اختيار فاتورة بيع يُنهي الرقم اليدويّ
  const op = app.slice(app.indexOf('const onPickSale = (sale: ReturnableSale) => {'), app.indexOf('const clearSale = '));
  assert.match(op, /setManualMode\(false\);/);
  // المراجعة: الفاتورة الأصلية والسبب
  assert.match(app, /\{tr\('الفاتورة الأصلية'\)\}: <b dir="ltr">\{saleRef \? saleRef\.number : normalizeReturnRef\(manualNo\)\}<\/b>/);
});
