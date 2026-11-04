/**
 * خطّ الأساس الذهبيّ لـ«تخطيط المطبوعات» بمفاتيحه الستة (design/logo/logoSize/accent/tableStyle/order) — كما طبعتها المنصّة في
 * 8696ef7 (٣ نوفمبر ٢٠٢٦) قبل «التحرير الحرّ» (logoMm/logoAfter/sections/canvas).
 *
 * لماذا: خطّا الأساس printA4/rollThermal يثبّتان الملفات **بلا** تخطيط؛ وهذا يثبّت ملفات الشركات التي حفظت تخطيطاً قبل التحرير
 * الحرّ: يجب أن تطبع حرفاً بحرف كما كانت ما دامت لم تختر مفتاحاً حرّاً (pd_spec B.1، E.2).
 *
 * التغطية: الصفحة (page_branded A4) والنقطية (impact_plain) والثنائي اللغة على الصفحة والنقطية والرول 58 (مختصر) و80 (مفصّل)
 * × أربعة تخطيطات ممثِّلة لكلٍّ × فاتورة المرحلة الأولى وفاتورة المرحلة الثانية بالرمز المختوم والإشعار الدائن المختوم وسند القبض،
 * وحالةٌ بنصوص مطبوعات بلغة ثانية لكل هدف. الرول يُلتقط نصّه الكامل (capture) — رمز PNG المولَّد مختصرٌ بـdata:QR.
 *
 * التوليد من الشجرة النقية 8696ef7 وحدها (git archive)، لا من شجرة العمل:
 *   LAYOUT6_WRITE=1 npx tsx --test src/rep/printLayout6.baseline.test.ts      (يُرفض داخل CI)
 * والوضع الافتراضي مقارنةٌ فقط. هذا الملف وملفّا `__baseline__/layout6.*` لا يعدّلها إلا كاتبها.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, type Company, type DocCustomer, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { printThermalInvoice, printThermalReceipt } from './thermal';
import {
  defaultPrintLayout, defaultPrintOptions, presetPaper,
  type PaperPresetId, type PrintLayout, type PrintOptions, type PrintProfile, type TemplateId,
} from '../lib/print/printSettings';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('arabic');
setActiveCurrency('SAR');

const DIR = fileURLToPath(new URL('./__baseline__/', import.meta.url));
const MANIFEST = path.join(DIR, 'layout6.manifest.json');
const BUNDLE = path.join(DIR, 'layout6.markup.json.br');
const WRITE = process.env.LAYOUT6_WRITE === '1';

// ─── البيانات الثابتة ───
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const STAMPED_QR = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBaBAU3MC4wMAUEOS4xMwYsWlhoaGJYQnNaU0J6YVdkdVlYUjFjbVVnYUdGemFDQjJZV3gxWlE9PQcgU0lHTkFUVVJFX1NJR05BVFVSRV9TSUdOQVRVUkVfMDE=';
const DATE = '2026-11-02T09:15:00.000Z';

const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'الرياض، حي العليا، شارع التحلية', taxNumber: '300000000000003',
  commercialReg: '1010101010', phone: '0501234567', email: 'info@example.sa', logo: LOGO,
  primaryColor: '#E15A30', headerStyle: null, countryCode: 'SA', invoiceSignatureEnabled: true,
} as Company;
const RETAIL: DocCustomer = { name: 'بقالة النور', phone: '0551112223', address: 'شارع الأمير سلطان', district: 'حي الملز', city: 'الرياض' };
const B2B: DocCustomer = {
  name: 'محمد العتيبي', businessName: 'مؤسسة الأفق التجارية', commercialReg: '1010202020', taxNumber: '311111111111113',
  phone: '0112345678', address: 'طريق الملك فهد', district: 'حي الصحافة', city: 'الرياض',
};
type Item = InvoiceDoc['items'][number];
const ITEMS: Item[] = [
  { name: 'مياه معدنية 330 مل', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46, unitFactor: 24, multiUnit: true },
  { name: 'عصير برتقال 250 مل', unit: 'حبة', qty: 3, unitPrice: 2.5, discountPct: 10, taxPct: 15, lineTotal: 6.75 },
  { name: 'بسكويت بالتمر', qty: 1.5, unitPrice: 11.5, discountPct: 0, taxPct: 15, lineTotal: 17.25 },
];
const TOTALS = { subtotal: 61.52, discount: 0.65, tax: 9.13, total: 70, pricesIncludeTax: true };

const inv = (over: Partial<InvoiceDoc>): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-2611-000123', date: DATE, type: 'CREDIT', company: COMPANY, customer: RETAIL, repName: 'أحمد السالم',
  items: ITEMS, ...TOTALS, paidAmt: 20, remainingAmt: 50, ...over,
});
const zv = (over: Partial<ZatcaDocView>): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'reported', documentStatus: 'REPORTED', subtype: '02', documentKind: 'INVOICE',
  qr: STAMPED_QR, printable: true, overdue: false, reportDeadline: null, issuedAt: DATE,
  uuid: '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c', icv: 4127, warnings: 0, ...over,
});

type AnyDoc = InvoiceDoc | ReceiptDoc;
const DOCS: Record<string, AnyDoc> = {
  p1Standard: inv({
    customer: B2B, deliveryDate: '2026-11-05T00:00:00.000Z', recipientSignature: SIG, repSignature: SIG, paidAmt: 0, remainingAmt: 70,
    installments: [
      { seq: 1, dueDate: '2026-12-02T00:00:00.000Z', amount: 35 },
      { seq: 2, dueDate: '2027-01-02T00:00:00.000Z', amount: 35 },
    ],
    paymentPlan: 'INSTALLMENT',
  }),
  p2Simplified: inv({ zatca: zv({}) }),
  p2CreditNote: inv({
    isReturn: true, number: 'RET-2611-000011', billingReference: 'INV-2610-000777', noteReason: 'إرجاع بضاعة قريبة الانتهاء',
    zatca: zv({ documentKind: 'CREDIT_NOTE' }),
  }),
  receipt: {
    kind: 'receipt', number: 'RC-2611-000045', date: DATE, company: COMPANY, customer: RETAIL, repName: 'أحمد السالم',
    amount: 100, paymentMethod: 'CASH', invoices: [{ number: 'INV-2611-000123', amount: 100 }], notes: 'دفعة نوفمبر',
  },
};

const TEXTS_BI = {
  version: 1, secondLang: 'en', companyNameAlt: 'Test Distribution Co.', companyAddressAlt: 'Tahlia St, Olaya, Riyadh',
  edits: {
    'inv.number': { text: null, alt: 'Invoice No.', hidden: false },
    'cust.phone': { text: 'رقم الجوال', alt: 'Mobile', hidden: false },
    'h.email': { text: null, alt: null, hidden: true },
    'foot.thanks': { text: 'نشكر زيارتكم', alt: 'Thank you for your visit', hidden: false },
  },
};

// ─── التخطيطات الممثِّلة (كلها صالحة بقواعد 8696ef7) ───
type L6 = Omit<PrintLayout, never>;
type Target = 'page' | 'impact' | 'gridPage' | 'gridImpact' | 'roll58' | 'roll80';
interface Variant { layout: (t: Target) => L6; options?: Partial<PrintOptions> }

const STD_VARIANTS: Record<string, Variant> = {
  default: { layout: (t) => defaultPrintLayout(t === 'impact' ? 'impact' : 'page', 'standard') },
  endLStriped: {
    layout: () => ({
      design: 'standard', logo: 'end', logoSize: 'l', accent: '#0F766E', tableStyle: 'striped',
      order: ['header', 'items', 'info', 'totals', 'note', 'installments', 'signatures', 'footer'],
    }),
  },
  noneSGrid: {
    layout: () => ({
      design: 'standard', logo: 'none', logoSize: 's', accent: null, tableStyle: 'grid',
      order: ['header', 'info', 'note', 'items', 'installments', 'totals', 'signatures', 'footer'],
    }),
  },
  centerSScaled: {
    layout: () => ({
      design: 'standard', logo: 'center', logoSize: 's', accent: '#1D4ED8', tableStyle: 'lines',
      order: ['header', 'info', 'items', 'note', 'totals', 'installments', 'signatures', 'footer'],
    }),
    options: { fontScale: 1.15 },
  },
};
const GRID_VARIANTS: Record<string, Variant> = {
  default: { layout: (t) => defaultPrintLayout(t === 'gridImpact' ? 'impact' : 'page', 'grid_bilingual') },
  startL: {
    layout: () => ({
      design: 'grid_bilingual', logo: 'start', logoSize: 'l', accent: '#7C3AED', tableStyle: 'grid',
      order: ['header', 'parties', 'info', 'items', 'totals', 'note', 'installments', 'signatures', 'footer'],
    }),
  },
  noneS: {
    layout: () => ({
      design: 'grid_bilingual', logo: 'none', logoSize: 's', accent: null, tableStyle: 'grid',
      order: ['header', 'info', 'parties', 'items', 'note', 'totals', 'installments', 'signatures', 'footer'],
    }),
  },
  endScaled: {
    layout: () => ({
      design: 'grid_bilingual', logo: 'end', logoSize: 'm', accent: '#B91C1C', tableStyle: 'grid',
      order: ['header', 'info', 'parties', 'items', 'installments', 'note', 'totals', 'signatures', 'footer'],
    }),
    options: { fontScale: 0.9 },
  },
};
const ROLL_VARIANTS: Record<string, Variant> = {
  default: { layout: () => defaultPrintLayout('thermal', 'standard') },
  centerLMoved: {
    layout: () => ({
      design: 'standard', logo: 'center', logoSize: 'l', accent: null, tableStyle: 'lines',
      order: ['header', 'customer', 'info', 'items', 'totals', 'qr', 'signatures', 'footer'],
    }),
  },
  noneScaled: {
    layout: () => ({
      design: 'standard', logo: 'none', logoSize: 's', accent: null, tableStyle: 'lines',
      order: ['header', 'info', 'customer', 'items', 'totals', 'signatures', 'qr', 'footer'],
    }),
    options: { fontScale: 1.3 },
  },
  centerSItemsFirst: {
    layout: () => ({
      design: 'standard', logo: 'center', logoSize: 's', accent: '#0F766E', tableStyle: 'lines',
      order: ['header', 'items', 'totals', 'info', 'customer', 'qr', 'signatures', 'footer'],
    }),
  },
};

const TARGETS: Record<Target, { template: TemplateId; preset: Exclude<PaperPresetId, 'custom'>; variants: Record<string, Variant> }> = {
  page: { template: 'page_branded', preset: 'a4', variants: STD_VARIANTS },
  impact: { template: 'impact_plain', preset: 'ff_a4', variants: STD_VARIANTS },
  gridPage: { template: 'page_plain', preset: 'a4', variants: GRID_VARIANTS },
  gridImpact: { template: 'impact_plain', preset: 'ff_a4', variants: GRID_VARIANTS },
  roll58: { template: 'roll_compact', preset: 'roll58', variants: ROLL_VARIANTS },
  roll80: { template: 'roll_detailed', preset: 'roll80', variants: ROLL_VARIANTS },
};

function profileOf(t: Target, v: Variant): PrintProfile {
  const spec = TARGETS[t];
  const printer = spec.template.startsWith('impact_') ? 'impact' : spec.template.startsWith('roll_') ? 'thermal' : 'page';
  return {
    id: 'layout6', name: 'layout6', printer, template: spec.template, paper: presetPaper(spec.preset)!,
    options: { ...defaultPrintOptions(printer), showLogo: true, ...v.options, layout: v.layout(t) },
  };
}

const norm = (s: string): string => s.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{200,}/g, 'data:QR');

async function render(doc: AnyDoc, p: PrintProfile): Promise<string> {
  if (p.printer === 'thermal') {
    let out: string | null = null;
    const opts = { profile: p, capture: (html: string) => { out = norm(html); } };
    try {
      if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
    } catch (e) {
      return `ERROR ${(e as Error).name}: ${(e as Error).message}`;
    }
    return out ?? 'NO-OUTPUT';
  }
  const el = doc.kind === 'invoice' ? createElement(PrintableInvoice, { doc }) : createElement(PrintableReceipt, { doc });
  return renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: lookFor(p) }, el));
}

interface Case { name: string; doc: AnyDoc; profile: PrintProfile }
function buildCases(): Case[] {
  const out: Case[] = [];
  for (const [t, spec] of Object.entries(TARGETS) as [Target, (typeof TARGETS)[Target]][]) {
    for (const [vName, v] of Object.entries(spec.variants)) {
      const profile = profileOf(t, v);
      for (const [dName, doc] of Object.entries(DOCS)) out.push({ name: `${t}|${vName}|${dName}|none`, doc, profile });
    }
    // نصوص مطبوعات بلغة ثانية على تخطيطٍ غير افتراضي
    const vName = Object.keys(spec.variants)[1];
    const profile = profileOf(t, spec.variants[vName]);
    for (const dName of ['p2Simplified', 'receipt']) {
      const d = DOCS[dName];
      out.push({ name: `${t}|${vName}|${dName}|bi`, doc: { ...d, company: { ...(d.company as Company), printTexts: TEXTS_BI } } as AnyDoc, profile });
    }
  }
  return out;
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
interface Manifest { about: string; node: string; icu: string; cases: Record<string, { sha: string; len: number }> }
const CASES = buildCases();

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
const around = (s: string, i: number) => JSON.stringify(s.slice(Math.max(0, i - 80), i + 80));

if (WRITE) {
  test('LAYOUT6_WRITE=1: توليد خط أساس التخطيط بمفاتيحه الستة (من الشجرة النقية 8696ef7 وحدها)', async () => {
    assert.ok(!process.env.CI, 'التوليد ممنوع داخل CI');
    const outDir = process.env.LAYOUT6_OUT ? path.resolve(process.env.LAYOUT6_OUT) : DIR;
    fs.mkdirSync(outDir, { recursive: true });
    const cases: Manifest['cases'] = {};
    const markup: Record<string, string> = {};
    for (const c of CASES) {
      const html = await render(c.doc, c.profile);
      const h = sha(html);
      cases[c.name] = { sha: h, len: html.length };
      markup[h] = html;
    }
    const sorted = Object.fromEntries(Object.keys(markup).sort().map((k) => [k, markup[k]]));
    const raw = Buffer.from(JSON.stringify(sorted), 'utf8');
    fs.writeFileSync(path.join(outDir, 'layout6.markup.json.br'), zlib.brotliCompressSync(raw, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    } }));
    const manifest: Manifest = {
      about: 'خط أساس «تخطيط المطبوعات» بمفاتيحه الستة — مولَّد من الشجرة النقية 8696ef7 (٣ نوفمبر ٢٠٢٦) قبل التحرير الحرّ. لا يعدّله إلا كاتبه.',
      node: process.version, icu: process.versions.icu ?? '', cases,
    };
    fs.writeFileSync(path.join(outDir, 'layout6.manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`, 'utf8');
    console.log(`layout6: ${CASES.length} حالة، ${Object.keys(markup).length} مخرَجٍ فريد`);
  });
} else {
  const readManifest = (): Manifest => JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
  let bundle: Record<string, string> | null = null;
  const readBundle = (): Record<string, string> =>
    (bundle ??= JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(BUNDLE)).toString('utf8')) as Record<string, string>);

  test('layout6: المخزن سليم — كل حالةٍ لها نسخة مجمّدة، ولا حالة مفقودة ولا زائدة', () => {
    const m = readManifest();
    const b = readBundle();
    assert.deepEqual(Object.keys(m.cases).sort(), CASES.map((c) => c.name).sort(), 'قائمة الحالات تغيّرت — خط الأساس لا يُعدَّل إلا بكاتبه');
    assert.deepEqual(Object.keys(b).sort(), [...new Set(Object.values(m.cases).map((e) => e.sha))].sort(), 'نسخ مجمّدة يتيمة أو مفقودة');
    for (const [h, html] of Object.entries(b)) assert.equal(sha(html), h, `النسخة ${h.slice(0, 16)} عُدّلت يدوياً`);
  });

  for (const t of Object.keys(TARGETS) as Target[]) {
    test(`layout6 حرفاً بحرف (تخطيطٌ بمفاتيحه الستة = 8696ef7): ${t}`, async () => {
      const m = readManifest();
      const b = readBundle();
      const mine = CASES.filter((c) => c.name.startsWith(`${t}|`));
      assert.ok(mine.length > 0);
      const bad: string[] = [];
      for (const c of mine) {
        const html = await render(c.doc, c.profile);
        const want = m.cases[c.name]?.sha;
        const got = sha(html);
        if (got === want) continue;
        const frozen = (want && b[want]) || '';
        const i = firstDiff(frozen, html);
        bad.push(`${c.name}\n   sha ${String(want).slice(0, 16)} ⇒ ${got.slice(0, 16)}، أول اختلاف عند ${i} (الطول ${frozen.length} ⇒ ${html.length})\n   كان:  ${around(frozen, i)}\n   صار:  ${around(html, i)}`);
      }
      const env = m.icu !== (process.versions.icu ?? '') ? `\n(ICU ${process.versions.icu} غير ICU الالتقاط ${m.icu})` : '';
      assert.equal(bad.length, 0, `${bad.length} من ${mine.length} تغيّرت عن 8696ef7:\n${bad.slice(0, 8).join('\n')}${env}`);
    });
  }

  test('layout6 يحمل ما يدّعيه: الرمز المختوم في كل هدف، والشعار، وغياب الرفض', () => {
    const m = readManifest();
    const b = readBundle();
    for (const [name, e] of Object.entries(m.cases)) {
      const html = b[e.sha];
      assert.ok(!html.startsWith('ERROR') && html !== 'NO-OUTPUT', `${name}: ${html.slice(0, 120)}`);
      if (/\|p2(Simplified|CreditNote)\|/.test(name)) {
        const qr = name.startsWith('roll') ? /class="qrbox"/.test(html) : html.includes('data-qr-value') || /<img[^>]+alt="QR"/.test(html);
        assert.ok(qr, `${name}: رمز QR`);
      }
    }
  });
}
