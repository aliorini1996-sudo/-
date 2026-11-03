/**
 * BASELINE GOLDEN (3 Nov 2026, before the print-layouts / print-texts "delete line" work): pins TODAY's exact roll output.
 *
 * Every roll template (classic strip, roll_compact on 58/80/82/85/112/roll_a4, roll_detailed on 80/82/85/112/roll_a4, plus option
 * variants) x every document shape (simplified / standard phase 1, phase 2 stamped simplified + standard + rehearsal, delivery note,
 * return phase 1, phase-2 credit note with BT-25/KSA-10, lots, non-Saudi, no-VAT seller, five receipt shapes) x three print-text
 * states (none, a bilingual saved doc, an Arabic-only saved doc). Each case records the exact HTML document that today goes to the
 * system print frame (`capture`), and for non-classic templates the document + geometry that goes to the Bluetooth raster sink
 * (where the QR is a `data-qr-value` slot, so the QR payload itself is pinned verbatim), plus test-print banner, translator and the
 * editor preview (`thermalPreviewHtml`).
 *
 * The classic strip with no texts is already pinned byte-for-byte by rep/thermalHtml.test.ts (GOLDEN_SHA); this file covers a
 * different, wider fixture set and does not duplicate those assertions.
 *
 * Only QR <img> payloads (qrcode library PNG bytes, >=200 base64 chars) are normalised to `data:QR`; their size attributes stay.
 * The QR *values* are pinned through the raster cases.
 *
 * Fixtures: ./__baseline__/roll.manifest.json (sha256 + length per case) and ./__baseline__/roll.samples.json (full documents for
 * a representative subset, for readable diffs). Regenerate ONLY with BASELINE_WRITE=1 and only by the author of this file: a red
 * baseline means a default roll changed on devices that print today.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printThermalInvoice, printThermalReceipt, thermalPreviewHtml, type ThermalPrintOptions } from './thermal';
import type { Company, InvoiceDoc, ReceiptDoc } from './RepDocuments';
import type { ThermalGeom } from './thermalHtml';
import {
  defaultPrintOptions, legacyThermalProfile, presetPaper,
  type PaperPresetId, type PrintOptions, type PrintProfile, type TemplateId,
} from '../lib/print/printSettings';
import { checkPrintTexts, type PrintTextsV1 } from '../lib/print/printTexts';

const WRITE = process.env.BASELINE_WRITE === '1';
const DIR = fileURLToPath(new URL('./__baseline__/', import.meta.url));
const MANIFEST = path.join(DIR, 'roll.manifest.json');
const SAMPLES = path.join(DIR, 'roll.samples.json');

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const norm = (s: string): string => s.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{200,}/g, 'data:QR');
const same = (s: string): string => s;
const brackets = (s: string): string => `[${s}]`;

// ─── Fixtures (deterministic: dates carry no zone, so the wall clock is the same on every machine) ───

/** 1x1 PNG — short enough (<200 base64 chars) to stay verbatim, valid for logo and signature slots */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const STAMPED = 'AQ' + 'Zm'.repeat(150) + 'x'.repeat(398);
const STAMPED_CN = 'AR' + 'Qk'.repeat(140) + 'y'.repeat(418);

const baseCompany: Company = {
  name: 'شركة الاختبار للتوزيع', taxNumber: '300000000000003', commercialReg: '1010101010', address: 'الرياض حي العليا',
  phone: '0501234567', email: 'info@example.com', logo: PNG, countryCode: 'SA',
};

type Zv = NonNullable<InvoiceDoc['zatca']>;
const zatca = (over: Partial<Zv>): Zv => ({
  phase: 2, mode: 'live', mirror: 'reported', documentStatus: 'REPORTED', subtype: '02', documentKind: 'INVOICE',
  qr: STAMPED, printable: true, overdue: false, reportDeadline: null, issuedAt: null,
  uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be', icv: 42, warnings: 0, ...over,
});

const ITEMS: InvoiceDoc['items'] = [
  { name: 'ماء 330 مل', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46, unitFactor: 12 },
  { name: 'عصير برتقال', qty: 3, unitPrice: 11.5, discountPct: 10, taxPct: 15, lineTotal: 31.05 },
  { name: 'تمر سكري', unit: 'كجم', qty: 1.5, unitPrice: 40, discountPct: 0, taxPct: 15, lineTotal: 60 },
];
const MIXED: InvoiceDoc['items'] = [
  { name: 'أرز 5 كجم', unit: 'كيس', qty: 4, unitPrice: 57.5, discountPct: 0, taxPct: 15, lineTotal: 230 },
  { name: 'حليب أطفال', unit: 'علبة', qty: 1, unitPrice: 40, discountPct: 0, taxPct: 0, lineTotal: 40, multiUnit: true },
  { name: 'زيت <نباتي> & "ذرة"', unit: 'حبة', qty: 6, unitPrice: 12.25, discountPct: 5, taxPct: 15, lineTotal: 69.83 },
];
const BUYER = {
  name: 'مؤسسة الريان التجارية', businessName: 'أسواق الريان', commercialReg: '2050505050', taxNumber: '311111111111113',
  phone: '0559876543', address: 'شارع الملك فهد', district: 'حي الملز', city: 'الرياض',
};

const inv = (over: Partial<InvoiceDoc>): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-1024', date: '2026-10-23T10:30:00', type: 'CASH', company: baseCompany,
  customer: { name: 'بقالة النور' }, repName: 'أحمد', items: ITEMS,
  subtotal: 119.18, discount: 0, tax: 17.87, total: 137.05, pricesIncludeTax: true, ...over,
});
const rcp = (over: Partial<ReceiptDoc>): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-77', date: '2026-10-23T11:05:00', company: baseCompany, customer: { name: 'بقالة النور' },
  repName: 'أحمد', amount: 137.05, paymentMethod: 'CASH', invoices: [{ number: 'INV-1024', amount: 137.05 }], ...over,
});

const DOCS: Record<string, InvoiceDoc | ReceiptDoc> = {
  p1Simplified: inv({}),
  p1SimplifiedExcl: inv({ number: 'INV-1025', pricesIncludeTax: false, discount: 5, subtotal: 137.05, tax: 19.81, total: 151.86 }),
  p1Standard: inv({
    number: 'INV-2048', type: 'CREDIT', customer: BUYER, deliveryDate: '2026-10-25T00:00:00', items: MIXED,
    subtotal: 300.72, discount: 0, tax: 39.11, total: 339.83, paidAmt: 100, remainingAmt: 239.83,
    recipientSignature: PNG, repSignature: PNG,
  }),
  p1StandardExcl: inv({
    number: 'INV-2049', customer: BUYER, pricesIncludeTax: false, items: ITEMS.map((it) => ({ ...it, unitFactor: undefined })),
    subtotal: 137.05, discount: 7.5, tax: 19.43, total: 148.98,
  }),
  p2Simplified: inv({ number: 'INV-4096', zatca: zatca({}) }),
  p2Standard: inv({
    number: 'INV-4097', type: 'CREDIT', customer: BUYER, items: MIXED, subtotal: 300.72, discount: 0, tax: 39.11, total: 339.83,
    paidAmt: 0, remainingAmt: 339.83, zatca: zatca({ mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', icv: 43, uuid: '9b1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d' }),
  }),
  p2Rehearsal: inv({ number: 'INV-4098', zatca: zatca({ mode: 'rehearsal', icv: 7 }) }),
  p2Delivery: inv({
    number: 'INV-4099', customer: BUYER,
    zatca: zatca({ mode: 'rehearsal', mirror: 'clearance_pending', documentStatus: 'SUBMITTING', subtype: '01', qr: null, printable: false, uuid: null, icv: null }),
  }),
  // a voided phase-2 document: the new templates refuse (the refusal message is pinned), the classic strip prints as today
  p2Voided: inv({ number: 'INV-4100', zatca: zatca({ mirror: 'rejected', documentStatus: 'REJECTED' }) }),
  p1Return: inv({ number: 'RET-7', isReturn: true, type: 'CREDIT' }),
  p2CreditNote: inv({
    number: 'RET-8', isReturn: true, type: 'CREDIT', billingReference: 'INV-1024', noteReason: 'بضاعة تالفة <منتهية>',
    zatca: zatca({ documentKind: 'CREDIT_NOTE', qr: STAMPED_CN, icv: 44, uuid: '0a1b2c3d-1111-4222-8333-444455556666' }),
  }),
  lots: inv({
    number: 'INV-5000', company: { ...baseCompany, lotTrackingEnabled: true, lotOnInvoice: true },
    items: [
      { ...ITEMS[0], lots: [{ lotNumber: 'L-2026-01', qty: 12, expiryDate: '2027-01-31' }, { lotNumber: 'L-2026-02', qty: 12, expiryDate: null }] },
      { ...ITEMS[1], lots: [{ lotNumber: null, qty: 3 }] },
    ],
    subtotal: 67.0, tax: 10.05, total: 77.05,
  }),
  nonSaudi: inv({ number: 'INV-6000', company: { ...baseCompany, countryCode: 'AE', taxNumber: '100000000000003' }, customer: BUYER }),
  noVat: inv({ number: 'INV-7000', company: { name: 'مؤسسة بلا رقم', address: 'جدة', phone: '0120000000', countryCode: 'SA' } }),
  rcpOne: rcp({}),
  rcpManyCancelled: rcp({
    number: 'RC-78', date: '2026-10-23T11:06:00', customer: BUYER, amount: 500, paymentMethod: 'BANK_TRANSFER', notes: 'دفعة <أكتوبر>',
    cancelled: true, invoices: [{ number: 'INV-1', amount: 200 }, { number: 'INV-2', amount: 100 }],
  }),
  rcpPending: rcp({ number: 'OFF-1', company: null, customer: { name: 'زبون' }, amount: 10, paymentMethod: 'POS', offline: true, invoices: undefined }),
  rcpOnAccount: rcp({ number: 'RC-79', amount: 250, paymentMethod: 'CHEQUE', invoices: [] }),
  rcpUnknown: rcp({ number: 'RC-80', amount: 42.5, invoices: undefined, customer: { name: 'محل الوفاء', address: 'حي النسيم', city: 'الرياض', taxNumber: '322222222222223' } }),
};

const textsDoc = (over: Partial<PrintTextsV1>): PrintTextsV1 => ({ version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null, edits: {}, ...over });
/**
 * Two representative saved docs. Both pass TODAY's strict server check (asserted below), and every hide is on a key whose hide
 * already removes the whole printed line today — so the pinned meaning does not depend on the lock rules being changed next.
 */
const TEXTS: Record<string, PrintTextsV1 | undefined> = {
  none: undefined,
  en: textsDoc({
    secondLang: 'en', companyNameAlt: 'Test Distribution Co.', companyAddressAlt: 'Olaya District, Riyadh',
    edits: {
      'h.phone': { text: null, alt: 'Tel', hidden: false },
      'inv.number': { text: 'رقم المستند', alt: 'Doc No.', hidden: false },
      'inv.rep': { text: null, alt: null, hidden: true },
      'cust.name': { text: 'اسم العميل', alt: null, hidden: false },
      'col.qty': { text: null, alt: 'Qty', hidden: false },
      'tot.vat': { text: null, alt: 'VAT', hidden: false },
      'tot.grand': { text: 'الإجمالي المستحق', alt: 'Total due', hidden: false },
      'foot.thanks': { text: 'نسعد بخدمتكم دائماً', alt: 'Thank you', hidden: false },
      'rcp.title': { text: null, alt: 'Receipt Voucher', hidden: false },
      'rcp.method': { text: 'وسيلة الدفع', alt: 'Payment', hidden: false },
    },
  }),
  ar: textsDoc({
    edits: {
      'inv.title': { text: 'فاتورة مبيعات', alt: null, hidden: false },
      'inv.date': { text: 'تاريخ الفاتورة', alt: null, hidden: false },
      'tot.paid': { text: null, alt: null, hidden: true },
      'sig.recipient': { text: 'توقيع العميل', alt: null, hidden: false },
      'foot.company': { text: null, alt: null, hidden: true },
      'rcp.rep': { text: null, alt: null, hidden: true },
      'rcp.amount': { text: 'المبلغ المقبوض', alt: null, hidden: false },
    },
  }),
};

const withTexts = (doc: InvoiceDoc | ReceiptDoc, texts: PrintTextsV1 | undefined): InvoiceDoc | ReceiptDoc =>
  texts === undefined || !doc.company ? doc : { ...doc, company: { ...doc.company, printTexts: texts } } as InvoiceDoc | ReceiptDoc;

// ─── Profiles ───

const RICH: Partial<PrintOptions> = { showLogo: true, copies: 2, copyLabels: true, fontScale: 1.15, boldBody: true, qrSize: 'large', footerText: 'نراكم قريبا', feedAfterMm: 5 };
const LEAN: Partial<PrintOptions> = { showRepName: false, showItemUnit: false, showSignatures: false, showContact: false, fontScale: 0.9 };

function prof(template: TemplateId, preset: PaperPresetId, o?: Partial<PrintOptions>, paper?: { offsetXmm?: number; marginTopMm?: number }): PrintProfile {
  return {
    id: 'van-1', name: 'سيارة 1', printer: 'thermal', template,
    paper: { ...(presetPaper(preset) as PrintProfile['paper']), ...paper },
    options: { ...defaultPrintOptions('thermal'), ...o },
  };
}

const PROFILES: Record<string, PrintProfile | null> = {
  classic: null,
  'compact.roll58': prof('roll_compact', 'roll58'),
  'compact.roll80': prof('roll_compact', 'roll80'),
  'compact.roll82': prof('roll_compact', 'roll82'),
  'compact.roll85': prof('roll_compact', 'roll85'),
  'compact.roll112': prof('roll_compact', 'roll112'),
  'compact.roll_a4': prof('roll_compact', 'roll_a4'),
  'detailed.roll80': prof('roll_detailed', 'roll80'),
  'detailed.roll82': prof('roll_detailed', 'roll82'),
  'detailed.roll85': prof('roll_detailed', 'roll85'),
  'detailed.roll112': prof('roll_detailed', 'roll112'),
  'detailed.roll_a4': prof('roll_detailed', 'roll_a4'),
  'compact.roll58.rich': prof('roll_compact', 'roll58', RICH, { offsetXmm: 1, marginTopMm: 2 }),
  'compact.roll80.rich': prof('roll_compact', 'roll80', RICH, { offsetXmm: 1.5, marginTopMm: 2 }),
  'detailed.roll80.rich': prof('roll_detailed', 'roll80', RICH, { offsetXmm: -1, marginTopMm: 3 }),
  'compact.roll80.lean': prof('roll_compact', 'roll80', LEAN),
  'detailed.roll112.lean': prof('roll_detailed', 'roll112', LEAN),
};

// ─── Runner ───

type Mode = 'system' | 'raster' | 'sample' | 'tr';

async function run(doc: InvoiceDoc | ReceiptDoc, profile: PrintProfile | null, mode: Mode): Promise<string> {
  let out: string | null = null;
  const opts: ThermalPrintOptions = { profile };
  if (mode === 'raster') {
    opts.raster = async (html: string, geom: ThermalGeom) => { out = `${norm(html)}\n<!--geom ${JSON.stringify(geom)}-->`; };
  } else {
    opts.capture = (html: string) => { out = norm(html); };
  }
  if (mode === 'sample') opts.sampleBanner = '<div data-sample-banner="">نموذج اختبار</div>';
  if (mode === 'tr') opts.tr = brackets;
  try {
    if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  } catch (e) {
    return `ERROR ${(e as Error).name}: ${(e as Error).message}`;
  }
  if (out === null) return 'NO-OUTPUT';
  return out;
}

interface Entry { sha: string; len: number }

async function computeAll(): Promise<{ manifest: Map<string, Entry>; outputs: Map<string, string> }> {
  const manifest = new Map<string, Entry>();
  const outputs = new Map<string, string>();
  const put = (name: string, s: string) => {
    assert.ok(!manifest.has(name), `duplicate case ${name}`);
    manifest.set(name, { sha: sha(s), len: s.length });
    outputs.set(name, s);
  };
  for (const [tName, texts] of Object.entries(TEXTS)) {
    for (const [dName, raw] of Object.entries(DOCS)) {
      const doc = withTexts(raw, texts);
      for (const [pName, p] of Object.entries(PROFILES)) {
        const modes: Mode[] = p === null ? ['system', 'tr']
          : pName === 'compact.roll80' || pName === 'detailed.roll80' ? ['system', 'raster', 'sample', 'tr']
            : ['system', 'raster'];
        for (const mode of modes) put(`${tName}|${dName}|${pName}|${mode}`, await run(doc, p, mode));
      }
      for (const paperMm of [58, 80] as const) {
        let html: string;
        try { html = norm(await thermalPreviewHtml(doc, { tr: same, paperMm })); } catch (e) { html = `ERROR ${(e as Error).name}: ${(e as Error).message}`; }
        put(`${tName}|${dName}|preview${paperMm}|system`, html);
      }
    }
  }
  return { manifest, outputs };
}

/** Full documents kept verbatim for readable diffs */
const SAMPLE_DOCS = ['p1Simplified', 'p1Standard', 'p2Standard', 'p2CreditNote', 'rcpOne', 'rcpManyCancelled'];
const SAMPLE_KEYS = SAMPLE_DOCS.flatMap((d) => [
  `none|${d}|classic|system`, `none|${d}|compact.roll58|system`, `none|${d}|detailed.roll80|system`,
  `none|${d}|compact.roll80|raster`, `en|${d}|compact.roll80|system`, `ar|${d}|detailed.roll80|system`,
]);

function serializeManifest(m: Map<string, Entry>): string {
  const lines = [...m.entries()].map(([k, v]) => `  ${JSON.stringify(k)}: {"sha": "${v.sha}", "len": ${v.len}}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `at ${i}: expected …${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))}… got …${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}…`;
}

// ─── Tests ───

test('baseline inputs: both saved-texts docs are valid under today\'s strict server check', () => {
  for (const [name, t] of Object.entries(TEXTS)) {
    if (!t) continue;
    const r = checkPrintTexts(t, true);
    assert.ok(r.ok, `${name}: ${JSON.stringify(!r.ok && r.issues)}`);
  }
});

test('BASELINE roll: every roll template x document x print-texts state renders exactly as today (system, raster, banner, tr, preview)', async () => {
  const { manifest, outputs } = await computeAll();
  // invariant inside the run: the classic strip with no texts is the same with the explicit legacy-58 profile
  for (const dName of Object.keys(DOCS)) {
    assert.equal(await run(DOCS[dName], legacyThermalProfile(), 'system'), outputs.get(`none|${dName}|classic|system`), `${dName}: legacy-58 != no profile`);
  }
  if (WRITE) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(MANIFEST, serializeManifest(manifest));
    const samples: Record<string, string> = {};
    for (const k of SAMPLE_KEYS) samples[k] = outputs.get(k) as string;
    fs.writeFileSync(SAMPLES, `${JSON.stringify(samples, null, 1)}\n`);
    console.log(`BASELINE_WRITE: wrote ${manifest.size} roll cases and ${SAMPLE_KEYS.length} samples`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Record<string, Entry>;
  const samples = JSON.parse(fs.readFileSync(SAMPLES, 'utf8')) as Record<string, string>;
  // readable diff first, on the verbatim samples
  for (const k of SAMPLE_KEYS) {
    const got = outputs.get(k) as string;
    if (samples[k] !== got) assert.fail(`roll sample ${k} changed ${firstDiff(samples[k] ?? '', got)}`);
  }
  assert.deepEqual([...manifest.keys()].sort(), Object.keys(expected).sort(), 'case set changed');
  const bad = [...manifest.entries()].filter(([k, v]) => expected[k].sha !== v.sha || expected[k].len !== v.len).map(([k]) => k);
  assert.deepEqual(bad, [], `${bad.length} roll baseline case(s) changed (first: ${bad.slice(0, 15).join(', ')})`);
  assert.ok(manifest.size > 2000, `expected the full matrix, got ${manifest.size}`);
});
