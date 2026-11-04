/**
 * مراجعة الحراري طرفاً لطرف (التحرير الحرّ): جدول «الشريط المفصّل» بخطٍّ مكبَّر.
 *
 * رُسمت الفاتورة في Chromium حقيقيّ ومرّت بمسار البلوتوث كاملاً (rasterPages ⇒ encodeForProfile): أعمدة المفصّل الخمسة تملأ
 * حزمة 72 مم بخط 100٪، فقسم الأصناف بخط 130–160٪ كان يكسر الأرقام وسط خاناتها (الكمية «٦٠٠» ⇒ «٦٠» ثم «٠»، والإجمالي
 * «٤٧٧٨٫٥٠» على ثلاثة أسطر) والكلمات العربية وسط حروفها («الكمية»، «الضريبة»، «الإجمالي») — وhtml2canvas يرسم الكلمة المنكسرة
 * حرفاً حرفاً بأشكالها المنفصلة فتتراكب على الورق. ومنع الكسر وحده يجعل الجدول 415 بكسلاً في حزمةٍ عرضها 272 فيضيع عمود
 * الإجمالي. فجدول المفصّل لا يكبر عن خط القالب (والتصغير يسري)، وبقية الأقسام والشريط المختصر تكبر كما هي.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printThermalInvoice, type ThermalPrintOptions } from './thermal';
import type { Company, InvoiceDoc } from './RepDocuments';
import { defaultPrintOptions, presetPaper, type PaperPresetId, type PrintOptions, type PrintProfile, type TemplateId } from '../lib/print/printSettings';
import { DEFAULT_SECTIONS } from '../lib/print/layout';

const company: Company = { name: 'شركة الاختبار', taxNumber: '300000000000003', address: 'الرياض', phone: '0501234567', countryCode: 'SA' };
const inv: InvoiceDoc = {
  kind: 'invoice', number: 'INV-4096', date: '2026-10-23T10:30:00', type: 'CASH', company,
  customer: { name: 'مؤسسة الريان', taxNumber: '311111111111113' }, repName: 'أحمد',
  items: [
    { name: 'أرز', unit: 'كيس', qty: 4, unitPrice: 1257.5, discountPct: 0, taxPct: 15, lineTotal: 5030 },
    { name: 'ماء', unit: 'كرتون', qty: 600, unitPrice: 9.5, discountPct: 0, taxPct: 0, lineTotal: 5700 },
  ],
  subtotal: 10730, discount: 0, tax: 656.09, total: 10730, pricesIncludeTax: true,
};
function prof(template: TemplateId, preset: PaperPresetId, sections: Record<string, unknown>): PrintProfile {
  const layout = { design: 'standard', logo: 'center', logoSize: 'm', accent: null, tableStyle: 'grid', order: [...DEFAULT_SECTIONS.thermal], sections };
  const options = { ...defaultPrintOptions('thermal'), layout } as PrintOptions;
  return { id: 'van-1', name: 'سيارة', printer: 'thermal', template, paper: presetPaper(preset) as PrintProfile['paper'], options };
}
async function freeCss(profile: PrintProfile): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile, tr: (s) => s, capture: (h) => { out = h; } };
  await printThermalInvoice(inv, opts);
  return /<style data-fs-free="">([\s\S]*?)<\/style>/.exec(out)?.[1] ?? '';
}

test('جدول المفصّل بخطٍّ مكبَّر: لا تكبير ولا كسر للأرقام والكلمات داخل خلاياه — وبقية الأقسام تكبر', async () => {
  for (const pct of [101, 130, 160]) {
    const css = await freeCss(prof('roll_detailed', 'roll80', { items: { fontPct: pct, align: 'start' }, totals: { fontPct: pct } }));
    assert.ok(!/\[data-sec="items"\][^{]*\{ font-size:/.test(css), `${pct}%: جدول المفصّل كبر عن خط القالب`);
    assert.ok(!/\.t (th|td)[^{]*\{ overflow-wrap: anywhere/.test(css), `${pct}%: خلايا الجدول تنكسر وسط الكلمة`);
    assert.ok(!/\.t \.n \{ white-space: normal/.test(css), `${pct}%: الرقم ينكسر وسط خاناته`);
    assert.ok(css.includes('[data-sec="items"], [data-sec="items"] .c:not(.logo)'), `${pct}%: محاذاة الأصناف ضاعت`);
    assert.match(css, /\[data-sec="totals"\] \{ font-size: [0-9.]+px; \}/, `${pct}%: الإجماليات لم تكبر`);
  }
});

test('جدول المفصّل يصغر كما طُلب، والمختصر يكبر أصنافه كما هي', async () => {
  const small = await freeCss(prof('roll_detailed', 'roll80', { items: { fontPct: 80 } }));
  assert.match(small, /\[data-sec="items"\] \{ font-size: 8\.8px; \}/);
  const compact = await freeCss(prof('roll_compact', 'roll58', { items: { fontPct: 160 } }));
  assert.match(compact, /\[data-sec="items"\] \{ font-size: 17\.6px; \}/);
  assert.ok(compact.includes('[data-sec="items"] .row { flex-wrap: wrap; }'));
});
