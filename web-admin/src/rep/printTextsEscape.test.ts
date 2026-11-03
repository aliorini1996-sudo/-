/**
 * حارس الحقن في «نصوص المطبوعات» و«التخطيط» (طلب المالك ٣ نوفمبر ٢٠٢٦): بعد رفع كل قفل صار كل مفتاحٍ يقبل نصّاً حرّاً من مدير
 * الشركة يُطبع على جهاز كل مندوب — والرول وثيقةٌ نصّية تُكتب بـdocument.write. فكل صياغةٍ ونصٍّ ثانٍ واسمٍ/عنوانٍ بلغةٍ ثانية يجب
 * أن يصل الورقة مُهرَّباً في كل قالب (A4، ثنائي اللغة، الرول المختصر والمفصّل بتخطيطٍ وبلا تخطيط)، ولون التمييز لا يحمل CSS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, type Company, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, lookFor, type PrintLook } from './printLook';
import { printThermalInvoice, printThermalReceipt, type ThermalPrintOptions } from './thermal';
import { defaultPrintLayout, defaultPrintOptions, presetPaper, withDesign, type PrintProfile, type SectionId } from '../lib/print/printSettings';
import { PRINT_TEXT_CATALOG, checkPrintTexts, type PrintTextsV1 } from '../lib/print/printTexts';
import { accentColor, resolveLayout } from '../lib/print/layout';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

const COMPANY: Company = {
  name: 'شركة الاختبار', address: 'حي العليا', taxNumber: '300000000000003', commercialReg: '1010101010', phone: '0501234567',
  email: 'info@example.sa', logo: null, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA', addrCity: 'الرياض', addrPostalCode: '12211',
};
const CUSTOMER = { name: 'عميل', businessName: 'منشأة', commercialReg: '1010202020', taxNumber: '311111111111113', phone: '0112345678', address: 'طريق', city: 'جدة', postalCode: '23456' };
const inv = (isReturn = false): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-1', date: '2026-11-02T09:15:00.000Z', type: 'CREDIT', company: COMPANY, customer: CUSTOMER, repName: 'مندوب',
  deliveryDate: '2026-11-05T00:00:00.000Z',
  items: [{ name: 'صنف', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 5, taxPct: 15, lineTotal: 46, code: 'P-1', taxAmt: 6 }],
  subtotal: 46, discount: 1, tax: 6, total: 46, pricesIncludeTax: true, paidAmt: 10, remainingAmt: 36,
  paymentPlan: 'INSTALLMENT', installments: [{ seq: 1, dueDate: '2026-12-02T00:00:00.000Z', amount: 36 }],
  ...(isReturn ? { isReturn: true, billingReference: 'INV-0', noteReason: 'سبب', paymentPlan: null, installments: undefined } : {}),
});
const rcp = (): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-1', date: '2026-11-02T11:00:00.000Z', company: COMPANY, customer: CUSTOMER, repName: 'مندوب', amount: 300,
  paymentMethod: 'CASH', notes: 'ملاحظة', invoices: [{ number: 'INV-9', amount: 100 }, { number: 'INV-8', amount: 50 }],
});

// حمولاتٌ ضمن حدّ 60 محرفاً — تمرّ من حارس الحفظ في الخادم (نصٌّ حرّ مقبول) فلا يحمي منها إلا التهريب عند الطباعة
const P_TEXT = '<img src=x onerror=alert(1)>';
const P_ALT = '"><svg onload=alert(2)>';
const RAW = ['<img src=x', '<svg onload', 'onerror=alert(1)>', '"><svg'];

const evil = (secondLang: PrintTextsV1['secondLang']): PrintTextsV1 => ({
  version: 1, secondLang, companyNameAlt: `${P_ALT}n`, companyAddressAlt: `${P_TEXT}a`,
  edits: Object.fromEntries(PRINT_TEXT_CATALOG.map((e) => [e.key, { text: P_TEXT, alt: P_ALT, hidden: false }])),
});

const withTexts = <D extends InvoiceDoc | ReceiptDoc>(doc: D, t: PrintTextsV1): D => ({ ...doc, company: { ...doc.company!, printTexts: t } });
const pageProfile = (): PrintProfile => ({
  id: 'p-a4', name: 'A4', printer: 'page', template: 'page_branded', paper: presetPaper('a4')!,
  options: { ...defaultPrintOptions('page'), layout: { ...defaultPrintLayout('page'), accent: '#1D4ED8' } },
});
const rollProfile = (template: 'roll_compact' | 'roll_detailed', layout: boolean, mm: 'roll58' | 'roll80'): PrintProfile => ({
  id: `van-${template}-${mm}`, name: 'سيارة', printer: 'thermal', template, paper: presetPaper(mm)!,
  options: {
    ...defaultPrintOptions('thermal'), showLogo: true, showContact: true, showRepName: true,
    ...(layout ? { layout: { ...defaultPrintLayout('thermal'), logo: 'none' as const, order: ['header', 'customer', 'info', 'items', 'qr', 'totals', 'signatures', 'footer'] as SectionId[] } } : {}),
  },
});

const page = (doc: InvoiceDoc | ReceiptDoc, look: PrintLook): string => renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: look },
  doc.kind === 'invoice' ? createElement(PrintableInvoice, { doc }) : createElement(PrintableReceipt, { doc })) as ReactElement);
async function roll(doc: InvoiceDoc | ReceiptDoc, p: PrintProfile): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile: p, tr: (s: string) => s, capture: (h: string) => { out = h; } };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  assert.ok(out, 'لم تُلتقط وثيقة الرول');
  return out;
}

const leaks = (html: string): string[] => RAW.filter((r) => html.includes(r));

test('حمولات الحقن تمرّ من حارس الحفظ الصارم (نصٌّ حرّ) — فالتهريب عند الطباعة هو الحارس', () => {
  for (const lang of [null, 'en'] as const) assert.ok(checkPrintTexts(evil(lang), true).ok);
});

test('كل صياغةٍ ونصٍّ ثانٍ يصل الورقة مُهرَّباً: A4 وثنائي اللغة والرول المختصر والمفصّل (58/80، بتخطيطٍ وبلا تخطيط)', async () => {
  const looks: Record<string, PrintLook> = { a4: lookFor(pageProfile()), grid: lookFor(withDesign(pageProfile(), 'grid_bilingual')) };
  const rolls: PrintProfile[] = [];
  for (const t of ['roll_compact', 'roll_detailed'] as const) for (const mm of ['roll58', 'roll80'] as const) for (const l of [false, true]) rolls.push(rollProfile(t, l, mm));
  let n = 0;
  for (const lang of [null, 'en'] as const) {
    for (const mk of [() => inv(false), () => inv(true), rcp]) {
      const doc = withTexts(mk(), evil(lang));
      for (const [name, look] of Object.entries(looks)) {
        const h = page(doc, look);
        assert.ok(h.includes('&lt;img src=x'), `${name}/${doc.kind}: الحمولة لم تُطبع أصلاً`);
        assert.deepEqual(leaks(h), [], `${name}/${doc.kind}/${lang}`);
        n++;
      }
      for (const p of rolls) {
        const h = await roll(doc, p);
        assert.ok(h.includes('&lt;img src=x'), `${p.id}/${doc.kind}: الحمولة لم تُطبع أصلاً`);
        assert.deepEqual(leaks(h), [], `${p.id}/${doc.kind}/${lang}`);
        n++;
      }
    }
  }
  assert.equal(n, 2 * 3 * (2 + 8));
});

test('لون التمييز: قيمةٌ ليست #RRGGBB لا تصل الورقة أبداً (لا حقن CSS) — يعود للون الشركة', () => {
  for (const bad of ['red;background:url(javascript:alert(1))', '#fff', '#1D4ED8;x:y', 'expression(alert(1))', '#1D4ED8 ', 123]) {
    const p = { ...pageProfile(), options: { ...pageProfile().options, layout: { ...defaultPrintLayout('page'), accent: bad as unknown as string } } };
    const l = resolveLayout(p);
    assert.equal(l?.accent, null, String(bad));
    assert.equal(accentColor(l, '#123456', false, '#000000'), '#123456');
    // ولو وصل محلولاً مزوَّراً لا يمرّ
    assert.equal(accentColor({ ...l!, accent: bad as unknown as string }, '#123456', false, '#000000'), '#123456');
  }
});
