/**
 * التقاء الميزتين بعد دمج «انعكاس نصوص المطبوعات» (origin/master aba9176) مع «احذف كل شيء حتى QR» (قرار المالك ٤ نوفمبر ٢٠٢٦):
 * كلٌّ منهما مستقلّ عن الآخر على كل قالب — القياسي والنقطية والتحرير الحرّ واللوحة، والثنائي اللغة (وحرّه)، والرول المختصر
 * والمفصّل وحرّه.
 *   (a) الرمز محذوف (sections.qr.visible=false) ونصوصٌ محفوظة: تعليق الرمز (qr.caption بصياغته ونصّه الثاني) وICV/UUID لا تُطبع
 *       أبداً — وكل تعديلٍ آخر (الرقم الضريبي، رقم الفاتورة ونصّهما الثاني، اسم الشركة بلغتها الثانية في الرأس والتذييل) يُطبع
 *       كما يُطبع والرمز ظاهر، عدداً بعدد.
 *   (b) stamps:false وعناوين الحالة: صياغة عنوان سند التسليم تُطبع والإشعار يسقط؛ وحذف العنوان مع الأختام لا يُبقي شيئاً منهما؛
 *       وبالأختام الافتراضية يبقى الإشعار ولو حُذف العنوان والرمز معاً (قاعدة statusTitles)؛ والمُبطل والمعلَّق في المرحلة الثانية
 *       يُرفضان على الرول مهما حُذف وصيغ — والقرار لا يقرأ التخطيط ولا النصوص.
 *   (d) الرول: الرمز المحذوف لا يرفض الورق الضيّق (qrNoFit) ولو مع نصوصٍ محفوظة، وتعديلاتها تُطبع.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, type Company, type InvoiceDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { PrintRefusedError, printThermalInvoice, type ThermalPrintOptions } from './thermal';
import {
  defaultPrintLayout, defaultPrintOptions, presetPaper,
  type LayoutDesign, type PaperPresetId, type PrintLayout, type PrintProfile, type PrinterType, type TemplateId,
} from '../lib/print/printSettings';
import type { PrintCanvas } from '../lib/print/printSettingsCore';
import type { PrintTextEdit, PrintTextsV1 } from '../lib/print/printTexts';
import { zatcaPrintDecision } from '../lib/zatca/docPrint';
import type { ZatcaDocView } from '../lib/zatca/docStatus';
import { useLang } from '../i18n/lang';
import { setActiveCurrency, setActiveNumerals } from '../utils/format';

process.env.TZ = 'Asia/Riyadh';
useLang.setState({ lang: 'ar' });
setActiveNumerals('latin');
setActiveCurrency('SAR');

// ─── المستندات ───

const STAMPED = 'AQ/YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDFDIwMjYtMTEtMDJUMDk6MTU6MDBa';
const UUID = '3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c';
const DELIVERY_NOTICE = 'سلمت البضاعة وبانتظار اعتماد الهيئة وتصلك الفاتورة الضريبية المعتمدة بعد الاعتماد';
const DELIVERY_TITLE = 'سند تسليم — ليست فاتورة ضريبية';
const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا شارع التحلية', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: LOGO, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
  addrCity: 'الرياض', addrPostalCode: '12211',
};
const B2B = { name: 'محمد العتيبي', businessName: 'مؤسسة الأفق', taxNumber: '311111111111113', address: 'طريق الملك فهد', city: 'جدة', postalCode: '23456' };
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: UUID, icv: 41, warnings: 0, ...over,
});
const inv = (zatca: ZatcaDocView, number = 'INV-950'): InvoiceDoc => ({
  kind: 'invoice', number, date: '2026-11-02T09:15:00.000Z', type: 'CASH', company: COMPANY, customer: B2B, repName: 'أحمد السالم',
  items: [{ name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46, code: 'P-100', taxAmt: 6 }],
  subtotal: 40, discount: 0, tax: 6, total: 46, pricesIncludeTax: true, paidAmt: 46, remainingAmt: 0, zatca,
});
const STAMPED_DOCS: Array<[string, () => InvoiceDoc]> = [
  ['p2StandardCleared', () => inv(zv())],
  ['p2SimplifiedReported', () => inv(zv({ subtype: '02', mirror: 'reported', documentStatus: 'REPORTED' }), 'INV-951')],
];
const DELIVERY = (): InvoiceDoc => inv(zv({ mirror: 'clearance_pending', documentStatus: 'SUBMITTING', printable: false, qr: null }), 'INV-952');
const VOID = (): InvoiceDoc => inv(zv({ subtype: '02', mirror: 'rejected', documentStatus: 'REJECTED', printable: false, qr: null }), 'INV-953');
const PENDING = (): InvoiceDoc => inv(zv({ subtype: '02', mirror: 'signed', documentStatus: 'RETRY_WAIT', printable: false, qr: null }), 'INV-954');

// ─── النصوص ───

const CAPTION = 'رمز الشركة للفاتورة';
const CAPTION_ALT = 'Company invoice code';
const TAX = 'الرقم الضريبي للشركة لدينا';
const TAX_ALT = 'Our VAT number';
const NUMBER = 'رقم المستند لدينا';
const NUMBER_ALT = 'Our document number';
const SEL_TAX = 'رقم تسجيل البائع لدينا';
const SEL_TAX_ALT = 'Our seller VAT number';
const NAME_ALT = 'Test Distribution Co';
const FOOT_ALT = 'Test Distribution Company Ltd';
/** كل ما تعدّله النصوص خارج كتلة الرمز — يُطبع والرمز محذوف كما يُطبع وهو ظاهر (الثنائي يطبع رقم البائع الضريبي بمفتاحه sel.*) */
const OTHER_EDITS = [TAX, TAX_ALT, SEL_TAX, SEL_TAX_ALT, NUMBER, NUMBER_ALT, NAME_ALT, FOOT_ALT];
const expectedOn = (t: Target): string[] => OTHER_EDITS.filter((s) => (t.name.startsWith('grid') ? s !== TAX && s !== TAX_ALT : s !== SEL_TAX && s !== SEL_TAX_ALT));
/** كتلة الرمز: الصياغة ونصّها الثاني، والتعليقان الافتراضيان، وICV والمعرّف */
const QR_BLOCK = [CAPTION, CAPTION_ALT, 'رمز الفاتورة المعتمد من هيئة الزكاة والضريبة والجمارك', 'رمز الاستجابة السريعة للفاتورة الضريبية', 'ICV ', UUID];

const BASE_EDITS: Readonly<Record<string, Partial<PrintTextEdit>>> = {
  'qr.caption': { text: CAPTION, alt: CAPTION_ALT },
  'h.taxNumber': { text: TAX, alt: TAX_ALT },
  'sel.taxNumber': { text: SEL_TAX, alt: SEL_TAX_ALT },
  'inv.number': { text: NUMBER, alt: NUMBER_ALT },
  'foot.company': { alt: FOOT_ALT },
};
const textsWith = (edits: Record<string, Partial<PrintTextEdit>> = {}): PrintTextsV1 => ({
  version: 1, secondLang: 'en', companyNameAlt: NAME_ALT, companyAddressAlt: null,
  edits: Object.fromEntries(Object.entries({ ...BASE_EDITS, ...edits }).map(([k, e]): [string, PrintTextEdit] => [k, { text: null, alt: null, hidden: false, ...e }])),
});
const withTexts = (doc: InvoiceDoc, t: PrintTextsV1 | null): InvoiceDoc => ({ ...doc, company: { ...doc.company!, printTexts: t } });

// ─── القوالب ───

const profileOf = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard'): PrintProfile => ({
  id: `p-${template.replace(/_/g, '-')}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), showLogo: true, layout: defaultPrintLayout(printer, design) },
});
/** يدمج الأقسام فوق أقسام القالب (فلا يمحو QR_OFF تنسيق القالب الحرّ) */
const withFree = (p: PrintProfile, free: Partial<PrintLayout>): PrintProfile => {
  const l = p.options.layout!;
  const sections = free.sections ? { ...(l.sections ?? {}), ...free.sections } : l.sections;
  return { ...p, options: { ...p.options, layout: { ...l, ...free, ...(sections ? { sections } : {}) } } };
};
const CANVAS: PrintCanvas = {
  headerMm: 75, footerMm: 85,
  boxes: [
    { id: 'logo', band: 'header', x: 0, y: 0, w: 40, h: 25 },
    { id: 'company', band: 'header', x: 45, y: 0, w: 90, h: 35 },
    { id: 'title', band: 'header', x: 140, y: 0, w: 48, h: 20, align: 'end' },
    { id: 'docInfo', band: 'header', x: 0, y: 38, w: 90, h: 35 },
    { id: 'customer', band: 'header', x: 95, y: 38, w: 93, h: 35 },
    { id: 'totals', band: 'footer', x: 0, y: 0, w: 115, h: 55 },
    { id: 'qr', band: 'footer', x: 125, y: 0, w: 63, h: 82 },
    { id: 'signatures', band: 'footer', x: 0, y: 58, w: 60, h: 25 },
    { id: 'footer', band: 'footer', x: 62, y: 58, w: 60, h: 25 },
  ],
};
const ROLL_FREE: Partial<PrintLayout> = {
  logo: 'end', logoMm: 20, logoAfter: 'customer', tableStyle: 'grid',
  sections: { header: { align: 'start', fontPct: 130 }, totals: { align: 'end', spaceBeforeMm: 3 }, footer: { fontPct: 70 } },
};
interface Target { name: string; kind: 'sheet' | 'roll'; profile: PrintProfile }
const TARGETS: Target[] = [
  { name: 'A4-branded', kind: 'sheet', profile: profileOf('page', 'page_branded', 'a4') },
  { name: 'A4-free', kind: 'sheet', profile: withFree(profileOf('page', 'page_branded', 'a4'), { logoAfter: 'top', logoMm: 30, sections: { header: { align: 'center', fontPct: 120 } } }) },
  { name: 'A4-canvas', kind: 'sheet', profile: withFree(profileOf('page', 'page_branded', 'a4'), { canvas: CANVAS }) },
  { name: 'impact', kind: 'sheet', profile: profileOf('impact', 'impact_plain', 'ff_a4') },
  { name: 'impact-canvas', kind: 'sheet', profile: withFree(profileOf('impact', 'impact_plain', 'ff_a4'), { canvas: CANVAS, logoMm: 20 }) },
  { name: 'grid', kind: 'sheet', profile: profileOf('page', 'page_branded', 'a4', 'grid_bilingual') },
  { name: 'grid-impact', kind: 'sheet', profile: profileOf('impact', 'impact_plain', 'ff_a4', 'grid_bilingual') },
  { name: 'grid-free', kind: 'sheet', profile: withFree(profileOf('page', 'page_branded', 'a4', 'grid_bilingual'), { logoAfter: 'items', logoMm: 25, sections: { header: { align: 'end', fontPct: 120 } } }) },
  { name: 'roll58-compact', kind: 'roll', profile: profileOf('thermal', 'roll_compact', 'roll58') },
  { name: 'roll80-detailed', kind: 'roll', profile: profileOf('thermal', 'roll_detailed', 'roll80') },
  { name: 'roll80-detailed-free', kind: 'roll', profile: withFree(profileOf('thermal', 'roll_detailed', 'roll80'), ROLL_FREE) },
];
const QR_OFF: Partial<PrintLayout> = { sections: { qr: { visible: false } } };

// ─── التصيير ───

const norm = (h: string): string => h.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, 'data:IMG');
async function render(t: { kind: Target['kind']; profile: PrintProfile }, doc: InvoiceDoc, raster = false): Promise<string> {
  if (t.kind === 'sheet') {
    return norm(renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: lookFor(t.profile) }, createElement(PrintableInvoice, { doc })) as ReactElement));
  }
  let out = '';
  const opts: ThermalPrintOptions = { profile: t.profile, tr: (s: string) => s };
  if (raster) opts.raster = async (h: string) => { out = h; }; else opts.capture = (h: string) => { out = h; };
  await printThermalInvoice(doc, opts);
  assert.ok(out, 'لم تُلتقط وثيقة الرول');
  return norm(out);
}
const count = (h: string, s: string): number => h.split(s).length - 1;
const esc = (s: string): string => s.replace(/&/g, '&amp;');
/** آثار الرمز نفسه: الصورة (الصفحة/الثنائي) أو صندوق الرول، والخانة، وقسمه */
const qrImages = (h: string): number => count(h, 'alt="QR"') + count(h, 'class="qrbox"') + count(h, 'data-qr-value=') + count(h, 'data-section="qr"')
  + count(h, 'data-sec="qr"') + count(h, 'data-grid-qr=');

// ─── (a) الرمز محذوف والنصوص محفوظة ───

for (const t of TARGETS) {
  test(`(a) ${t.name}: الرمز المحذوف يُسقط تعليقه المصاغ وICV/UUID — وكل تعديلٍ آخر في النصوص يُطبع كما هو`, async () => {
    for (const [name, mk] of STAMPED_DOCS) {
      const at = `${t.name}/${name}`;
      const doc = withTexts(mk(), textsWith());
      const shown = await render(t, doc);
      const removed = await render({ kind: t.kind, profile: withFree(t.profile, QR_OFF) }, doc);
      // الضابط: الرمز ظاهرٌ بلا حذف، ومعه ICV — وصياغة التعليق ونصّه الثاني على الورقة (الرول لا يطبع تعليقاً اليوم)
      assert.ok(qrImages(shown) > 0, `${at}: الرمز غائب بلا حذف — الاختبار لا يقيس شيئاً`);
      assert.ok(shown.includes('ICV '), `${at}: ICV غائب بلا حذف`);
      if (t.kind === 'sheet') assert.ok(shown.includes(CAPTION) && shown.includes(CAPTION_ALT), `${at}: صياغة تعليق الرمز غائبة بلا حذف`);
      // الحذف: لا رمز ولا شيء من كتلته
      assert.equal(qrImages(removed), 0, `${at}: الرمز باقٍ بعد حذفه`);
      const left = QR_BLOCK.filter((s) => removed.includes(s));
      assert.deepEqual(left, [], `${at}: من كتلة الرمز ما بقي بعد حذفه`);
      // وكل تعديلٍ آخر كما هو، عدداً بعدد
      for (const s of OTHER_EDITS) {
        const n = count(shown, esc(s));
        if (expectedOn(t).includes(s)) assert.ok(n > 0, `${at}: «${s}» غائبٌ والرمز ظاهر — الاختبار لا يقيسه`);
        assert.equal(count(removed, esc(s)), n, `${at}: «${s}» تغيّر بحذف الرمز (${n} ⇒ ${count(removed, esc(s))})`);
      }
      assert.ok(count(removed, NUMBER) > 0, `${at}: صياغة رقم الفاتورة لم تُطبع والرمز محذوف`);
      assert.ok(count(removed, FOOT_ALT) > 0, `${at}: اسم الشركة بلغتها الثانية في التذييل لم يُطبع والرمز محذوف`);
      assert.ok(removed.includes('46.00'), `${at}: الإجمالي سقط مع الرمز`);
    }
  });
}

test('(a) حذف تعليق الرمز من النصوص والرمز ظاهر: يسقط التعليق وحده — والرمز وICV باقيان؛ وحذف الرمز يُسقط الثلاثة', async () => {
  for (const t of TARGETS.filter((x) => x.kind === 'sheet')) {
    const doc = withTexts(STAMPED_DOCS[0][1](), textsWith({ 'qr.caption': { text: CAPTION, alt: CAPTION_ALT, hidden: true } }));
    const out = await render(t, doc);
    assert.ok(!out.includes(CAPTION) && !out.includes(CAPTION_ALT), `${t.name}: التعليق المحذوف باقٍ`);
    assert.ok(qrImages(out) > 0 && out.includes('ICV '), `${t.name}: حذف التعليق أسقط الرمز أو ICV`);
    const both = await render({ kind: t.kind, profile: withFree(t.profile, QR_OFF) }, doc);
    assert.ok(qrImages(both) === 0 && !both.includes('ICV ') && !both.includes(UUID), `${t.name}: الرمز أو ICV باقٍ بعد حذف الرمز`);
  }
});

// ─── (b) أختام الحالة وعناوين الحالة ───

const REWORD = 'سند تسليم بصياغة الشركة';
const REWORD_ALT = 'Company worded delivery note';
for (const t of TARGETS) {
  test(`(b) ${t.name}: عنوان سند التسليم وأختام الحالة مستقلّان — صياغةً وحذفاً، والرمز محذوف أو ظاهر`, async () => {
    const d = zatcaPrintDecision({ isReturn: false, buyerHasTaxNumber: true, saudi: true }, DELIVERY().zatca);
    assert.equal(d.title, DELIVERY_TITLE);
    assert.equal(d.notice, DELIVERY_NOTICE);
    for (const qrOff of [false, true]) {
      const at = `${t.name}/${qrOff ? 'qrOff' : 'qrOn'}`;
      const prof = (stamps: boolean): PrintProfile => withFree(t.profile, { ...(qrOff ? QR_OFF : {}), ...(stamps ? {} : { stamps: false }) });
      const r = (stamps: boolean, edits: Record<string, Partial<PrintTextEdit>>): Promise<string> => render({ kind: t.kind, profile: prof(stamps) }, withTexts(DELIVERY(), textsWith(edits)));

      const plain = await r(true, {});
      const notice = count(plain, DELIVERY_NOTICE);
      assert.ok(notice > 0 && plain.includes(esc(DELIVERY_TITLE)), `${at}: سند التسليم بلا عنوانه أو إشعاره`);
      // الأختام الافتراضية: حذف العنوان لا يُسقط الإشعار (قاعدة statusTitles) — ولو حُذف الرمز
      const titleGone = await r(true, { 'inv.deliveryNoteTitle': { text: REWORD, alt: REWORD_ALT, hidden: true } });
      assert.equal(count(titleGone, DELIVERY_NOTICE), notice, `${at}: حذف العنوان أسقط الإشعار`);
      assert.ok(!titleGone.includes(REWORD) && !titleGone.includes(REWORD_ALT), `${at}: الحذف أبقى الصياغة`);
      // stamps:false بلا تعديل العنوان: العنوان باقٍ والإشعار يسقط
      const noStamps = await r(false, {});
      assert.equal(count(noStamps, DELIVERY_NOTICE), 0, `${at}: الإشعار باقٍ مع stamps:false`);
      assert.ok(noStamps.includes(esc(DELIVERY_TITLE)), `${at}: stamps:false أسقط العنوان`);
      // stamps:false والعنوان مصاغ: الصياغة ونصّها الثاني مكانه، ولا إشعار
      const reworded = await r(false, { 'inv.deliveryNoteTitle': { text: REWORD, alt: REWORD_ALT } });
      assert.ok(reworded.includes(REWORD) && reworded.includes(REWORD_ALT), `${at}: صياغة العنوان لم تُطبع مع stamps:false`);
      assert.equal(count(reworded, DELIVERY_NOTICE), 0, `${at}: الإشعار عاد مع الصياغة`);
      // stamps:false والعنوان محذوف: لا عنوان ولا صياغة ولا إشعار — وتعديلات النصوص الأخرى باقية
      const bare = await r(false, { 'inv.deliveryNoteTitle': { text: REWORD, alt: REWORD_ALT, hidden: true } });
      for (const s of [DELIVERY_NOTICE, REWORD, REWORD_ALT]) assert.ok(!bare.includes(s), `${at}: «${s}» باقٍ بعد حذف العنوان والأختام`);
      assert.ok(count(bare, NUMBER) > 0 && count(bare, FOOT_ALT) > 0, `${at}: سقطت تعديلات النصوص الأخرى`);
      // والرمز المحذوف لا يترك من كتلته شيئاً على سند التسليم (سبب غيابه وتلميحه)، والإشعار من الأختام لا من كتلة الرمز
      if (qrOff) {
        assert.equal(qrImages(plain), 0, `${at}: رمزٌ على سند التسليم بعد حذفه`);
        for (const s of ['لا يحمل هذا المستند رمز فاتورة ضريبية', 'قيد الاعتماد لدى منظومة الفوترة الإلكترونية']) assert.ok(!plain.includes(s), `${at}: «${s}» باقٍ بعد حذف الرمز`);
      }
    }
  });
}

test('(b) المُبطل والمعلَّق في المرحلة الثانية: القرار لا يقرأ التخطيط ولا النصوص — والرول يرفضهما مهما حُذف وصيغ', async () => {
  assert.equal(zatcaPrintDecision.length, 2, 'قرار الطباعة صار يأخذ التخطيط أو النصوص');
  const edits = {
    'inv.voidTitle': { text: 'فاتورة ضريبية', alt: 'Tax invoice' },
    'inv.pendingTitle': { text: 'فاتورة ضريبية', alt: 'Tax invoice' },
  };
  const everything: Partial<PrintLayout> = { sections: { qr: { visible: false }, header: { visible: false }, info: { visible: false } }, stamps: false };
  for (const mk of [VOID, PENDING]) {
    const doc = mk();
    assert.equal(zatcaPrintDecision({ isReturn: false, buyerHasTaxNumber: true, saudi: true }, doc.zatca).canPrint, false);
    for (const t of TARGETS.filter((x) => x.kind === 'roll')) {
      for (const free of [{ stamps: false }, QR_OFF, everything] as Array<Partial<PrintLayout>>) {
        for (const texts of [null, textsWith(edits), textsWith(Object.fromEntries(Object.keys(edits).map((k) => [k, { hidden: true }])))]) {
          for (const raster of [false, true]) {
            await assert.rejects(render({ kind: 'roll', profile: withFree(t.profile, free) }, withTexts(doc, texts), raster),
              (e: unknown) => e instanceof PrintRefusedError, `${t.name}/${doc.number}/${JSON.stringify(free)}: طُبع مستندٌ لا ورقة له`);
          }
        }
      }
    }
  }
});

// ─── (d) الرول الضيّق ───

test('(d) الرول 58 مم الضيّق: الرمز المختوم يُرفض اليوم (qrNoFit) — والمحذوف لا يُرفض ولو مع نصوصٍ محفوظة، وتعديلاتها تُطبع', async () => {
  const narrow = (free: Partial<PrintLayout>): PrintProfile => {
    const p = withFree(profileOf('thermal', 'roll_compact', 'roll58'), free);
    return { ...p, paper: { ...p.paper, printableDots: 256 } };
  };
  // رمزٌ مختوم بحجمه الحقيقي (~٧٠٠ محرف) — القيمة القصيرة تتسع في أيّ عرض
  const BIG = Buffer.alloc(520, 7).toString('base64');
  for (const [name, mk] of STAMPED_DOCS) {
    const base = mk();
    const doc = withTexts({ ...base, zatca: { ...base.zatca!, qr: BIG } }, textsWith());
    for (const raster of [false, true]) {
      const at = `${name}/${raster ? 'bt' : 'system'}`;
      await assert.rejects(render({ kind: 'roll', profile: narrow({}) }, doc, raster), (e: unknown) => e instanceof PrintRefusedError, `${at}: اليوم لم يُرفض — الاختبار لا يقيس الضيق`);
      for (const free of [QR_OFF, { ...QR_OFF, stamps: false }] as Array<Partial<PrintLayout>>) {
        const out = await render({ kind: 'roll', profile: narrow(free) }, doc, raster);
        assert.ok(!out.includes(BIG) && qrImages(out) === 0, `${at}: رمزٌ في الشريط بعد حذفه`);
        assert.deepEqual(QR_BLOCK.filter((s) => out.includes(s)), [], `${at}: من كتلة الرمز ما بقي`);
        for (const s of [NUMBER, NUMBER_ALT, NAME_ALT, FOOT_ALT]) assert.ok(out.includes(esc(s)), `${at}: «${s}» لم يُطبع`);
      }
    }
  }
});
