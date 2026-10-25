/**
 * الشريط الحراريّ بعد «إعدادات الطباعة» (M2، التصميم §3.2 و§3.6) — حارسان قبل كل شيء:
 *
 * ١) **الذهبيّ**: بلا قالب (أو بالملف الافتراضي legacy-58) تخرج وثيقة اليوم **حرفاً بحرف** — الأسلوب و`@page { size: 58mm auto }`
 *    والإطار بعرض 80 مم والمهلة 400 مللي ثانية. النصوص أدناه التُقطت من thermal.ts **قبل** التقسيم (الالتزام 75c7c0f)؛ وصور QR
 *    تُطبَّع إلى `data:QR` لأنّ بايتاتها من مكتبة qrcode لا منّا (معاملاتها محروسة نصّاً في printGuards.test.ts).
 *    أيّ فرقٍ هنا ليس «تحسيناً» بل تغييرٌ على أجهزةٍ تطبع اليوم: لا يُحدَّث الذهبيّ إلا بقرار.
 * ٢) **القالبان الجديدان** يأخذان العنوان والرمز وسطر الضريبة والتنبيه من القرار نفسه، بمقاس @page صالح، ونسخٍ موسومة.
 *
 * thermal.ts يُستورد هنا كما هو (لا DOM في node): إطارٌ مزيّف يلتقط ما يُكتب فيه وما يُطبع.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { PrintRefusedError, printThermalInvoice, printThermalReceipt } from './thermal';
import { COPY_SLOT, LEGACY_THERMAL_GEOM, buildThermalDocument, rollHeightMm, thermalGeom, thermalPageRule } from './thermalHtml';
import {
  PRINT_WARNINGS, defaultPrintOptions, legacyThermalProfile, presetPaper, qrPlan,
  type PaperPresetId, type PrintProfile, type TemplateId,
} from '../lib/print/printSettings';
import type { InvoiceDoc, ReceiptDoc } from './RepDocuments';
import { buildZatcaQr, zatcaTimestamp } from './zatca';
import type { ThermalGeom } from './thermalHtml';

// ─── إطارٌ مزيّف: ما يُكتب، وأسلوب الإطار، وعدد مرّات الطباعة، وقاعدة @page بعد القياس ───
interface Frame { html: string; css: string; printed: number; rule: { textContent: string } }
const frames: Frame[] = [];
const COPY_PX = 400; // ارتفاع كل نسخة بعد التخطيط
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => {
    const f: Frame = { html: '', css: '', printed: 0, rule: { textContent: '' } };
    frames.push(f);
    const idoc = {
      open() {}, close() {}, write(h: string) { f.html = h; },
      images: [], fonts: { ready: Promise.resolve() },
      querySelectorAll: (sel: string) => (sel === 'section.copy'
        ? Array.from({ length: (f.html.match(/<section class="copy">/g) || []).length }, () => ({ getBoundingClientRect: () => ({ height: COPY_PX }) }))
        : []),
      getElementById: (id: string) => (id === 'fs-page' ? f.rule : null),
    };
    return {
      setAttribute() {}, remove() {},
      style: { set cssText(v: string) { f.css = v; }, get cssText() { return f.css; } },
      contentWindow: { document: idoc, focus() {}, print() { f.printed++; } },
    };
  },
  body: { appendChild() {} },
};

const norm = (s: string) => s.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{200,}/g, 'data:QR');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ─── المستندات (التواريخ بلا منطقة ⇒ الساعة نفسها على كل جهاز) ───
const company = { name: 'شركة الاختبار للتوزيع', taxNumber: '300000000000003', address: 'الرياض حي العليا', phone: '0501234567', countryCode: 'SA' };
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const STAMPED = 'AQ' + 'x'.repeat(600);
const base: InvoiceDoc = {
  kind: 'invoice', number: 'INV-1024', date: '2026-10-23T10:30:00', type: 'CASH', company, customer: { name: 'بقالة النور' }, repName: 'أحمد',
  items: [
    { name: 'ماء 330 مل', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46 },
    { name: 'عصير برتقال', qty: 3, unitPrice: 11.5, discountPct: 10, taxPct: 15, lineTotal: 31.05 },
  ],
  subtotal: 67.0, discount: 0, tax: 10.05, total: 77.05,
};
const zatca = (over: Partial<NonNullable<InvoiceDoc['zatca']>>): NonNullable<InvoiceDoc['zatca']> => ({
  phase: 2, mode: 'live', mirror: 'reported', documentStatus: 'REPORTED', subtype: '02', documentKind: 'INVOICE',
  qr: STAMPED, printable: true, overdue: false, reportDeadline: null, issuedAt: null,
  uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be', icv: 42, warnings: 0, ...over,
});
const FIX: Record<string, InvoiceDoc | ReceiptDoc> = {
  simplified: base,
  standard: {
    ...base, number: 'INV-2048', type: 'CREDIT', customer: { name: 'مؤسسة الريان', taxNumber: '311111111111113' }, deliveryDate: '2026-10-25T00:00:00',
    items: [
      { name: 'أرز 5 كجم', unit: 'كيس', qty: 4, unitPrice: 57.5, discountPct: 0, taxPct: 15, lineTotal: 230 },
      { name: 'حليب أطفال', unit: 'علبة', qty: 1, unitPrice: 40, discountPct: 0, taxPct: 0, lineTotal: 40 },
    ],
    pricesIncludeTax: true, subtotal: 240, discount: 0, tax: 30, total: 270, paidAmt: 100, remainingAmt: 170,
    recipientSignature: SIG, repSignature: SIG,
  },
  stamped: { ...base, number: 'INV-4096', zatca: zatca({}) },
  delivery: {
    ...base, number: 'INV-4097', customer: { name: 'مؤسسة الريان', taxNumber: '311111111111113' },
    zatca: zatca({ mode: 'rehearsal', mirror: 'clearance_pending', documentStatus: 'SUBMITTING', subtype: '01', qr: null, printable: false, uuid: null, icv: null }),
  },
  ret: { ...base, number: 'RET-7', isReturn: true, type: 'CREDIT' },
  receiptOne: {
    kind: 'receipt', number: 'RC-77', date: '2026-10-23T11:05:00', company, customer: { name: 'بقالة النور' }, repName: 'أحمد',
    amount: 77.05, paymentMethod: 'CASH', invoices: [{ number: 'INV-1024', amount: 77.05 }],
  },
  receiptMany: {
    kind: 'receipt', number: 'RC-78', date: '2026-10-23T11:06:00', company, customer: { name: 'مؤسسة الريان' }, repName: 'أحمد',
    amount: 500, paymentMethod: 'BANK_TRANSFER', notes: 'دفعة أكتوبر', cancelled: true,
    invoices: [{ number: 'INV-1', amount: 200 }, { number: 'INV-2', amount: 100 }],
  },
  receiptPending: {
    kind: 'receipt', number: 'OFF-1', date: '2026-10-23T11:07:00', company: null, customer: { name: 'زبون' }, repName: 'أحمد',
    amount: 10, paymentMethod: 'POS', offline: true,
  },
};

// ─── الذهبيّ: من thermal.ts قبل التقسيم ───
const GOLDEN_SIMPLIFIED = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/>
  <style>
    @page { size: 58mm auto; margin: 0; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { width: 58mm; margin: 0; padding: 0; }
    body { padding: 2mm 2.5mm 4mm; font-family: 'Tahoma','Arial',sans-serif; font-size: 11px; color: #000; line-height: 1.5; }
    .c { text-align: center; }
    .b { font-weight: 700; }
    .lg { font-size: 14px; }
    .xl { font-size: 17px; }
    .sep { border-top: 1px dashed #000; margin: 4px 0; }
    .row { display: flex; justify-content: space-between; gap: 6px; }
    .muted { font-size: 10px; }
    .item { margin: 3px 0; }
    .iname { font-weight: 600; }
    .qr { text-align: center; margin: 8px 0 4px; }
    img { display: inline-block; }
  </style></head><body>
    
    <div class="c b lg">شركة الاختبار للتوزيع</div>
    <div class="c muted">الرقم الضريبي 300000000000003</div>
    <div class="c muted">الرياض حي العليا</div>
    <div class="c muted">هاتف 0501234567</div>
    <div class="sep"></div>
    <div class="c b">فاتورة ضريبية مبسطة</div>
    
    
    <div class="sep"></div>
    <div class="row"><span>رقم</span><span class="b">INV-1024</span></div>
    <div class="row"><span>التاريخ</span><span>٢٣/١٠/٢٠٢٦ ١٠:٣٠</span></div>
    
    <div class="row"><span>المندوب</span><span>أحمد</span></div>
    <div class="row"><span>العميل</span><span>بقالة النور</span></div>
    
    <div class="sep"></div>
    
    <div class="item">
      <div class="iname">ماء 330 مل <span class="muted">(كرتون)</span></div>
      <div class="row"><span>٢ × ٢٣٫٠٠</span><span class="b">٤٦٫٠٠</span></div>
    </div>
    <div class="item">
      <div class="iname">عصير برتقال</div>
      <div class="row"><span>٣ × ١١٫٥٠ -١٠%</span><span class="b">٣١٫٠٥</span></div>
    </div>
    <div class="sep"></div>
    <div class="row"><span>المجموع قبل الضريبة</span><span>٦٧٫٠٠</span></div>
    
    <div class="row"><span>ض.ق.م 15%</span><span>١٠٫٠٥</span></div>
    <div class="row b lg"><span>الإجمالي</span><span>٧٧٫٠٥</span></div>
    
    <div class="sep"></div>
    
    <div class="qr"><img src="data:QR" width="124" height="124"/></div>
    
    
    <div class="c muted">شركة الاختبار للتوزيع</div>
    <div class="c muted">شكرا لتعاملكم معنا</div>
  </body></html>`;
const GOLDEN_RECEIPT_ONE = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/>
  <style>
    @page { size: 58mm auto; margin: 0; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { width: 58mm; margin: 0; padding: 0; }
    body { padding: 2mm 2.5mm 4mm; font-family: 'Tahoma','Arial',sans-serif; font-size: 11px; color: #000; line-height: 1.5; }
    .c { text-align: center; }
    .b { font-weight: 700; }
    .lg { font-size: 14px; }
    .xl { font-size: 17px; }
    .sep { border-top: 1px dashed #000; margin: 4px 0; }
    .row { display: flex; justify-content: space-between; gap: 6px; }
    .muted { font-size: 10px; }
    .item { margin: 3px 0; }
    .iname { font-weight: 600; }
    .qr { text-align: center; margin: 8px 0 4px; }
    img { display: inline-block; }
  </style></head><body>
    
    <div class="c b lg">شركة الاختبار للتوزيع</div>
    <div class="c muted">الرقم الضريبي 300000000000003</div>
    <div class="c muted">الرياض حي العليا</div>
    <div class="c muted">هاتف 0501234567</div>
    <div class="sep"></div>
    <div class="c b">سند قبض</div>
    
    <div class="sep"></div>
    <div class="row"><span>رقم</span><span class="b">RC-77</span></div>
    <div class="row"><span>التاريخ</span><span>٢٣/١٠/٢٠٢٦ ١١:٠٥</span></div>
    <div class="row"><span>المندوب</span><span>أحمد</span></div>
    <div class="sep"></div>
    <div class="row"><span>استلمنا من</span><span>بقالة النور</span></div>
    <div class="row"><span>طريقة الدفع</span><span>نقدي</span></div>
    
    <div class="sep"></div>
    <div class="c muted">المبلغ المستلم</div>
    <div class="c b xl">٧٧٫٠٥ ر.س</div>
    <div class="sep"></div><div class="row"><span>مقابل الفاتورة رقم</span><span class="b">INV-1024</span></div>
    <div class="sep"></div>
    <div class="c muted">شركة الاختبار للتوزيع</div>
    <div class="c muted">شكرا لتعاملكم معنا</div>
  </body></html>`;
const GOLDEN_SHA: Record<string, string> = {
  simplified: '350489f89760cba4a46f63ca94c2c1ba4f97941335c8f8efaac0c9671b6c7e0c',
  standard: '3ed6d7b111daaa185b7b82961082217645c81f36115f3636d15716ecdaec6d69',
  stamped: 'cfaa621f0787485e4b47fc18803385c79f2a75b3eab4d990532b524fdfed4e48',
  delivery: 'f6c0bdacd593a059c632238f68d2fd26f3029c05f4361e26d263e475e167c917',
  ret: '0d1ac6a386aeabca911270b5bc26ae3e2655d9c0f1c18b3d36d7c87bc45de192',
  receiptOne: 'c9ea394b586ffb20f46a0a6947f69874e12b63b25e52f86f0a7f2c370bcba5d9',
  receiptMany: '614fef03b680b31ed019bdd81a4e14f30a10c9f31ad84d69be52dd1e889c8b4b',
  receiptPending: '1a4364c7dad4cef88a2bd830c9ffb77ab95166bc42456f312f541aa8839861d9',
};

type Opts = Parameters<typeof printThermalInvoice>[1];
async function printOne(doc: InvoiceDoc | ReceiptDoc, opts?: Opts): Promise<Frame> {
  const before = frames.length;
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  assert.equal(frames.length, before + 1, 'إطار طباعة واحد');
  return frames[frames.length - 1];
}

const profile = (template: TemplateId, preset: PaperPresetId, patch?: Partial<PrintProfile['options']>): PrintProfile => ({
  id: 'van-1', name: 'سيارة 1', printer: 'thermal', template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions('thermal'), ...patch },
});
const brackets = (s: string) => `[${s}]`;

test('الذهبيّ: بلا قالب أو بالملف الافتراضي — وثيقة اليوم حرفاً بحرف، والإطار والمهلة كما هما', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // الملف الافتراضي بخياراتٍ عبثية ومترجمٍ يغيّر كل نصّ: الكلاسيكي لا يقرأ شيئاً منهما
  const meddled: PrintProfile = { ...legacyThermalProfile(), options: { ...defaultPrintOptions('thermal'), copies: 3, copyLabels: true, showRepName: false, fontScale: 1.3, footerText: 'x' } };
  for (const [name, doc] of Object.entries(FIX)) {
    for (const opts of [undefined, { profile: legacyThermalProfile(), tr: brackets }, { profile: meddled, tr: brackets }, { profile: null }] as Opts[]) {
      const f = await printOne(doc, opts);
      const html = norm(f.html);
      if (name === 'simplified') assert.equal(html, GOLDEN_SIMPLIFIED);
      else if (name === 'receiptOne') assert.equal(html, GOLDEN_RECEIPT_ONE);
      assert.equal(sha(html), GOLDEN_SHA[name], `${name}: الشريط الكلاسيكي تغيّر\n${html}`);
      assert.equal(f.css, 'position:fixed;right:-9999px;bottom:0;width:80mm;height:0;border:0;');
      // الطباعة بعد 400 مللي ثانية كما اليوم — لا قبلها
      t.mock.timers.tick(399);
      assert.equal(f.printed, 0);
      t.mock.timers.tick(1);
      assert.equal(f.printed, 1);
      assert.equal(f.rule.textContent, '', 'لا قياس ولا قاعدة جديدة للكلاسيكي');
    }
  }
});

test('توسيط خانة الرمز في القالب الجديد وحده — والشريط الكلاسيكي بلا قاعدةٍ جديدة', () => {
  const body = '<div class="qr"><div class="qrslot" data-qr-value="x" data-qr-ec="L" style="width:46.6mm;height:46.6mm"></div></div>';
  for (const preset of ['roll58', 'roll80', 'roll_a4'] as const) {
    const doc = buildThermalDocument(body, thermalGeom(profile('roll_compact', preset), null));
    assert.equal((doc.match(/\.qrslot \{ margin: 0 auto \}/g) || []).length, 1, preset);
  }
  assert.ok(!buildThermalDocument(body).includes('.qrslot'), 'الذهبيّ بلا تغيير');
  assert.ok(!buildThermalDocument(body, LEGACY_THERMAL_GEOM).includes('.qrslot'));
});

test('buildThermalDocument نقيّ: الهندسة الافتراضية = غلاف اليوم حول الجسم كما هو', () => {
  const head = GOLDEN_SIMPLIFIED.slice(0, GOLDEN_SIMPLIFIED.indexOf('<body>') + '<body>'.length);
  const body = '<div class="c">§</div>';
  assert.equal(buildThermalDocument(body), `${head}${body}</body></html>`);
  assert.equal(buildThermalDocument(body, LEGACY_THERMAL_GEOM), buildThermalDocument(body));
  assert.ok(head.includes('@page { size: 58mm auto; margin: 0; }'), 'القاعدة غير الصالحة تبقى للكلاسيكي عمداً');
  assert.ok(Object.isFrozen(LEGACY_THERMAL_GEOM));
});

test('القالب الجديد: @page صالح بعرض الورق وطولٍ مقيس، والحزمة بعرضها في موضعها، والإطار بعرض الورق', async () => {
  const f = await printOne(FIX.simplified, { profile: profile('roll_compact', 'roll80') });
  assert.equal(f.printed, 1);
  assert.ok(f.html.includes('<style id="fs-page">@page { size: 80mm 297mm; margin: 0; }</style>'), 'طولٌ مؤقّت قبل القياس');
  const h = Math.ceil((COPY_PX * 25.4) / 96 * 10) / 10 + 1;
  assert.equal(f.rule.textContent, `@page { size: 80mm ${h}mm; margin: 0; }`);
  assert.equal(rollHeightMm([COPY_PX, 10]), h);
  assert.equal(rollHeightMm([]), undefined);
  assert.doesNotMatch(f.html, /auto;/, 'لا size: auto');
  assert.ok(f.html.includes('html { width: 80mm;'));
  assert.ok(f.html.includes('body { width: 72mm; margin: 0 auto 0 4mm;'), 'حزمة 72 مم في منتصف 80');
  assert.equal(f.css, 'position:fixed;right:-9999px;bottom:0;width:80mm;height:0;border:0;');
  // الإزاحة تحرّك الحزمة ولا تخرجها عن الورق
  const shifted = profile('roll_compact', 'roll80'); shifted.paper.offsetXmm = 2;
  assert.ok((await printOne(FIX.simplified, { profile: shifted })).html.includes('margin: 0 auto 0 6mm;'));
  shifted.paper.offsetXmm = -15;
  assert.ok((await printOne(FIX.simplified, { profile: shifted })).html.includes('margin: 0 auto 0 0mm;'));
  // الهامش العلوي والتغذية بعد الطباعة حشوةُ كل نسخة على الرول
  assert.ok(f.html.includes('.copy { padding: 0mm 0 10mm; }'));
  // الورق المقطع (A4 حراري): طوله ثابت وهامشاه في @page ولا قياس
  const sheet = await printOne(FIX.simplified, { profile: profile('roll_detailed', 'roll_a4') });
  assert.ok(sheet.html.includes('@page { size: 210mm 297mm; margin: 5mm 0 5mm 0; }'));
  assert.equal(sheet.rule.textContent, '');
  assert.equal(thermalPageRule(thermalGeom(profile('roll_compact', 'roll58'), null), 120.5), '@page { size: 58mm 120.5mm; margin: 0; }');
  // مقياس الخط والخط العريض
  const big = await printOne(FIX.simplified, { profile: profile('roll_compact', 'roll80', { fontScale: 1.3, boldBody: true }) });
  assert.ok(big.html.includes('font-size: 14.3px; color: #000; line-height: 1.5; font-weight: 700;'));
});

test('النسخ: كل نسخةٍ صفحتها بالعنوان نفسه والرمز نفسه، و«الأصل» ثم «نسخة» سطراً تحت العنوان', async () => {
  const f = await printOne(FIX.stamped, { profile: profile('roll_compact', 'roll80', { copies: 3, copyLabels: true }) });
  assert.equal((f.html.match(/<section class="copy">/g) || []).length, 3);
  assert.ok(f.html.includes('.copy + .copy { break-before: page;'));
  const sections = f.html.split('<section class="copy">').slice(1);
  sections.forEach((sec, i) => {
    assert.ok(sec.includes('<div class="c b">فاتورة ضريبية مبسطة</div>'), 'العنوان لا يتغيّر');
    assert.ok(sec.includes(`<div class="copy-label">${i === 0 ? 'الأصل' : 'نسخة'}</div>`));
    assert.equal((norm(sec).match(/data:QR/g) || []).length, 1, 'الرمز نفسه في كل نسخة');
    assert.ok(sec.indexOf('copy-label') > sec.indexOf('فاتورة ضريبية مبسطة'), 'الوسم تحت العنوان');
  });
  assert.ok(!f.html.includes(COPY_SLOT), 'موضع الوسم لا يبقى في الوثيقة');
  // بلا وسم: النسخ نفسها بلا سطر
  const plain = await printOne(FIX.simplified, { profile: profile('roll_compact', 'roll80', { copies: 2 }) });
  assert.equal((plain.html.match(/<section class="copy">/g) || []).length, 2);
  assert.ok(!plain.html.includes('copy-label">'));
});

test('القرار نفسه في القالبين: العنوان والضريبة وعنوان الإجمالي والتنبيه والعلامة من zatcaPrintDecision', async () => {
  // سند التسليم (قياسية لم تُعتمد، بيئة المحاكاة): بلا ضريبة ولا رمز، والسبب والعلامة على الورقة
  for (const template of ['roll_compact', 'roll_detailed'] as const) {
    const f = await printOne(FIX.delivery, { profile: profile(template, 'roll80') });
    assert.ok(f.html.includes('سند تسليم — ليست فاتورة ضريبية'));
    assert.ok(f.html.includes('سلمت البضاعة وبانتظار اعتماد الهيئة'));
    assert.ok(f.html.includes('نسخة تجريبية — بيئة محاكاة الهيئة'));
    assert.ok(!/ضريبة القيمة المضافة|المجموع قبل الضريبة|class="qr"/.test(f.html), `${template}: ضريبةٌ أو رمزٌ على سند تسليم`);
    assert.ok(f.html.includes('المبلغ المستحق شامل الضرائب'), 'الفرق بلا سطرٍ يفسّره');
    assert.ok(!f.html.includes('السعر شامل الضريبة'));
  }
  // المرحلة الأولى: الرمز المحليّ بمقاس اليوم ومعه سطر الضريبة
  const p1 = await printOne(FIX.simplified, { profile: profile('roll_compact', 'roll58') });
  assert.ok(norm(p1.html).includes('<div class="qr"><img src="data:QR" width="124" height="124"/></div>'));
  assert.ok(p1.html.includes('ضريبة القيمة المضافة 15%'));
  // المرتجع: عنوانه وإجماليه
  const ret = await printOne(FIX.ret, { profile: profile('roll_compact', 'roll80') });
  assert.ok(ret.html.includes('إشعار دائن مرتجع') && ret.html.includes('إجمالي المرتجع دائن'));
  // المترجم يمرّ على كل نصّ والعنوان من القرار
  const tr = await printOne(FIX.simplified, { profile: profile('roll_compact', 'roll80'), tr: brackets });
  assert.ok(tr.html.includes('[فاتورة ضريبية مبسطة]') && tr.html.includes('[رقم]') && tr.html.includes('[الأصل]') === false);
});

test('المفصّل: جدول كمية/سعر/إجمالي، وسعر الوحدة قبل الضريبة للقياسية وحدها، وعمود النسبة حين تختلط', async () => {
  const f = await printOne(FIX.standard, { profile: profile('roll_detailed', 'roll80') });
  assert.ok(f.html.includes('<table class="t">'));
  assert.ok(f.html.includes('<th>السعر شامل الضريبة</th>'), 'الأسعار شاملة: عنوان العمود يقول ذلك');
  assert.ok(f.html.includes('<th>الضريبة</th>'), 'نسبتان مختلطتان ⇒ عمود النسبة');
  assert.equal((f.html.match(/قبل الضريبة:/g) || []).length, 1, 'سعر قبل الضريبة لبند 15% وحده (لا لبند 0%)');
  assert.ok(f.html.includes('منها ضريبة القيمة المضافة نسب متعددة'));
  assert.ok(f.html.includes('311111111111113'), 'الرقم الضريبي للمشتري');
  assert.ok(f.html.includes('توقيع المستلم') && f.html.includes('المتبقي'));
  // المبسّطة: لا سعر قبل الضريبة (التصنيف من القرار لا من التخمين)، ونسبةٌ واحدة بلا عمود
  const s = await printOne(FIX.simplified, { profile: profile('roll_detailed', 'roll80') });
  assert.ok(!s.html.includes('قبل الضريبة:') && !s.html.includes('<th>الضريبة</th>'));
  // خيارات المحتوى: المندوب والوحدة والتوقيعات والتذييل — والاسم والرقم الضريبي والعنوان لا تُخفى
  const lean = await printOne(FIX.standard, { profile: profile('roll_compact', 'roll80', { showRepName: false, showItemUnit: false, showSignatures: false, showContact: false, footerText: 'نراكم قريبا' }) });
  assert.ok(!lean.html.includes('أحمد') && !lean.html.includes('(كيس)') && !lean.html.includes('توقيع المستلم') && !lean.html.includes('0501234567'));
  assert.ok(lean.html.includes('نراكم قريبا') && !lean.html.includes('شكرا لتعاملكم معنا'));
  assert.ok(lean.html.includes('شركة الاختبار للتوزيع') && lean.html.includes('الرقم الضريبي 300000000000003') && lean.html.includes('فاتورة ضريبية'));
});

test('الرمز المختوم: مقاسه من qrPlan على خلاياه الفعلية، ولا طباعة إن لم يتسع — ولا لمستندٍ لا ورقة له', async () => {
  const cells = QRCode.create(STAMPED, { errorCorrectionLevel: 'L' }).modules.size;
  const auto = await printOne(FIX.stamped, { profile: profile('roll_compact', 'roll80') });
  assert.ok(auto.html.includes(`<div class="qrbox" style="--qr:${Math.round(cells * 4 / 8 * 100) / 100}mm">`), '4 نقاط للخلية على 203');
  const large = await printOne(FIX.stamped, { profile: profile('roll_compact', 'roll80', { qrSize: 'large' }) });
  assert.ok(large.html.includes(`--qr:${Math.round(cells * 5 / 8 * 100) / 100}mm`));
  // 58 مم «كبير»: ينزل حتى يتسع ولا ينزل عن الحد الأدنى
  const r58 = await printOne(FIX.stamped, { profile: profile('roll_compact', 'roll58', { qrSize: 'large' }) });
  const plan58 = qrPlan(profile('roll_compact', 'roll58', { qrSize: 'large' }), cells)!;
  assert.ok(plan58.fits && plan58.dotsPerCell >= 3 && plan58.dotsPerCell < 5 && (cells + 4) * plan58.dotsPerCell <= 384);
  assert.ok(r58.html.includes(`--qr:${Math.round(plan58.sizeMm * 100) / 100}mm`));
  // أضيق من أن يتسع ⇒ رفضٌ بسبب يُقرأ، ولا إطار
  const narrow = profile('roll_compact', 'roll58'); narrow.paper.printableDots = 256;
  const before = frames.length;
  await assert.rejects(printThermalInvoice(FIX.stamped as InvoiceDoc, { profile: narrow }), (e: unknown) => e instanceof PrintRefusedError && e.message === PRINT_WARNINGS.qrNoFit);
  // مستندٌ مُبطل: القالب الجديد يرفض حتى لو استُدعي مباشرةً
  const voided = { ...(FIX.stamped as InvoiceDoc), zatca: zatca({ mirror: 'rejected' }) };
  await assert.rejects(printThermalInvoice(voided, { profile: profile('roll_compact', 'roll80') }), PrintRefusedError);
  assert.equal(frames.length, before);
});

test('السند على القالب الجديد: الفواتير المقابلة والإلغاء والمشتري، مترجماً', async () => {
  const f = await printOne(FIX.receiptMany, { profile: profile('roll_detailed', 'roll80'), tr: brackets });
  assert.ok(f.html.includes('[سند قبض]') && f.html.includes('— [سند ملغى] —'));
  assert.ok(f.html.includes('[مقابل الفواتير]') && f.html.includes('[رصيد دائن للعميل]'));
  assert.ok(f.html.includes('[تحويل بنكي]'));
  const one = await printOne(FIX.receiptOne, { profile: profile('roll_compact', 'roll58') });
  assert.ok(one.html.includes('<span>مقابل الفاتورة رقم</span><span class="b">INV-1024</span>'));
  assert.ok(one.html.includes('<style id="fs-page">'));
});

// ═══ M3: الطباعة المباشرة بالبلوتوث — الكلاسيكي لا يُرسل أبداً، والقالبان الجديدان يأخذان الرمز خانةً بنقاط صحيحة ═══

test('البلوتوث لا يمسّ الشريط الكلاسيكي: وسيلة البلوتوث وشريط التجربة يُهملان والوثيقة كاليوم حرفاً بحرف', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let called = 0;
  const sink = async () => { called++; };
  for (const [name, doc] of Object.entries(FIX)) {
    for (const p of [undefined, legacyThermalProfile()]) {
      const f = await printOne(doc, { profile: p, raster: sink, sampleBanner: '<div data-sample-banner="">S</div>' });
      assert.equal(sha(norm(f.html)), GOLDEN_SHA[name], `${name}: الشريط الكلاسيكي تغيّر`);
      t.mock.timers.tick(400);
    }
  }
  assert.equal(called, 0, 'الكلاسيكي لا يصل البلوتوث');
});

test('خانة الرمز للبلوتوث: القيمة كما هي ومستوى تصحيحها ومقاسها (الخلايا + 4) × نقاط qrPlan — بلا صورة ولا إطار نظام طباعة', async () => {
  const cells = QRCode.create(STAMPED, { errorCorrectionLevel: 'L' }).modules.size;
  const got: Array<{ html: string; geom: ThermalGeom }> = [];
  const sink = async (html: string, geom: ThermalGeom) => { got.push({ html, geom }); };
  const before = frames.length;
  await printThermalInvoice(FIX.stamped as InvoiceDoc, {
    profile: profile('roll_compact', 'roll80', { copies: 2, copyLabels: true }), raster: sink, sampleBanner: '<div data-sample-banner="">S</div>',
  });
  assert.equal(frames.length, before, 'لا إطار نظام طباعة');
  assert.equal(got.length, 1);
  const h = got[0].html;
  const side = Math.round((((cells + 4) * 4 + 1) / 8) * 100) / 100;
  assert.ok(h.includes(`<div class="qrslot" data-qr-value="${STAMPED}" data-qr-ec="L" style="width:${side}mm;height:${side}mm"></div>`), 'الخانة بالقيمة المختومة كما هي');
  // الخانة كتلةٌ لا يوسّطها text-align: بلا هامشٍ تلقائي كانت تلتصق باليمين (RTL) فيُرسم الرمز على حافة الحزمة
  assert.ok(h.includes('    .qrslot { margin: 0 auto }\n'), 'الخانة في منتصف الحزمة');
  assert.ok(!h.includes('data:image/png'), 'لا صورة رمزٍ تُعاد عيّنتها');
  assert.equal((h.match(/<section class="copy">/g) || []).length, 2, 'النسختان في الوثيقة نفسها');
  assert.equal((h.match(/data-sample-banner/g) || []).length, 4, 'شريط التجربة أوّل كل نسخة وآخرها');
  assert.ok(h.includes('<div class="c b">فاتورة ضريبية مبسطة</div>'), 'العنوان من القرار');
  // رمز المرحلة الأولى: الحمولة المبنية خلف مصدرها نفسها، بتصحيح M كصورة اليوم
  got.length = 0;
  await printThermalInvoice(FIX.simplified as InvoiceDoc, { profile: profile('roll_detailed', 'roll80'), raster: sink });
  const payload = buildZatcaQr({ sellerName: company.name, vatNumber: company.taxNumber, timestamp: zatcaTimestamp(base.date), total: base.total, vatTotal: base.tax });
  assert.ok(got[0].html.includes(`data-qr-value="${payload}" data-qr-ec="M"`));
  // السند بلا رمز يصل البلوتوث أيضاً
  got.length = 0;
  await printThermalReceipt(FIX.receiptOne as ReceiptDoc, { profile: profile('roll_compact', 'roll58'), raster: sink });
  assert.equal(got.length, 1);
  assert.ok(!got[0].html.includes('data-qr-value'));
  // لا يتسع ⇒ رفضٌ قبل البلوتوث
  const narrow = profile('roll_compact', 'roll58'); narrow.paper.printableDots = 256;
  got.length = 0;
  await assert.rejects(printThermalInvoice(FIX.stamped as InvoiceDoc, { profile: narrow, raster: sink }), (e: unknown) => e instanceof PrintRefusedError && e.message === PRINT_WARNINGS.qrNoFit);
  assert.equal(got.length, 0);
});

// ═══ «إدارة طرق الدفع» (طلب المالك ٢٥ أكتوبر): اسم الشركة للطريقة على الشريطين — والذهبيّ أعلاه (شركةٌ بلا إعداد) كما هو ═══

test('طريقة الدفع باسم الشركة: المضافة باسمها لا بمفتاحها ولا تُترجم، والمدمجة المسمّاة باسمها، والمفتاح المجهول باسم أساسه', async () => {
  const paymentMethodsConfig = {
    version: 1,
    builtins: { POS: { label: 'مدى', active: true } },
    custom: [{ key: 'c_stcpay01', label: 'STC Pay', base: 'POS', icon: 'smartphone', active: true }],
  };
  const co = { ...company, paymentMethodsConfig };
  const rcp = (paymentMethod: string, paymentMethodKey: string | null): ReceiptDoc => ({ ...(FIX.receiptOne as ReceiptDoc), company: co, paymentMethod, paymentMethodKey });
  const row = (label: string, v: string) => `<span>${label}</span><span>${v}</span>`;
  // الكلاسيكي: عربيٌّ بلا مترجم كاليوم
  assert.ok((await printOne(rcp('POS', 'c_stcpay01'))).html.includes(row('طريقة الدفع', 'STC Pay')));
  assert.ok((await printOne(rcp('POS', null))).html.includes(row('طريقة الدفع', 'مدى')));
  assert.ok((await printOne(rcp('POS', 'c_gone0001'))).html.includes(row('طريقة الدفع', 'مدى')), 'مفتاحٌ مجهول ⇒ اسم أساسه لا «c_…»');
  assert.ok((await printOne(rcp('CASH', null))).html.includes(row('طريقة الدفع', 'نقدي')));
  // القالب الجديد: الافتراضي مترجم كاليوم، واسم الشركة كما كتبته
  const roll = { profile: profile('roll_compact', 'roll58'), tr: brackets };
  assert.ok((await printOne(rcp('POS', 'c_stcpay01'), roll)).html.includes(row('[طريقة الدفع]', 'STC Pay')));
  assert.ok((await printOne(rcp('POS', null), roll)).html.includes(row('[طريقة الدفع]', 'مدى')));
  assert.ok((await printOne(rcp('CASH', null), roll)).html.includes(row('[طريقة الدفع]', '[نقدي]')));
});
