/**
 * «إزالة الضريبة» على الشريط الحراري (طلب المالك ٧ نوفمبر ٢٠٢٦: «في حال ازالة الضريبة لا يكون لها ذكر في اي سطر في النظام ولا في اي
 * مستند») — rep/thermal.ts بقوالبه الثلاثة (الكلاسيكي 58 مم، والمختصر، والمفصّل) ونظام الطباعة والبلوتوث المباشر ومعاينة المحرّر:
 *
 * ١) فاتورةٌ مختومة بلا ضريبة (taxFree) ⇒ لا «ضريبة» ولا «ض.ق.م» ولا VAT ولا الرقم الضريبي للبائع أو المشتري ولا رمز QR ولا «مبسطة»
 *    ولا «إشعار دائن»، بأيّ لغةٍ ثانية — والعنوان «فاتورة» أو «فاتورة مرتجع»، والمبالغ كما هي.
 * ٢) السند بلا ختم: علم الشركة الآن (taxDisabled) يُسقط الرقمين الضريبيين.
 * ٣) المستند القديم بضريبته (taxFree غائب) يُطبع كما صدر ولو أُزيلت الضريبة بعده — والافتراضي حرفاً (الحرّاس الذهبية في
 *    rollThermal.baseline وthermalHtml لا تتغيّر).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { printThermalInvoice, printThermalReceipt, thermalPreviewHtml, type ThermalPrintOptions } from './thermal';
import type { Company, InvoiceDoc, ReceiptDoc } from './RepDocuments';
import { defaultPrintOptions, presetPaper, type PaperPresetId, type PrintOptions, type PrintProfile, type TemplateId } from '../lib/print/printSettings';
import { DEFAULT_SECTIONS } from '../lib/print/layout';
import { firstTaxMention, withoutTaxIds } from '../lib/print/taxFreePrint';
import type { PrintSecondLang } from '../lib/print/printTextsCore';
import { setActiveNumerals } from '../utils/format';

// المبالغ بأرقامٍ لاتينية ليُفحص المبلغ نصّاً (الأرقام العربية افتراض الواجهة — لا تمسّ ما يُفحص هنا)
setActiveNumerals('latin');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SELLER_VAT = '300000000000003';
const BUYER_VAT = '311111111111113';
const same = (s: string): string => s;

const company = (over: Partial<Company> = {}): Company => ({
  name: 'شركة الاختبار', taxNumber: SELLER_VAT, address: 'الرياض حي العليا', phone: '0501234567', logo: PNG, countryCode: 'SA',
  taxDisabled: true, ...over,
});
const texts = (secondLang: PrintSecondLang | null) => ({ version: 1, secondLang, companyNameAlt: null, companyAddressAlt: null, edits: {} });

/** فاتورةٌ صدرت بلا ضريبة: كل البنود 0% والإجمالي = الصافي (الخادم يختمها taxFree) */
const FREE_ITEMS: InvoiceDoc['items'] = [
  { name: 'أرز', unit: 'كيس', qty: 4, unitPrice: 50, discountPct: 0, taxPct: 0, lineTotal: 200 },
  { name: 'زيت', unit: 'حبة', qty: 6, unitPrice: 12.5, discountPct: 10, taxPct: 0, lineTotal: 67.5 },
];
const freeInv = (over: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-9001', date: '2026-11-07T10:30:00', type: 'CREDIT', company: company(),
  customer: { name: 'مؤسسة الريان', taxNumber: BUYER_VAT, businessName: 'الريان', address: 'طريق الملك', city: 'جدة' },
  repName: 'أحمد', items: FREE_ITEMS, subtotal: 275, discount: 7.5, tax: 0, total: 267.5, pricesIncludeTax: false,
  paidAmt: 67.5, remainingAmt: 200, recipientSignature: PNG, repSignature: PNG, taxFree: true, zatca: null, ...over,
});
const freeReturn = (over: Partial<InvoiceDoc> = {}): InvoiceDoc => freeInv({
  number: 'RET-77', isReturn: true, type: 'CASH', billingReference: 'INV-9001', noteReason: 'تلف في العبوة',
  paidAmt: undefined, remainingAmt: undefined, ...over,
});
/** مستندٌ قديم بضريبته — صدر قبل إزالة الضريبة (لا ختم) */
const oldInv = (): InvoiceDoc => freeInv({
  number: 'INV-1000', taxFree: undefined, pricesIncludeTax: true, tax: 34.89, total: 267.5,
  items: FREE_ITEMS.map((it) => ({ ...it, taxPct: 15 })),
});
const rcp = (over: Partial<ReceiptDoc> = {}): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-77', date: '2026-11-07T11:05:00', company: company(),
  customer: { name: 'بقالة النور', taxNumber: BUYER_VAT, address: 'حي النسيم', city: 'الرياض' },
  repName: 'أحمد', amount: 137.05, paymentMethod: 'CASH', notes: 'دفعة', invoices: [{ number: 'INV-9001', amount: 137.05 }], ...over,
});

function prof(template: TemplateId, preset: PaperPresetId, layout?: Record<string, unknown>): PrintProfile {
  const options = { ...defaultPrintOptions('thermal'), showLogo: true, ...(layout ? { layout } : {}) } as PrintOptions;
  return { id: 'van-1', name: 'سيارة', printer: 'thermal', template, paper: presetPaper(preset) as PrintProfile['paper'], options };
}
const FREE_LAYOUT = {
  design: 'standard', logo: 'center', logoSize: 'l', accent: null, tableStyle: 'grid', order: [...DEFAULT_SECTIONS.thermal],
  logoMm: 20, sections: { totals: { align: 'center', fontPct: 120 } },
};

async function roll(doc: InvoiceDoc | ReceiptDoc, profile: PrintProfile | null, raster = false): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile, tr: same };
  if (raster) opts.raster = async (html) => { out = html; };
  else opts.capture = (html) => { out = html; };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  return out;
}

/** كل قالبٍ حراريّ بكل طريقة: الكلاسيكي (بلا قالب)، والمختصر والمفصّل بعرضين، والتحرير الحرّ، والبلوتوث المباشر */
const PROFILES: readonly { name: string; p: PrintProfile | null; raster?: boolean }[] = [
  { name: 'classic', p: null },
  { name: 'compact58', p: prof('roll_compact', 'roll58') },
  { name: 'compact80', p: prof('roll_compact', 'roll80') },
  { name: 'detailed80', p: prof('roll_detailed', 'roll80') },
  { name: 'detailed80-free', p: prof('roll_detailed', 'roll80', FREE_LAYOUT) },
  { name: 'compact80-bt', p: prof('roll_compact', 'roll80'), raster: true },
  { name: 'detailed112-bt', p: prof('roll_detailed', 'roll112'), raster: true },
];
const LANGS: readonly (PrintSecondLang | null)[] = [null, 'en', 'fr', 'tr', 'zh'];

function assertNoTax(html: string, label: string): void {
  assert.equal(firstTaxMention(html), null, `${label}: ذكرٌ للضريبة`);
  assert.ok(!html.includes(SELLER_VAT), `${label}: الرقم الضريبي للبائع`);
  assert.ok(!html.includes(BUYER_VAT), `${label}: الرقم الضريبي للمشتري`);
  assert.ok(!html.includes('data-qr-value'), `${label}: خانة رمز`);
  assert.ok(!/class="qr(box)?"/.test(html), `${label}: كتلة رمز`);
  assert.ok(!html.includes('ICV'), `${label}: ICV`);
}

test('فاتورة البيع المختومة بلا ضريبة: لا ذكر للضريبة في أيّ قالبٍ حراريّ وبأيّ لغةٍ ثانية — والعنوان «فاتورة» والمبالغ كما هي', async () => {
  for (const { name, p, raster } of PROFILES) {
    for (const lang of LANGS) {
      const doc = freeInv({ company: company({ printTexts: lang === null ? null : texts(lang) }) });
      const html = await roll(doc, p, raster);
      const label = `${name}/${lang ?? 'ar'}`;
      assert.ok(html.length > 500, `${label}: لا وثيقة`);
      assertNoTax(html, label);
      assert.match(html, />فاتورة</, `${label}: العنوان «فاتورة»`);
      for (const amount of ['267.50', '200.00', '67.50']) assert.ok(html.includes(amount), `${label}: المبلغ ${amount}`);
      assert.ok(html.includes('شركة الاختبار') && html.includes('مؤسسة الريان'), `${label}: البائع والمشتري باسميهما`);
      if (lang === 'en') assert.ok(html.includes('Invoice'), `${label}: سطر العنوان الثاني «Invoice»`);
    }
  }
});

test('المرتجع المختوم بلا ضريبة: «فاتورة مرتجع» لا «إشعار دائن مرتجع» — ولا «Credit Note» في السطر الثاني', async () => {
  for (const { name, p, raster } of PROFILES) {
    for (const lang of LANGS) {
      const doc = freeReturn({ company: company({ printTexts: lang === null ? null : texts(lang) }) });
      const html = await roll(doc, p, raster);
      const label = `${name}/${lang ?? 'ar'}`;
      assertNoTax(html, label);
      assert.ok(html.includes('فاتورة مرتجع'), `${label}: عنوان المرتجع`);
      assert.ok(html.includes('INV-9001'), `${label}: مرجع الفاتورة الأصلية`);
      if (lang === 'en') assert.ok(html.includes('Return Invoice'), `${label}: «Return Invoice»`);
    }
  }
});

test('صياغة الشركة لعنواني الفاتورة والمرتجع تسري على المستند بلا ضريبة (كاليوم) — وحذفها يحذف السطر', async () => {
  const edits = {
    'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false },
    'inv.returnTitle': { text: 'مرتجع مبيعات', alt: null, hidden: false },
  };
  const c = company({ printTexts: { ...texts(null), edits } });
  for (const { name, p } of PROFILES.filter((x) => x.p)) {
    assert.ok((await roll(freeInv({ company: c }), p)).includes('فاتورة مبيعات'), name);
    assert.ok((await roll(freeReturn({ company: c }), p)).includes('مرتجع مبيعات'), name);
  }
  const gone = company({ printTexts: { ...texts(null), edits: { 'inv.returnTitle': { text: null, alt: null, hidden: true } } } });
  const html = await roll(freeReturn({ company: gone }), prof('roll_compact', 'roll80'));
  assert.ok(!html.includes('فاتورة مرتجع'), 'العنوان المحذوف لا يُطبع');
  assertNoTax(html, 'returnTitle hidden');
});

test('دفاعاً: فاتورةٌ مختومة ومبلغ ضريبتها غير صفر (حالٌ لا يُنتجها الخادم) — لا «المبلغ المستحق شامل الضرائب»', async () => {
  const odd = freeInv({ tax: 5, pricesIncludeTax: false });
  for (const { name, p, raster } of PROFILES) {
    const html = await roll(odd, p, raster);
    assertNoTax(html, name);
    assert.ok(html.includes('الإجمالي'), `${name}: عنوان الإجمالي`);
  }
});

test('معاينة محرّر «نصوص المطبوعات» (thermalPreviewHtml) بلا ضريبة — 58 و80 مم والفاتورة والسند', async () => {
  for (const paperMm of [58, 80] as const) {
    assertNoTax(await thermalPreviewHtml(freeInv(), { tr: same, paperMm }), `preview-inv-${paperMm}`);
    assertNoTax(await thermalPreviewHtml(freeReturn(), { tr: same, paperMm }), `preview-ret-${paperMm}`);
    assertNoTax(await thermalPreviewHtml(rcp(), { tr: same, paperMm }), `preview-rcp-${paperMm}`);
  }
});

test('سند القبض لشركةٍ أزالت الضريبة: لا رقمٌ ضريبيّ للشركة ولا للعميل في أيّ قالب — وبلا العلم يُطبعان كاليوم', async () => {
  for (const { name, p, raster } of PROFILES) {
    for (const lang of LANGS) {
      const off = rcp({ company: company({ printTexts: lang === null ? null : texts(lang) }) });
      const label = `${name}/${lang ?? 'ar'}`;
      const html = await roll(off, p, raster);
      assertNoTax(html, label);
      assert.ok(html.includes('سند قبض') && html.includes('137.05'), `${label}: السند ومبلغه`);
    }
    // بلا العلم: الرقم الضريبي للشركة كما اليوم (الترويسة في كل قالب)
    const on = await roll(rcp({ company: company({ taxDisabled: false }) }), p, raster);
    assert.ok(on.includes(SELLER_VAT), `${name}: الرقم الضريبي للشركة ذات الضريبة`);
  }
});

test('المستند القديم بضريبته يُطبع كما صدر ولو أُزيلت الضريبة بعده (الختم يحكم لا علم الشركة)', async () => {
  for (const { name, p, raster } of PROFILES) {
    const html = await roll(oldInv(), p, raster);
    assert.ok(html.includes(SELLER_VAT), `${name}: الرقم الضريبي للبائع على المستند القديم`);
    assert.ok(/ضريب|ض\.ق\.م/.test(html), `${name}: سطر الضريبة على المستند القديم`);
  }
});

test('بلا ختم: الورقة نفسها حرفاً — taxFree:false والعلم وحده لا يغيّران الفاتورة', async () => {
  const base = freeInv({ taxFree: undefined, company: company({ taxDisabled: undefined }) });
  for (const { name, p, raster } of PROFILES) {
    const today = await roll(base, p, raster);
    assert.equal(await roll({ ...base, taxFree: false }, p, raster), today, `${name}: taxFree:false`);
    assert.equal(await roll({ ...base, company: company({ taxDisabled: true }) }, p, raster), today, `${name}: علم الشركة لا يمسّ الفاتورة`);
    assert.equal(await roll({ ...base, company: company({ taxDisabled: false }) }, p, raster), today, `${name}: taxDisabled:false`);
  }
  for (const { name, p, raster } of PROFILES) {
    const r = rcp({ company: company({ taxDisabled: undefined }) });
    assert.equal(await roll({ ...r, company: company({ taxDisabled: false }) }, p, raster), await roll(r, p, raster), `${name}: السند بلا علم`);
  }
});

test('withoutTaxIds: نسخةٌ بلا الرقمين — والمستند الأصليّ كما هو', () => {
  const doc = freeInv();
  const out = withoutTaxIds(doc);
  assert.equal(out.company?.taxNumber, undefined);
  assert.equal(out.customer.taxNumber, undefined);
  assert.equal(doc.company?.taxNumber, SELLER_VAT);
  assert.equal(doc.customer.taxNumber, BUYER_VAT);
  assert.equal(out.customer.name, doc.customer.name);
  assert.equal(withoutTaxIds({ ...doc, company: null }).company, null);
});
