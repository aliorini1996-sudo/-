/**
 * «اجعل يمكن حذف كل شي حتى كيو ار» (قرار المالك ٤ نوفمبر ٢٠٢٦) — مصفوفة قبولٍ مستقلّة عن المنفّذين لنموذج الخيار الصريح:
 *
 * القوالب: الصفحة القياسية، والصفحة بلوحةٍ فيها مربع QR، والنقطية القياسية، والثنائي على الصفحة والنقطية، والرول الجديد 80 و58،
 * والرول الكلاسيكي. المستندات: المرحلة الأولى (مبسّطة وقياسية)، والمرحلة الثانية المبسّطة المختومة، والقياسية المعتمدة، والبروفة،
 * وسند التسليم، والإشعار الدائن والمدين، ومرتجع المرحلة الأولى، والسند الملغى. ولكل خانة:
 *   (a) بلا حذف ⇒ المخرج نفسه، والرمز حيث هو اليوم؛
 *   (b) الرمز محذوف (sections.qr.visible=false) ⇒ لا صورة ولا خانة data-qr-value ولا قسم qr ولا ICV/UUID/تعليق — والرول لا يرفض
 *       qrNoFit ولو على 58 مم ضيّق؛
 *   (c) القسم الحامل وحده مخفيّ ⇒ الرمز يُطبع (اليتيم كاليوم)؛
 *   (d) الأصناف محذوفة ⇒ لا جدول أصناف والإجماليات باقية؛
 *   (e) stamps:false ⇒ لا وسم بروفة ولا إشعار تسليم/إبطال ولا «سند ملغى» ولو أُخفي الحامل — وبلاه يُعاد طبعها مع الحامل المخفيّ؛
 *   (f) المُبطل والمعلَّق في المرحلة الثانية يُرفضان مهما حُذف؛
 *   (g) الكلاسيكي لا يتغيّر.
 * وبرهان فشل: المصفوفة تلتقط رمزاً يتسرّب بعد حذفه.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintableInvoice, PrintableReceipt, type Company, type InvoiceDoc, type ReceiptDoc } from './RepDocuments';
import { PrintLookContext, lookFor } from './printLook';
import { PrintRefusedError, printThermalInvoice, printThermalReceipt, type ThermalPrintOptions } from './thermal';
import {
  defaultPrintLayout, defaultPrintOptions, legacyThermalProfile, presetPaper,
  type LayoutDesign, type PaperPresetId, type PrintLayout, type PrintProfile, type PrinterType, type SectionId, type TemplateId,
} from '../lib/print/printSettings';
import { areStampsRemoved, checkPrintSettings, isItemsRemoved, isQrRemoved, type PrintCanvas } from '../lib/print/printSettingsCore';
import { REHEARSAL_WATERMARK, zatcaPrintDecision } from '../lib/zatca/docPrint';
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
const VOID_NOTICE = 'أبطل هذا المستند فلا يعتمد لخصم ضريبة المدخلات';
const PENDING_NOTICE = 'لم تحسم الهيئة هذا المستند بعد فلا يسلم منه مستند ضريبي';
const CANCELLED = 'سند ملغى';
/** كل ما تحمله كتلة الرمز من نصوص: ICV والمعرّف والتعليقان وصندوق السبب والتلميحان */
const QR_TEXTS = [
  'ICV ', UUID, 'رمز الفاتورة المعتمد من هيئة الزكاة والضريبة والجمارك', 'رمز الاستجابة السريعة للفاتورة الضريبية',
  'لا يحمل هذا المستند رمز فاتورة ضريبية', 'قيد الاعتماد لدى منظومة الفوترة الإلكترونية', 'أضف الرقم الضريبي للشركة',
];
const STAMP_TEXTS = [REHEARSAL_WATERMARK, DELIVERY_NOTICE, VOID_NOTICE, PENDING_NOTICE, CANCELLED];
const ITEM_NAMES = ['مياه معدنية', 'عصير برتقال'];

const LOGO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const COMPANY: Company = {
  name: 'شركة الاختبار للتوزيع', address: 'حي العليا شارع التحلية', taxNumber: '300000000000003', commercialReg: '1010101010',
  phone: '0501234567', email: 'info@example.sa', logo: LOGO, primaryColor: '#1e3a8a', headerStyle: null, countryCode: 'SA',
};
const zv = (over: Partial<ZatcaDocView> = {}): ZatcaDocView => ({
  phase: 2, mode: 'live', mirror: 'cleared', documentStatus: 'CLEARED', subtype: '01', documentKind: 'INVOICE', qr: STAMPED, printable: true,
  overdue: false, reportDeadline: null, issuedAt: '2026-11-02T09:15:00.000Z', uuid: UUID, icv: 41, warnings: 0, ...over,
});
const ITEMS: InvoiceDoc['items'] = [
  { name: 'مياه معدنية', unit: 'كرتون', qty: 2, unitPrice: 23, discountPct: 0, taxPct: 15, lineTotal: 46 },
  { name: 'عصير برتقال', unit: 'حبة', qty: 3, unitPrice: 2.5, discountPct: 10, taxPct: 15, lineTotal: 6.75 },
];
const TOTAL = '52.75';
const BUYER_STD = { name: 'محمد العتيبي', businessName: 'مؤسسة الأفق', taxNumber: '311111111111113', phone: '0112345678', address: 'طريق الملك فهد' };
const BUYER_SIMPLE = { name: 'بقالة الحي', phone: '0533333333' };
const inv = (o: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  kind: 'invoice', number: 'INV-777', date: '2026-11-02T09:15:00.000Z', type: 'CREDIT', company: COMPANY, customer: BUYER_STD,
  repName: 'أحمد السالم', items: ITEMS, subtotal: 48.5, discount: 2.5, tax: 6.88, total: 52.75, pricesIncludeTax: true,
  paidAmt: 21.5, remainingAmt: 31.25, ...o,
});
const note = (kind: 'CREDIT_NOTE' | 'DEBIT_NOTE'): InvoiceDoc => inv({
  number: kind === 'CREDIT_NOTE' ? 'RET-55' : 'DN-56', isReturn: kind === 'CREDIT_NOTE', paidAmt: undefined, remainingAmt: undefined,
  billingReference: 'INV-500', noteReason: 'بضاعة تالفة', zatca: zv({ documentKind: kind } as Partial<ZatcaDocView>),
});
const rcpCancelled = (): ReceiptDoc => ({
  kind: 'receipt', number: 'RC-55', date: '2026-11-02T11:00:00.000Z', company: COMPANY, customer: { name: 'بقالة النور' },
  repName: 'أحمد السالم', amount: 150, paymentMethod: 'CASH', invoices: [{ number: 'INV-777', amount: 150 }], cancelled: true,
});
type Doc = InvoiceDoc | ReceiptDoc;
interface DocCase { name: string; mk: () => Doc; qr: boolean; stamp: string | null }
/** qr: يحمل رمزاً اليوم · stamp: الختم الذي يطبعه اليوم */
const DOCS: DocCase[] = [
  { name: 'p1Simplified', mk: () => inv({ type: 'CASH', customer: BUYER_SIMPLE, paidAmt: 52.75, remainingAmt: 0 }), qr: true, stamp: null },
  { name: 'p1Standard', mk: () => inv(), qr: true, stamp: null },
  { name: 'p2SimplifiedStamped', mk: () => inv({ customer: BUYER_SIMPLE, zatca: zv({ subtype: '02', mirror: 'reported' }) }), qr: true, stamp: null },
  { name: 'p2StandardCleared', mk: () => inv({ zatca: zv() }), qr: true, stamp: null },
  { name: 'p2Rehearsal', mk: () => inv({ customer: BUYER_SIMPLE, zatca: zv({ mode: 'rehearsal', mirror: 'reported', subtype: '02' }) }), qr: true, stamp: REHEARSAL_WATERMARK },
  { name: 'deliveryNote', mk: () => inv({ zatca: zv({ mirror: 'clearance_pending', printable: false, qr: null }) }), qr: false, stamp: DELIVERY_NOTICE },
  { name: 'p2CreditNote', mk: () => note('CREDIT_NOTE'), qr: true, stamp: null },
  { name: 'p2DebitNote', mk: () => note('DEBIT_NOTE'), qr: true, stamp: null },
  { name: 'p1Return', mk: () => inv({ number: 'RET-9', isReturn: true, paidAmt: undefined, remainingAmt: undefined }), qr: true, stamp: null },
  { name: 'rcpCancelled', mk: rcpCancelled, qr: false, stamp: CANCELLED },
];
/** المُبطل والمعلَّق (المرحلة الثانية): لا ورقة — يُعرضان في الصفحة بإشعارهما ويُرفضان في كل طباعة */
const VOID = (): InvoiceDoc => inv({ zatca: zv({ mirror: 'rejected', printable: false, qr: null }) });
const PENDING = (): InvoiceDoc => inv({ number: 'CN-9', isReturn: true, zatca: zv({ documentKind: 'CREDIT_NOTE', mirror: 'clearance_pending', printable: false, qr: null } as Partial<ZatcaDocView>) });

// ─── القوالب ───

type Kind = 'a4' | 'grid' | 'roll' | 'classic';
interface Target { name: string; kind: Kind; printer: PrinterType; base: () => PrintProfile; canvas?: boolean }
const plain = (printer: PrinterType, template: TemplateId, preset: PaperPresetId, design: LayoutDesign = 'standard', extra: Partial<PrintLayout> = {}): PrintProfile => ({
  id: `p-${template.replace(/_/g, '-')}`, name: template, printer, template, paper: presetPaper(preset)!,
  options: { ...defaultPrintOptions(printer), showLogo: true, layout: { ...defaultPrintLayout(printer, design), ...extra } },
});
const CANVAS: PrintCanvas = {
  headerMm: 70, footerMm: 80, boxes: [
    { id: 'logo', band: 'header', x: 0, y: 0, w: 40, h: 25 },
    { id: 'company', band: 'header', x: 45, y: 0, w: 90, h: 30 },
    { id: 'title', band: 'header', x: 140, y: 0, w: 48, h: 20 },
    { id: 'docInfo', band: 'header', x: 0, y: 35, w: 90, h: 30 },
    { id: 'totals', band: 'footer', x: 0, y: 0, w: 100, h: 50 },
    { id: 'qr', band: 'footer', x: 120, y: 0, w: 50, h: 50 },
    { id: 'signatures', band: 'footer', x: 0, y: 55, w: 120, h: 20 },
    { id: 'footer', band: 'footer', x: 125, y: 55, w: 63, h: 20 },
  ],
};
const TARGETS: Target[] = [
  { name: 'page_standard', kind: 'a4', printer: 'page', base: () => plain('page', 'page_branded', 'a4') },
  { name: 'page_canvasQr', kind: 'a4', printer: 'page', canvas: true, base: () => plain('page', 'page_branded', 'a4', 'standard', { canvas: CANVAS }) },
  { name: 'impact_standard', kind: 'a4', printer: 'impact', base: () => plain('impact', 'impact_plain', 'ff_a4') },
  { name: 'page_grid', kind: 'grid', printer: 'page', base: () => plain('page', 'page_branded', 'a4', 'grid_bilingual') },
  { name: 'impact_grid', kind: 'grid', printer: 'impact', base: () => plain('impact', 'impact_plain', 'ff_a4', 'grid_bilingual') },
  { name: 'roll_detailed80', kind: 'roll', printer: 'thermal', base: () => plain('thermal', 'roll_detailed', 'roll80') },
  { name: 'roll_compact58', kind: 'roll', printer: 'thermal', base: () => plain('thermal', 'roll_compact', 'roll58') },
  { name: 'classic', kind: 'classic', printer: 'thermal', base: legacyThermalProfile },
];
const withFree = (p: PrintProfile, free: Partial<PrintLayout>): PrintProfile => {
  const l = p.options.layout ?? defaultPrintLayout(p.printer);
  const sections = free.sections ? { ...(l.sections ?? {}), ...free.sections } : l.sections;
  return { ...p, options: { ...p.options, layout: { ...l, ...free, ...(sections ? { sections } : {}) } } };
};
const HOST: Record<Kind, SectionId> = { a4: 'totals', grid: 'info', roll: 'totals', classic: 'totals' };
/** حامل الأختام: الترويسة للفاتورة، و«البيانات» لسند الصفحة والثنائي، والترويسة لسند الرول */
const stampHosts = (t: Target, d: DocCase): SectionId[] => (d.name === 'rcpCancelled' && t.kind !== 'roll' ? ['info'] : ['header', 'info']);

const QR_OFF: Partial<PrintLayout> = { sections: { qr: { visible: false } } };
const ITEMS_OFF: Partial<PrintLayout> = { sections: { items: { visible: false } } };

// ─── التصيير ───

const norm = (h: string): string => h.replace(/data:image\/png;base64,[A-Za-z0-9+/=]{60,}/g, 'data:QR');
const sheet = (p: PrintProfile, doc: Doc): string => norm(renderToStaticMarkup(createElement(PrintLookContext.Provider, { value: lookFor(p) },
  doc.kind === 'invoice' ? createElement(PrintableInvoice, { doc }) : createElement(PrintableReceipt, { doc })) as ReactElement));
async function roll(p: PrintProfile, doc: Doc, raster: boolean): Promise<string> {
  let out = '';
  const opts: ThermalPrintOptions = { profile: p, tr: (s: string) => s };
  if (raster) opts.raster = async (h: string) => { out = h; }; else opts.capture = (h: string) => { out = h; };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, opts); else await printThermalReceipt(doc, opts);
  assert.ok(out, 'لم تُلتقط وثيقة الرول');
  return norm(out);
}
interface Mode { name: string; run: (p: PrintProfile, doc: Doc) => Promise<string> }
const modesOf = (t: Target): Mode[] => (t.kind === 'roll'
  ? [{ name: 'system', run: (p, d) => roll(p, d, false) }, { name: 'bt', run: (p, d) => roll(p, d, true) }]
  : t.kind === 'classic' ? [{ name: 'classic', run: (p, d) => roll(p, d, false) }]
  : [{ name: 'sheet', run: async (p, d) => sheet(p, d) }]);

/** آثار الرمز في الورقة: الصور والخانات والأقسام ونصوص كتلته */
export interface QrMarks { images: number; slots: number; sections: number; texts: string[] }
function qrMarks(h: string): QrMarks {
  const n = (re: RegExp): number => (h.match(re) ?? []).length;
  return {
    images: n(/alt="QR"/g) + n(/<div class="qr">/g) + n(/class="qrbox"/g),
    slots: n(/data-qr-value=/g),
    sections: n(/data-section="qr"/g) + n(/data-sec="qr"/g) + n(/data-grid-qr=/g),
    texts: QR_TEXTS.filter((s) => h.includes(s)),
  };
}
const hasQr = (m: QrMarks): boolean => m.images + m.slots > 0;
const count = (h: string, s: string): number => h.split(s).length - 1;
const itemsShown = (h: string): boolean => ITEM_NAMES.some((s) => h.includes(s)) || /data-sec(?:tion)?="items"/.test(h);

// ─── الخانة ───

async function cellErrors(t: Target, mutate: (h: string) => string = (h) => h): Promise<string[]> {
  const errors: string[] = [];
  for (const mode of modesOf(t)) {
    for (const d of DOCS) {
      const tag = `${t.name}/${mode.name}/${d.name}`;
      const run = async (p: PrintProfile): Promise<string> => mutate(await mode.run(p, d.mk()));
      const today = await mode.run(t.base(), d.mk());
      const tq = qrMarks(today);

      // (a) بلا حذف: المخرج نفسه، والرمز حيث هو اليوم
      if (hasQr(tq) !== d.qr) errors.push(`${tag}/a: الرمز اليوم ${hasQr(tq)} والمتوقّع ${d.qr}`);
      if (d.stamp && count(today, d.stamp) < 1) errors.push(`${tag}/a: اليوم بلا ختمه`);
      if (t.kind !== 'classic') {
        if (await run(withFree(t.base(), { stamps: true })) !== today) errors.push(`${tag}/a: stamps:true غيّر المخرج`);
        const viaRead = checkPrintSettings(JSON.parse(JSON.stringify({
          version: 1, profiles: [t.base(), plain('page', 'page_plain', 'a4')].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i),
          routing: { invoice: t.base().id, receipt: t.base().id, statement: null, notices: null }, pdfProfileId: t.printer === 'page' ? t.base().id : 'p-page-plain', repMayChoose: true,
        })), false);
        if (!viaRead.ok) errors.push(`${tag}/a: القراءة رفضت القالب`);
        else if (await run(viaRead.value.profiles.find((x) => x.id === t.base().id)!) !== today) errors.push(`${tag}/a: القراءة المتسامحة غيّرت المخرج`);
        const emptyA = await run(withFree(t.base(), { sections: {} }));
        const emptyB = await run(withFree(t.base(), { sections: { qr: {} } }));
        if (emptyA !== emptyB) errors.push(`${tag}/a: sections.qr={} ليس كغيابه`);
        if (hasQr(qrMarks(emptyB)) !== d.qr) errors.push(`${tag}/a: sections.qr={} أسقط الرمز`);
      }

      if (t.kind === 'classic') {
        // (g) الكلاسيكي لا يتغيّر بأيّ حذفٍ وصل إليه (لا يحمل تخطيطاً أصلاً)
        for (const [name, free] of [['qr', QR_OFF], ['items', ITEMS_OFF], ['stamps', { stamps: false }], ['all', { sections: { qr: { visible: false }, items: { visible: false }, header: { visible: false } }, stamps: false }]] as const) {
          if (await run(withFree(t.base(), free as Partial<PrintLayout>)) !== today) errors.push(`${tag}/g/${name}: الكلاسيكي تغيّر`);
        }
        continue;
      }

      // (b) الرمز محذوف: لا صورة ولا خانة ولا قسم ولا نصوص كتلته
      const removed = await run(withFree(t.base(), QR_OFF));
      const rq = qrMarks(removed);
      if (hasQr(rq) || rq.sections) errors.push(`${tag}/b: الرمز باقٍ بعد حذفه (صور ${rq.images}، خانات ${rq.slots}، أقسام ${rq.sections})`);
      if (rq.texts.length) errors.push(`${tag}/b: نصوص كتلة الرمز باقية ${JSON.stringify(rq.texts)}`);
      if (d.mk().kind === 'invoice' && !removed.includes(TOTAL)) errors.push(`${tag}/b: سقط الإجمالي مع الرمز`);
      if (d.stamp && count(removed, d.stamp) < 1) errors.push(`${tag}/b: سقط الختم مع الرمز`);
      // والرمز المحذوف مع الحامل المخفيّ: لا يتيم
      const removedHost = qrMarks(await run(withFree(t.base(), { sections: { qr: { visible: false }, [HOST[t.kind]]: { visible: false } } })));
      if (hasQr(removedHost) || removedHost.sections) errors.push(`${tag}/b: رمزٌ يتيم بعد حذفه والحامل مخفيّ`);

      // (c) الحامل وحده مخفيّ: الرمز يُطبع كاليوم
      const hostOnly = qrMarks(await run(withFree(t.base(), { sections: { [HOST[t.kind]]: { visible: false } } })));
      if (hasQr(hostOnly) !== hasQr(tq)) errors.push(`${tag}/c: الحامل مخفيّ والرمز ${hasQr(hostOnly)} واليوم ${hasQr(tq)}`);
      if (hasQr(tq) && hostOnly.slots !== tq.slots) errors.push(`${tag}/c: خانات الرمز ${hostOnly.slots} واليوم ${tq.slots}`);

      // (d) الأصناف محذوفة: لا جدول والإجماليات باقية
      if (d.mk().kind === 'invoice') {
        if (!itemsShown(today)) errors.push(`${tag}/d: اليوم بلا أصناف`);
        const noItems = await run(withFree(t.base(), ITEMS_OFF));
        if (itemsShown(noItems)) errors.push(`${tag}/d: جدول الأصناف باقٍ بعد حذفه`);
        if (!noItems.includes(TOTAL)) errors.push(`${tag}/d: سقط الإجمالي مع الأصناف`);
        if (hasQr(qrMarks(noItems)) !== hasQr(tq)) errors.push(`${tag}/d: الرمز تغيّر بحذف الأصناف`);
      }

      // (e) الأختام: stamps:false يُسقطها ولو أُخفي حاملها؛ وبلاه يُعاد طبعها مع الحامل المخفيّ
      if (d.stamp) {
        const fixtures: Array<[string, Partial<PrintLayout>]> = [['inPlace', {}], ...stampHosts(t, d).map((id): [string, Partial<PrintLayout>] => [`${id}Hidden`, { sections: { [id]: { visible: false } } }])];
        for (const [fname, free] of fixtures) {
          const kept = await run(withFree(t.base(), free));
          if (count(kept, d.stamp) < 1) errors.push(`${tag}/e/${fname}: الختم سقط بلا stamps:false`);
          const gone = await run(withFree(t.base(), { ...free, stamps: false }));
          const left = STAMP_TEXTS.filter((s) => gone.includes(s));
          if (left.length) errors.push(`${tag}/e/${fname}: أختامٌ باقية مع stamps:false ${JSON.stringify(left)}`);
          if (d.qr && hasQr(qrMarks(gone)) !== hasQr(qrMarks(kept))) errors.push(`${tag}/e/${fname}: الرمز تغيّر بحذف الأختام`);
        }
      }
    }
    // (e) للصفحة والثنائي: إشعار المُبطل والمعلَّق في الورقة المعروضة يسقط بـstamps:false
    if (t.kind === 'a4' || t.kind === 'grid') {
      for (const [dn, mk, text] of [['void', VOID, VOID_NOTICE], ['pending', PENDING, PENDING_NOTICE]] as const) {
        const today = await mode.run(t.base(), mk());
        if (count(today, text) < 1) continue; // لا يطبعه هذا القالب اليوم
        const gone = mutate(await mode.run(withFree(t.base(), { stamps: false }), mk()));
        if (gone.includes(text)) errors.push(`${t.name}/${mode.name}/${dn}/e: الإشعار باقٍ مع stamps:false`);
      }
    }
  }
  return errors;
}

test('حارس المصفوفة: ثمانية قوالب وعشرة مستندات، والكاشف يرى صيغ الرمز كلها، والمساعدات تقرأ الحذف', () => {
  assert.equal(TARGETS.length, 8);
  assert.equal(DOCS.length, 10);
  assert.equal(hasQr(qrMarks('<img width="176" height="176" alt="QR"/>')), true);
  assert.equal(hasQr(qrMarks('<div style="width:220px" data-qr-value="x"></div>')), true);
  assert.equal(hasQr(qrMarks('<div class="qrbox" style="--qr:30mm"><div class="qr"><img src="data:QR"/></div></div>')), true);
  assert.equal(qrMarks('<div data-sec="qr"></div>').sections, 1);
  assert.deepEqual(qrMarks('<div>ICV 41 · x</div>').texts, ['ICV ']);
  assert.equal(hasQr(qrMarks('<div class="qrx">لا</div>')), false);
  assert.equal(isQrRemoved(withFree(TARGETS[0].base(), QR_OFF).options.layout), true);
  assert.equal(isItemsRemoved(withFree(TARGETS[0].base(), ITEMS_OFF).options.layout), true);
  assert.equal(areStampsRemoved(withFree(TARGETS[0].base(), { stamps: false }).options.layout), true);
  for (const t of TARGETS) {
    const l = t.base().options.layout;
    assert.equal(isQrRemoved(l) || isItemsRemoved(l) || areStampsRemoved(l), false, `${t.name}: القالب الأساس يحذف شيئاً`);
  }
});

for (const t of TARGETS) {
  test(`الحذف الصريح وحده يحذف (${t.name}): الرمز والأصناف والأختام × كل مستند`, async () => {
    assert.deepEqual(await cellErrors(t), []);
  });
}

test('الرول الضيّق: 58 مم بعرض 256 نقطة يرفض الرمز المختوم اليوم (qrNoFit) — والرمز المحذوف لا يُرفض ولا يُطبع', async () => {
  const narrow = (extra: Partial<PrintLayout>): PrintProfile => {
    const p = plain('thermal', 'roll_compact', 'roll58', 'standard', extra);
    return { ...p, paper: { ...p.paper, printableDots: 256 } };
  };
  // رمزٌ مختوم بحجمه الحقيقي (~٧٠٠ محرف: التوقيع والمفتاح العامّ والبصمة) — القيمة القصيرة أعلاه تتسع في أيّ عرض
  const BIG = Buffer.alloc(520, 7).toString('base64');
  const big = (doc: Doc): Doc => (doc.kind === 'invoice' && doc.zatca ? { ...doc, zatca: { ...doc.zatca, qr: BIG } } : doc);
  const stamped = DOCS.filter((d) => d.name.startsWith('p2') && d.qr);
  assert.ok(stamped.length >= 4);
  for (const raster of [false, true]) {
    for (const d of stamped) {
      const tag = `${raster ? 'bt' : 'system'}/${d.name}`;
      await assert.rejects(roll(narrow({}), big(d.mk()), raster), (e: unknown) => e instanceof PrintRefusedError, `${tag}: اليوم لم يُرفض — الاختبار لا يقيس الضيق`);
      const out = await roll(narrow(QR_OFF), big(d.mk()), raster);
      assert.ok(!out.includes(BIG), `${tag}: قيمة الرمز في الشريط بعد حذفه`);
      const m = qrMarks(out);
      assert.ok(!hasQr(m) && !m.sections && !m.texts.length, `${tag}: رمزٌ في الشريط بعد حذفه ${JSON.stringify(m)}`);
      assert.ok(out.includes(TOTAL), `${tag}: الشريط بلا إجمالي`);
    }
  }
});

test('الصفحة بلوحة: مربع QR في اللوحة يُهمل حين يُحذف الرمز — ولوحةٌ بلا مربع والحامل مخفيّ لا تُطبع يتيماً بعد الحذف', () => {
  const t = TARGETS.find((x) => x.name === 'page_canvasQr')!;
  const doc = DOCS.find((x) => x.name === 'p2SimplifiedStamped')!.mk();
  const today = sheet(t.base(), doc);
  assert.ok(today.includes('data-section="canvas-footer"') && hasQr(qrMarks(today)), 'اليوم بلا لوحةٍ أو بلا رمز');
  const removed = sheet(withFree(t.base(), QR_OFF), doc);
  assert.ok(removed.includes('data-section="canvas-footer"'), 'سقطت لوحة التذييل مع الرمز');
  assert.ok(!hasQr(qrMarks(removed)), 'مربع QR في اللوحة طُبع بعد الحذف');
  const noBox: PrintCanvas = { ...CANVAS, boxes: CANVAS.boxes.filter((b) => b.id !== 'qr' && b.id !== 'totals') };
  const orphanToday = sheet(withFree(t.base(), { canvas: noBox, sections: { totals: { visible: false } } }), doc);
  assert.ok(hasQr(qrMarks(orphanToday)), 'اليتيم لا يُطبع بلا حذف (سلوك اليوم)');
  const orphanRemoved = sheet(withFree(t.base(), { canvas: noBox, sections: { totals: { visible: false }, qr: { visible: false } } }), doc);
  assert.ok(!hasQr(qrMarks(orphanRemoved)) && !qrMarks(orphanRemoved).sections, 'اليتيم طُبع بعد حذف الرمز');
});

test('(f) المُبطل والمعلَّق في المرحلة الثانية يُرفضان مهما حُذف: القرار لا يقرأ التخطيط، والرول يرمي PrintRefusedError', async () => {
  assert.equal(zatcaPrintDecision.length, 2, 'قرار الطباعة صار يأخذ التخطيط');
  for (const mk of [VOID, PENDING]) {
    const d = mk();
    assert.equal(zatcaPrintDecision({ isReturn: !!d.isReturn, buyerHasTaxNumber: true, saudi: true }, d.zatca).canPrint, false);
  }
  const everything: Partial<PrintLayout> = {
    sections: { qr: { visible: false }, items: { visible: false }, header: { visible: false }, info: { visible: false }, totals: { visible: false } }, stamps: false,
  };
  for (const t of TARGETS.filter((x) => x.kind === 'roll' || x.kind === 'classic')) {
    for (const free of [{}, QR_OFF, { stamps: false }, everything] as Array<Partial<PrintLayout>>) {
      for (const mk of [VOID, PENDING]) {
        for (const raster of t.kind === 'roll' ? [false, true] : [false]) {
          const p = t.kind === 'classic' ? t.base() : withFree(t.base(), free);
          if (t.kind === 'classic') {
            // الكلاسيكي اليوم يطبع شريطه بالإشعار ولا يرفض — يبقى كما هو بلا تغيير (g)
            const a = await roll(p, mk(), false);
            const b = await roll(withFree(p, free), mk(), false);
            assert.equal(a, b, `${t.name}: الكلاسيكي تغيّر`);
            continue;
          }
          await assert.rejects(roll(p, mk(), raster), (e: unknown) => e instanceof PrintRefusedError, `${t.name}/${JSON.stringify(free)}: طُبع مستندٌ لا ورقة له`);
        }
      }
    }
  }
});

test('برهان الفشل: المصفوفة تلتقط رمزاً يتسرّب بعد حذفه، وأصنافاً باقية، وختماً باقياً', async () => {
  const page = TARGETS[0];
  // قالبٌ معيب: يعيد الرمز إلى كل ورقة (كأنّ الحذف لم يُقرأ)
  const leak = await cellErrors(page, (h) => `${h}<img width="176" height="176" alt="QR"/>`);
  assert.ok(leak.some((e) => e.includes('p2SimplifiedStamped/b: الرمز باقٍ بعد حذفه')), 'لم تلتقط الرمز المتسرّب');
  const rollT = TARGETS.find((x) => x.name === 'roll_detailed80')!;
  const rollLeak = await cellErrors(rollT, (h) => `${h}<div class="qrslot" data-qr-value="${STAMPED}"></div>`);
  assert.ok(rollLeak.some((e) => e.includes('bt/p2StandardCleared/b: الرمز باقٍ')), 'الرول: لم تلتقط الخانة المتسرّبة');
  const icvLeak = await cellErrors(page, (h) => `${h}<div>ICV 41</div>`);
  assert.ok(icvLeak.some((e) => e.includes('/b: نصوص كتلة الرمز باقية')), 'لم تلتقط سطر ICV المتسرّب');
  const itemsLeak = await cellErrors(page, (h) => `${h}<td>${ITEM_NAMES[0]}</td>`);
  assert.ok(itemsLeak.some((e) => e.includes('/d: جدول الأصناف باقٍ')), 'لم تلتقط الأصناف الباقية');
  const stampLeak = await cellErrors(page, (h) => `${h}<div>${REHEARSAL_WATERMARK}</div>`);
  assert.ok(stampLeak.some((e) => e.includes('p2Rehearsal/sheet') || e.includes('p2Rehearsal/e/')), 'لم تلتقط الختم الباقي');
});
