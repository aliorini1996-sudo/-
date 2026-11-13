import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Info, RotateCcw } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import {
  PRINT_SAMPLE_WATERMARK, STAMPED_QR_CELLS, geometry, pageQrModuleMm, qrPlan, type PrintProfile,
  ACCENT_PALETTE, ACCENT_RE, LOGO_POSITIONS, LOGO_POSITION_LABELS, LOGO_SIZES, LOGO_SIZE_LABELS, PRINT_ISSUES, SECTION_LABELS, TABLE_STYLES,
  TABLE_STYLE_LABELS, accentContrastOk, canMoveSection, designsFor, isItemsRemoved, isLegacyProfileId, isQrRemoved, layoutOf, moveSection, normalizeSectionOrder, sectionsFor,
  templatesFor, withDesign, withLayout, type LogoPosition, type SectionId, type TemplateId,
} from '../../lib/print/printSettings';
import { sampleInvoiceDoc } from '../../lib/print/calibration';
import { PrintableInvoice, PrintableReceipt, type Company, type InvoiceDoc, type ReceiptDoc } from '../../rep/RepDocuments';
import { PrintLookContext, SHEET_WIDTH_PX, lookFor } from '../../rep/printLook';
import {
  FORM_COLUMN_LABELS, FORM_FIELD_LABELS, FORM_TAX_COLUMN_IDS, FORM_TAX_FIELD_IDS, fitForm, formOf, formPaperOf, formSheetSize, formTableBox, printedBox,
  tableRowTop,
} from '../../lib/print/formModel';
import { thermalPreviewHtml } from '../../rep/thermal';
import { isTaxOff } from '../../lib/taxMode';
import { sampleWatermark, taxFreeInvoiceDoc, useTaxOffPrint } from './taxOffPrint';

/**
 * معاينة قالب الطباعة في «إعدادات الطباعة» (التصميم §5.1 D، صورة M1 المبسّطة): الورقة بمقاسها الفعلي (مصغّرة لتتسع)، وحدود
 * الحزمة المطبوعة والإزاحة والهوامش، ومستند نموذجي موسوم «نموذج اختبار — ليس مستندا ضريبيا».
 *
 * رمز QR هنا **مربّع شطرنجي بمقاس الرمز المعتمد المتوقَّع** لا رمزٌ حقيقي: لا مكتبة QR ولا بناء رمز المرحلة الأولى — فلا يخرج من
 * الإعدادات ما يشبه رمزاً ضريبياً (التصميم §4.14). والقوالب الحقيقية (M2/M3) هي التي تأخذ العنوان والرمز والضريبة من
 * zatcaPrintDecision؛ هذه صورة تقريبية للأحجام والمواضع فقط.
 */
const MM = 96 / 25.4; // بكسل CSS لكل مم
const ROLL_VIEW_MIN_MM = 90;

/**
 * «التخطيط» (طلب المالك ٣ نوفمبر ٢٠٢٦): المعاينة صارت بعرضين — «التصميم الفعلي» هو القالب الحقيقي نفسه (PrintableInvoice /
 * PrintableReceipt بمظهر القالب المفتوح lookFor(profile)، والرول بوثيقة thermal.ts بملفّه) فيظهر مكان الشعار واللون والجدول وترتيب
 * الأقسام والتصميم ثنائي اللغة ونصوص الشركة كما تُطبع؛ و«المقاس والهوامش» المخطّط القديم بحدود الحزمة والهوامش. المستند النموذجي
 * هو مستند المعايرة (رمزٌ تجريبي لا يُمسح كرمزٍ ضريبي) مع رمز الصنف وضريبة السطر والمدينة والرمز البريدي للبائع والمشتري.
 */
type PreviewView = 'design' | 'paper';
type PreviewKind = 'invoice' | 'receipt';

export default function PrintPreview({ profile, companyName, brandColor, company }: {
  profile: PrintProfile; companyName: string; brandColor: string; company?: Company | null;
}) {
  const tr = useTr();
  const [view, setView] = useState<PreviewView>('design');
  const [kind, setKind] = useState<PreviewKind>('invoice');
  // «نموذج الشركة المطبوع مسبقاً» للفواتير وحدها (قاعدة التوجيه في النواة) — فلا معاينة سند قبض عليه
  const formOnly = isFormDesign(profile);
  const tab = (on: boolean): string =>
    `shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#44403a]'}`;
  return (
    <div>
      <div className="flex items-center gap-1.5 flex-wrap mb-2" role="tablist">
        {(['design', 'paper'] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={tab(view === v)}>
            {v === 'design' ? tr('التصميم الفعلي') : tr('المقاس والهوامش')}
          </button>
        ))}
        {view === 'design' && !formOnly && (
          <span className="ms-auto flex gap-1">
            {(['invoice', 'receipt'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={tab(kind === k)}>
                {k === 'invoice' ? tr('فاتورة') : tr('سند قبض')}
              </button>
            ))}
          </span>
        )}
      </div>
      {view === 'design'
        ? <DesignPreview profile={profile} company={company} kind={formOnly ? 'invoice' : kind} />
        : <PaperPreview profile={profile} companyName={companyName} brandColor={brandColor} />}
    </div>
  );
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** فاتورة المعاينة: مستند المعايرة (sampleInvoiceDoc) ومعه ما يملأ القالب ثنائي اللغة — رمز الصنف وضريبة السطر والعنوان الوطني */
export function previewInvoiceDoc(company: Company | null | undefined, tr: Tr, now: Date = new Date()): InvoiceDoc {
  const d = sampleInvoiceDoc(company, tr, now);
  const c = d.company ?? { name: tr('اسم الشركة') };
  // «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦): للشركة بلا ضريبة مستندٌ مختومٌ بلا ضريبة ولا رقمٍ ضريبي للطرفين — والسند منه
  const taxOff = isTaxOff(company);
  const doc: InvoiceDoc = {
    ...d,
    company: {
      ...c,
      address: c.address || tr('الرياض - حي العليا'),
      phone: c.phone || '0110000000',
      commercialReg: c.commercialReg || '1010000000',
      addrCity: c.addrCity || tr('الرياض'),
      addrPostalCode: c.addrPostalCode || '12211',
    },
    customer: {
      name: tr('عميل تجريبي'), businessName: tr('مؤسسة تجريبية'), ...(taxOff ? {} : { taxNumber: '310000000000003' }), phone: '0500000000',
      address: tr('جدة - حي الروضة'), city: tr('جدة'), postalCode: '23435',
    },
    items: d.items.map((it, i) => ({
      ...it,
      code: `P-${1001 + i}`,
      taxAmt: d.pricesIncludeTax ? r2(it.lineTotal - it.lineTotal / (1 + it.taxPct / 100)) : r2((it.lineTotal * it.taxPct) / 100),
    })),
  };
  return taxOff ? taxFreeInvoiceDoc(doc) : doc;
}

/**
 * فاتورة معاينة «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦): فاتورة المعاينة نفسها ومعها ما يملأ عمود «الباركود»
 * وحقل «الملاحظات» في النموذج. مستندٌ جديد — فاتورة المعاينة والمستند التجريبيّ كما هما حرفاً (الحرّاس الذهبية).
 */
export function previewFormDoc(company: Company | null | undefined, tr: Tr, now: Date = new Date()): InvoiceDoc {
  const d = previewInvoiceDoc(company, tr, now);
  return { ...d, notes: tr('ملاحظة تجريبية'), items: d.items.map((it, i) => ({ ...it, barcode: `628100000${1001 + i}` })) };
}

/** سند المعاينة — مقابل فاتورة المعاينة، بلا رمز QR كاليوم */
export function previewReceiptDoc(company: Company | null | undefined, tr: Tr, now: Date = new Date()): ReceiptDoc {
  const inv = previewInvoiceDoc(company, tr, now);
  return {
    kind: 'receipt', number: 'TEST-R-0001', date: inv.date, company: inv.company, customer: inv.customer, repName: inv.repName,
    amount: inv.total, paymentMethod: 'CASH', invoices: [{ number: inv.number, amount: inv.total }],
  };
}

/** العلامة المائية فوق كل معاينة — «نموذج اختبار — ليس مستندا ضريبيا» */
function Watermark({ size }: { size: number }) {
  const tr = useTr();
  // «إزالة الضريبة»: «نموذج اختبار» وحده لشركةٍ بلا ضريبة (سياق تبويب «إعدادات الطباعة»)
  const PRINT_SAMPLE_WATERMARK = sampleWatermark(useTaxOffPrint());
  return (
    <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <span style={{ transform: 'rotate(-28deg)', color: 'rgba(225,90,48,0.32)', fontWeight: 800, fontSize: size, whiteSpace: 'nowrap' }}>
        {tr(PRINT_SAMPLE_WATERMARK)}
      </span>
    </div>
  );
}

function DesignPreview({ profile, company, kind }: { profile: PrintProfile; company?: Company | null; kind: PreviewKind }) {
  const tr = useTr();
  // النموذج المطبوع مسبقاً: فاتورته النموذجية بالباركود والملاحظة (previewFormDoc) — وغيره كما كان
  const form = isFormDesign(profile);
  const doc = useMemo(
    () => (kind === 'invoice' ? (form ? previewFormDoc(company, tr) : previewInvoiceDoc(company, tr)) : previewReceiptDoc(company, tr)),
    [kind, company, tr, form],
  );
  if (profile.printer === 'thermal') return <RollPreview profile={profile} doc={doc} />;
  return <SheetPreview profile={profile} doc={doc} />;
}

/**
 * ورقة الصفحة والنقطية: القالب الحقيقي بعرض 794 بكسل مصغّراً لعمود المعاينة، بمظهر القالب المفتوح — وأوراق النموذج المطبوع مسبقاً
 * بعرض الورق نفسه (بالمم)
 */
function SheetPreview({ profile, doc }: { profile: PrintProfile; doc: InvoiceDoc | ReceiptDoc }) {
  const look = useMemo(() => lookFor(profile), [profile]);
  const boxRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const formSheet = isFormDesign(profile) ? formSheetSize(profile.paper) : null;
  const sheetPx = formSheet ? formSheet.widthMm * MM : SHEET_WIDTH_PX;
  const [boxW, setBoxW] = useState(0);
  const [sheetH, setSheetH] = useState(formSheet ? Math.round(formSheet.lengthMm * MM) : 1123);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const sheet = sheetRef.current;
    if (!box || !sheet) return;
    const measure = () => { setBoxW(box.clientWidth); setSheetH(sheet.offsetHeight); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(sheet);
    return () => ro.disconnect();
  }, []);
  const scale = boxW > 0 ? Math.min(1, boxW / sheetPx) : 0.42;
  return (
    <div ref={boxRef} className="w-full" data-preview="sheet">
      <div className="relative mx-auto bg-white overflow-hidden" style={{ width: sheetPx * scale, height: sheetH * scale, boxShadow: '0 1px 6px rgba(31,26,19,0.18)', border: '1px solid #E9E1D3' }}>
        <div ref={sheetRef} style={{ position: 'absolute', top: 0, left: 0, width: sheetPx, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          <PrintLookContext.Provider value={look}>
            {doc.kind === 'invoice' ? <PrintableInvoice doc={doc} /> : <PrintableReceipt doc={doc} />}
          </PrintLookContext.Provider>
        </div>
        <Watermark size={Math.max(13, (sheetPx * scale) / 13)} />
      </div>
    </div>
  );
}

/** الرول: وثيقة القالب الحراريّ نفسها (rep/thermal.ts) بملفّ القالب المفتوح في iframe بعرض الورق — للعرض فقط، بلا سكربت */
function RollPreview({ profile, doc }: { profile: PrintProfile; doc: InvoiceDoc | ReceiptDoc }) {
  const tr = useTr();
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(480);
  const paperMm: 58 | 80 = profile.paper.widthMm < 70 ? 58 : 80;
  useEffect(() => {
    let live = true;
    // تعديلات متتابعة (نقرات الترتيب، كتابة لون) لا تبني الوثيقة لكل خطوة
    const t = window.setTimeout(() => {
      thermalPreviewHtml(doc, { tr, paperMm, profile }).then(
        (h) => { if (live) { setHtml(h); setFailed(false); } },
        () => { if (live) setFailed(true); },
      );
    }, 200);
    return () => { live = false; window.clearTimeout(t); };
  }, [doc, paperMm, profile, tr]);
  if (failed) return <p className="text-sm text-[#8E2A1F] text-center py-10">{tr('تعذر عرض المعاينة الحرارية')}</p>;
  if (html === null) return <div className="flex justify-center py-10"><span className="w-6 h-6 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" /></div>;
  return (
    <div className="flex justify-center" data-preview="roll">
      <div className="relative">
        <iframe title={tr('المعاينة الحرارية')} srcDoc={html} sandbox="allow-same-origin"
          onLoad={(e) => {
            const d = e.currentTarget.contentDocument;
            if (d) setHeight(Math.max(240, d.documentElement.scrollHeight + 4));
          }}
          className="bg-white shadow-sm border border-[#E9E1D3] block"
          style={{ width: `calc(${profile.paper.widthMm}mm + 2px)`, maxWidth: '100%', height }} />
        <Watermark size={13} />
      </div>
    </div>
  );
}

/** المخطّط: الورقة بمقاسها وحدود الحزمة والهوامش (المعاينة قبل «التخطيط») */
export function PaperPreview({ profile, companyName, brandColor }: { profile: PrintProfile; companyName: string; brandColor: string }) {
  const tr = useTr();
  const g = geometry(profile);
  const o = profile.options;
  const raster = profile.printer !== 'page';
  const roll = profile.printer === 'thermal' && g.feed === 'roll';
  // الحرارية والنقطية والعادية البسيطة أبيض وأسود بلا تظليل (الرمادي على النقطية نمط نقاط يُتلف الشريط)
  const mono = raster || profile.template === 'page_plain';
  const qrCells = STAMPED_QR_CELLS.typical;
  const plan = qrPlan(profile, qrCells);
  // العادية: رمز قالب الصفحة (176 بكسل من 794) مُصغَّراً أو مُكبَّراً بعرض الورق كما يُطبع ويُحفظ PDF — لا مقاس A4 ثابت
  const qrMm = plan ? plan.sizeMm : pageQrModuleMm(g.paperWidthMm, qrCells) * qrCells;
  // ما حذفته الشركة صراحةً (قرار المالك ٤ نوفمبر ٢٠٢٦) لا يُرسم في المخطّط — والعلامة المائية باقية: معاينةٌ على الشاشة لا ورق
  const removed: Removed = { qr: isQrRemoved(layoutOf(profile)), items: isItemsRemoved(layoutOf(profile)) };
  // «إزالة الضريبة» (سياق التبويب): المخطّط بلا رقمٍ ضريبي ولا «فاتورة ضريبية مبسطة» ولا سطري الضريبة ولا رمز، والعلامة «نموذج اختبار»
  const taxOff = useTaxOffPrint();
  if (taxOff) { removed.qr = true; removed.tax = true; }

  const contentRef = useRef<HTMLDivElement>(null);
  const [contentPx, setContentPx] = useState(0);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setContentPx(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [profile, companyName]);

  const paperW = g.paperWidthMm * MM;
  const topPx = g.marginTopMm * MM;
  const bottomPx = g.marginBottomMm * MM;
  // الرول بطول محتواه (والتغذية بعده)، والورق بطول صفحته (تُعرض الأولى وحدها)
  const paperH = g.paperLengthMm !== null
    ? g.paperLengthMm * MM
    : Math.max(ROLL_VIEW_MIN_MM * MM, topPx + contentPx + bottomPx + o.feedAfterMm * MM);
  const scale = Math.min(1, 340 / paperW);
  const bandW = g.printableWidthMm * MM;
  const bandL = g.bandLeftMm * MM;
  const preprintedGapPx = profile.template === 'impact_preprinted' ? 25 * MM : 0;
  const basePx = schematicFontPx(profile);

  const contentStyle: CSSProperties = {
    position: 'absolute', left: bandL, width: bandW, top: topPx + preprintedGapPx,
    fontSize: basePx, lineHeight: 1.45, color: '#000', fontWeight: o.boldBody ? 700 : 400,
    fontFamily: raster ? "Tahoma, Arial, sans-serif" : undefined,
  };

  return (
    <div>
      <div className="relative mx-auto" style={{ width: paperW * scale, height: paperH * scale }}>
        <div dir="rtl" className="absolute bg-white overflow-hidden"
          style={{ width: paperW, height: paperH, left: 0, top: 0, transform: `scale(${scale})`, transformOrigin: 'top left', boxShadow: '0 1px 6px rgba(31,26,19,0.18)', border: '1px solid #E9E1D3' }}>
          {/* الهامشان */}
          {topPx > 0 && <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: topPx, background: 'repeating-linear-gradient(45deg, #FBEBE2 0 4px, #fff 4px 8px)' }} />}
          {bottomPx > 0 && g.paperLengthMm !== null && <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: bottomPx, background: 'repeating-linear-gradient(45deg, #FBEBE2 0 4px, #fff 4px 8px)' }} />}
          {/* حدود الحزمة المطبوعة */}
          <div aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, left: bandL, width: bandW, borderLeft: '1px dashed #E15A30', borderRight: '1px dashed #E15A30' }} />

          {/* «نموذج الشركة المطبوع مسبقاً»: مواضع الحقول والأعمدة على الورقة لا مستندٌ تخطيطيّ — البيانات وحدها تُطبع على ورق الشركة */}
          {isFormDesign(profile) ? <FormSchematic profile={profile} tr={tr} taxOff={taxOff} /> : (
            <div ref={contentRef} style={contentStyle}>
              {raster
                ? <RollOrImpactSample profile={profile} companyName={companyName} qrMm={qrMm} qrCells={qrCells} removed={removed} tr={tr} />
                : <PageSample profile={profile} companyName={companyName} brandColor={mono ? '#000' : brandColor} mono={mono} qrMm={qrMm} qrCells={qrCells} removed={removed} tr={tr} />}
            </div>
          )}

          {/* العلامة المائية — كل معاينة واختبار «ليس مستندا ضريبيا» */}
          <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span style={{ transform: 'rotate(-28deg)', color: 'rgba(225,90,48,0.32)', fontWeight: 800, fontSize: Math.max(13, paperW / 13), whiteSpace: 'nowrap' }}>
              {tr(sampleWatermark(taxOff))}
            </span>
          </div>
        </div>
      </div>
      <p className="text-[11px] text-[#9A8F7E] mt-2 text-center">
        {tr('المقياس')} {Math.round(scale * 100)}% · <span dir="ltr">{g.paperWidthMm}{g.paperLengthMm !== null ? ` × ${g.paperLengthMm}` : ''} mm</span>
        {!roll && g.paperLengthMm !== null && <> · {tr('الصفحة الأولى')}</>}
        <span className="inline-flex items-center gap-1 ms-2"><span className="inline-block w-3 border-t border-dashed border-[#E15A30]" />{tr('حدود الطباعة')}</span>
      </p>
    </div>
  );
}

type Tr = (s: string) => string;

/**
 * مخطّط «نموذج الشركة المطبوع مسبقاً» في «المقاس والهوامش»: مربعٌ متقطّع لكل حقلٍ وشريطٌ لكل عمودٍ بخطوط صفوفه، في موضعه المطبوع
 * (بالإزاحة — كصفحة المعايرة) وباسمه. لشركةٍ بلا ضريبة لا حقول الضريبة وعمودها ولا مربع الرمز. والنقطية بورق النموذج نفسه الذي تطبع
 * به (formPaperOf — داخل ما تبلغه الإبرة، وهي حدود الطباعة المرسومة فوقه)؛ والعادية كما كانت (reach: null).
 */
function FormSchematic({ profile, tr, taxOff }: { profile: PrintProfile; tr: Tr; taxOff: boolean }) {
  const raw = formOf(profile);
  if (!raw) return null;
  const form = fitForm(raw, formPaperOf(profile));
  const at = (b: { x: number; y: number; w: number; h: number }): CSSProperties => ({ position: 'absolute', left: b.x * MM, top: b.y * MM, width: b.w * MM, height: b.h * MM });
  const label: CSSProperties = { fontSize: 9, lineHeight: 1.15, color: '#C94E28', whiteSpace: 'nowrap', overflow: 'hidden', padding: '1px 2px' };
  const t = form.table;
  const tb = formTableBox(t);
  const rowPx = t ? t.rowMm * MM : 0;
  return (
    <div data-form-schematic="" aria-hidden="true">
      {form.fields.filter((f) => !(taxOff && (FORM_TAX_FIELD_IDS.includes(f.id) || f.id === 'qr'))).map((f) => (
        <div key={f.id} data-field={f.id} style={{ ...at(printedBox(form, f)), border: '1px dashed #E15A30', ...label }}>{tr(FORM_FIELD_LABELS[f.id])}</div>
      ))}
      {t && tb && t.columns.filter((c) => !(taxOff && FORM_TAX_COLUMN_IDS.includes(c.id))).map((c) => (
        <div key={c.id} data-column={c.id} style={{
          ...at(printedBox(form, { x: c.x, y: tableRowTop(t, 0), w: c.w, h: tb.h })), borderLeft: '1px dashed #E15A30', borderRight: '1px dashed #E15A30',
          backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${rowPx - 1}px, #F3D5C8 ${rowPx - 1}px ${rowPx}px)`, ...label, textAlign: 'center',
        }}>{tr(FORM_COLUMN_LABELS[c.id])}</div>
      ))}
    </div>
  );
}

/** مربّع شطرنجي بمقاس الرمز وخلاياه — ليس رمزاً */
function QrSlot({ mm, cells, tr }: { mm: number; cells: number; tr: Tr }) {
  const px = mm * MM;
  const cell = px / cells;
  return (
    <div style={{ textAlign: 'center', margin: '6px 0 2px' }}>
      <div aria-hidden="true" style={{
        display: 'inline-block', width: px, height: px, outline: `${cell * 2}px solid #fff`,
        background: `repeating-conic-gradient(#000 0 25%, #fff 0 50%) 0 0 / ${cell * 2}px ${cell * 2}px`,
      }} />
      <div style={{ fontSize: '0.8em' }}>{tr('رمز QR')} · <span dir="ltr">≈ {Math.round(mm)} mm</span></div>
    </div>
  );
}

const SAMPLE_ITEMS = [
  { n: 1, qty: 2, price: '25.00', total: '50.00' },
  { n: 2, qty: 1, price: '30.00', total: '30.00' },
  { n: 3, qty: 4, price: '5.00', total: '20.00' },
];

function Row({ a, b, bold }: { a: ReactNode; b: ReactNode; bold?: boolean }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontWeight: bold ? 700 : undefined }}><span>{a}</span><span dir="ltr">{b}</span></div>;
}
const Sep = () => <div style={{ borderTop: '1px dashed #000', margin: '4px 0' }} />;

/** ما حذفته الشركة صراحةً من المطبوعة: رمز QR وجدول الأصناف — وtax: الشركة بلا ضريبة («إزالة الضريبة»: لا رقم ضريبي ولا عنوانٌ ضريبي ولا سطرا الضريبة) */
type Removed = { qr: boolean; items: boolean; tax?: boolean };

function RollOrImpactSample({ profile, companyName, qrMm, qrCells, removed, tr }: { profile: PrintProfile; companyName: string; qrMm: number; qrCells: number; removed: Removed; tr: Tr }) {
  const o = profile.options;
  const t = profile.template;
  const detailed = t === 'roll_detailed' || profile.printer === 'impact';
  const logo = o.showLogo && t !== 'impact_preprinted' && t !== 'roll_classic';
  return (
    <div>
      {logo && <div style={{ margin: '0 auto 4px', width: 44, height: 22, border: '1.5px solid #000', fontSize: '0.75em', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{tr('شعار الشركة')}</div>}
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '1.25em' }}>{companyName}</div>
      {!removed.tax && <div style={{ textAlign: 'center', fontSize: '0.9em' }}>{tr('الرقم الضريبي')} <span dir="ltr">300000000000003</span></div>}
      {o.showContact && <div style={{ textAlign: 'center', fontSize: '0.9em' }}>{tr('العنوان')} · <span dir="ltr">0500000000</span></div>}
      <Sep />
      <div style={{ textAlign: 'center', fontWeight: 700 }}>{removed.tax ? tr('فاتورة') : tr('فاتورة ضريبية مبسطة')}</div>
      {o.copyLabels && <div style={{ textAlign: 'center', fontSize: '0.85em' }}>{tr('الأصل')}</div>}
      <Sep />
      <Row a={tr('رقم')} b="INV-1024" />
      <Row a={tr('التاريخ')} b="23/10/2026 10:30" />
      {o.showRepName && <Row a={tr('المندوب')} b={tr('مندوب تجريبي')} />}
      <Row a={tr('العميل')} b={tr('عميل نقدي')} />
      <Sep />
      {removed.items ? null : detailed ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95em' }}>
          <thead>
            <tr style={{ borderBottom: profile.printer === 'impact' ? '1.5px solid #000' : '1px dashed #000' }}>
              <th style={{ textAlign: 'right' }}>{tr('الصنف')}</th><th>{tr('الكمية')}</th><th>{tr('السعر')}</th><th style={{ textAlign: 'left' }}>{tr('الإجمالي')}</th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_ITEMS.map((it) => (
              <tr key={it.n}>
                <td>{tr('صنف تجريبي')} {it.n}{o.showItemUnit && <span style={{ fontSize: '0.85em' }}> ({tr('الوحدة')})</span>}</td>
                <td style={{ textAlign: 'center' }} dir="ltr">{it.qty}</td>
                <td style={{ textAlign: 'center' }} dir="ltr">{it.price}</td>
                <td style={{ textAlign: 'left' }} dir="ltr">{it.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : SAMPLE_ITEMS.map((it) => (
        <div key={it.n} style={{ margin: '2px 0' }}>
          <div style={{ fontWeight: 600 }}>{tr('صنف تجريبي')} {it.n}{o.showItemUnit && <span style={{ fontSize: '0.85em' }}> ({tr('الوحدة')})</span>}</div>
          <Row a={<span dir="ltr">{it.qty} × {it.price}</span>} b={it.total} bold />
        </div>
      ))}
      <Sep />
      {!removed.tax && <Row a={tr('المجموع قبل الضريبة')} b="100.00" />}
      {!removed.tax && <Row a={`${tr('ضريبة القيمة المضافة')} 15%`} b="15.00" />}
      <Row a={tr('الإجمالي')} b={removed.tax ? '100.00' : '115.00'} bold />
      {o.showSignatures && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          {['توقيع المستلم', 'توقيع المندوب'].map((l) => (
            <div key={l} style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 2, marginTop: 18, textAlign: 'center', fontSize: '0.8em' }}>{tr(l)}</div>
          ))}
        </div>
      )}
      {!removed.qr && <QrSlot mm={qrMm} cells={qrCells} tr={tr} />}
      <div style={{ textAlign: 'center', fontSize: '0.9em' }}>{o.footerText ?? tr('شكرا لتعاملكم معنا')}</div>
    </div>
  );
}

function PageSample({ profile, companyName, brandColor, mono, qrMm, qrCells, removed, tr }: { profile: PrintProfile; companyName: string; brandColor: string; mono: boolean; qrMm: number; qrCells: number; removed: Removed; tr: Tr }) {
  const o = profile.options;
  const rule = mono ? '1.5px solid #000' : `2px solid ${brandColor}`;
  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 6, borderBottom: rule }}>
        {o.showLogo && <div style={{ width: 54, height: 54, border: mono ? '1.5px solid #000' : `1.5px solid ${brandColor}`, borderRadius: 6, fontSize: '0.8em', display: 'flex', alignItems: 'center', justifyContent: 'center', color: mono ? '#000' : brandColor }}>{tr('شعار الشركة')}</div>}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: '1.5em', color: mono ? '#000' : brandColor }}>{companyName}</div>
          {!removed.tax && <div>{tr('الرقم الضريبي')} <span dir="ltr">300000000000003</span></div>}
          {o.showContact && <div>{tr('العنوان')} · <span dir="ltr">0500000000</span></div>}
        </div>
        <div style={{ fontWeight: 800, fontSize: '1.3em' }}>{removed.tax ? tr('فاتورة') : tr('فاتورة ضريبية مبسطة')}</div>
      </div>
      {o.copyLabels && <div style={{ textAlign: 'center', marginTop: 4 }}>{tr('الأصل')}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 16px', margin: '8px 0' }}>
        <Row a={tr('رقم')} b="INV-1024" />
        <Row a={tr('التاريخ')} b="23/10/2026 10:30" />
        <Row a={tr('العميل')} b={tr('عميل نقدي')} />
        {o.showRepName && <Row a={tr('المندوب')} b={tr('مندوب تجريبي')} />}
      </div>
      {!removed.items && <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: mono ? undefined : brandColor, color: mono ? '#000' : '#fff', borderBottom: mono ? '1.5px solid #000' : undefined }}>
            <th style={{ textAlign: 'right', padding: '3px 4px' }}>{tr('الصنف')}</th><th>{tr('الكمية')}</th><th>{tr('السعر')}</th><th style={{ textAlign: 'left', padding: '3px 4px' }}>{tr('الإجمالي')}</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE_ITEMS.map((it) => (
            <tr key={it.n} style={{ borderBottom: mono ? '1px solid #000' : '1px solid #E9E1D3' }}>
              <td style={{ padding: '3px 4px' }}>{tr('صنف تجريبي')} {it.n}{o.showItemUnit && <span> ({tr('الوحدة')})</span>}</td>
              <td style={{ textAlign: 'center' }} dir="ltr">{it.qty}</td>
              <td style={{ textAlign: 'center' }} dir="ltr">{it.price}</td>
              <td style={{ textAlign: 'left', padding: '3px 4px' }} dir="ltr">{it.total}</td>
            </tr>
          ))}
        </tbody>
      </table>}
      <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          {!removed.tax && <Row a={tr('المجموع قبل الضريبة')} b="100.00" />}
          {!removed.tax && <Row a={`${tr('ضريبة القيمة المضافة')} 15%`} b="15.00" />}
          <Row a={tr('الإجمالي')} b={removed.tax ? '100.00' : '115.00'} bold />
        </div>
        {!removed.qr && <QrSlot mm={qrMm} cells={qrCells} tr={tr} />}
      </div>
      {o.showSignatures && (
        <div style={{ display: 'flex', gap: 24, marginTop: 10 }}>
          {['توقيع المستلم', 'توقيع المندوب'].map((l) => (
            <div key={l} style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 2, marginTop: 24, textAlign: 'center' }}>{tr(l)}</div>
          ))}
        </div>
      )}
      <div style={{ textAlign: 'center', marginTop: 8 }}>{o.footerText ?? tr('شكرا لتعاملكم معنا')}</div>
    </div>
  );
}

// ─── «التخطيط» (طلب المالك ٣ نوفمبر ٢٠٢٦): التصميم ثنائي اللغة، ومكان الشعار وحجمه، واللون، والخط، والجدول، وترتيب الأقسام ───
// هنا لا في اللوحة: اللوحة تستورد عميل الـAPI فلا تُحمَّل في اختبار node (printLayoutUi.test.ts يختبر هذه الدوالّ ويرسم الحقول).
// دوالّ نقيّة فوق مساعدات lib/print/printSettings.ts — لا تحقّق هنا: القواعد في layoutIssues والقيود في canMoveSection/moveSection.
// قالبٌ لم يُلمس تخطيطه يبقى بلا options.layout فيطبع اليوم حرفياً.

/**
 * بطاقة في خطوة «التصميم»: قالبٌ من قوالب الطابعة، أو «كلاسيكي بإطارات — ثنائي اللغة» (الصفحة والنقطية — ليس TemplateId)، أو
 * «نموذج الشركة المطبوع مسبقاً» (الطابعة العادية والنقطية بورقٍ له طول — طلب المالك ١٠–١١ نوفمبر ٢٠٢٦، والنقطية ١٣ نوفمبر)
 */
export type DesignCard = { kind: 'template'; t: TemplateId } | { kind: 'grid' } | { kind: 'preprinted' };

const isGridDesign = (p: PrintProfile): boolean => p.options.layout?.design === 'grid_bilingual';
/** القالب على تصميم «نموذج الشركة المطبوع مسبقاً» */
const isFormDesign = (p: PrintProfile): boolean => p.options.layout?.design === 'preprinted';

/**
 * قوالب الطابعة ثم البطاقة الثالثة ثنائية اللغة حيث يصحّ تصميمها (designsFor)، ثم بطاقة النموذج المطبوع مسبقاً (العادية والنقطية) —
 * وورقٌ بلا طول تعطّلها اللوحة برسالتها (withDesign لا يغيّر شيئاً بلا طول)
 */
export function designCards(p: PrintProfile): DesignCard[] {
  const cards: DesignCard[] = templatesFor(p.printer).map((t) => ({ kind: 'template' as const, t }));
  const designs = designsFor(p.printer);
  if (designs.includes('grid_bilingual')) cards.push({ kind: 'grid' });
  if (designs.includes('preprinted')) cards.push({ kind: 'preprinted' });
  return cards;
}

/** المفتاح الثابت لكل بطاقة (key وdata-design-card): القالب باسمه، والتصميمان باسميهما */
export function designCardId(c: DesignCard): TemplateId | 'grid_bilingual' | 'preprinted' {
  return c.kind === 'template' ? c.t : c.kind === 'grid' ? 'grid_bilingual' : 'preprinted';
}

/** المختارة: ثنائي اللغة والنموذج المطبوع مسبقاً بتصميمهما في التخطيط، وغيرهما بقالبه ما دام التصميم ليس أحدهما */
export function designCardSelected(p: PrintProfile, c: DesignCard): boolean {
  if (c.kind === 'grid') return isGridDesign(p);
  if (c.kind === 'preprinted') return isFormDesign(p);
  return !isGridDesign(p) && !isFormDesign(p) && p.template === c.t;
}

/**
 * الاختيار: ثنائي اللغة ⇒ withDesign (القالب الأحادي للطابعة وتخطيطه)، والنموذج المطبوع مسبقاً ⇒ withDesign (page_plain، وعلى
 * النقطية impact_preprinted، بلا هامشين ومواضع البداية)، وقالبٌ بعد أحدهما ⇒ يعود «التصميم الحالي» بذلك القالب
 */
export function applyDesignCard(p: PrintProfile, c: DesignCard): PrintProfile {
  if (c.kind === 'grid') return withDesign(p, 'grid_bilingual');
  if (c.kind === 'preprinted') return withDesign(p, 'preprinted');
  // الخروج من التصميم أولاً ثم القالب المختار: الخروج من نموذج النقطية يعيد احتياطه (impact_preprinted) إلى impact_plain — فبطاقة
  // «على ورق بترويسة مطبوعة» المختارة صراحةً تبقى كما اختيرت. والنتيجة على العادية هي نفسها حرفاً (withDesign لا يقرأ القالب)
  if (isGridDesign(p) || isFormDesign(p)) return { ...withDesign(p, 'standard'), template: c.t };
  return { ...p, template: c.t };
}

/** الافتراضيان والرول الكلاسيكي لا يحملان تخطيطاً (layoutClassic) — يُنسخ الافتراضي لتخصيصه كاليوم */
export function layoutEditable(p: PrintProfile): boolean {
  return !isLegacyProfileId(p.id) && p.template !== 'roll_classic';
}

/** مواضع الشعار المتاحة: الأربعة على كل ورق — الرول صار يقبل اليمين واليسار (التحرير الحرّ، pd_spec B.3) */
export function logoChoices(_p: PrintProfile): readonly LogoPosition[] {
  return LOGO_POSITIONS;
}

/** أحجام الخط في «التخطيط» للصفحة والنقطية (الرول يبقى في «الخط» بمقاساته الأربعة كاليوم) */
export const LAYOUT_FONT_SCALES = [0.9, 1, 1.15] as const;

/** حجم الخط للصفحة والنقطية: يُحفظ في fontScale ويُنشئ التخطيط — بلا تخطيط لا يُطبَّق عليهما (مطبوعة اليوم حرفياً) */
export function withLayoutFontScale(p: PrintProfile, f: (typeof LAYOUT_FONT_SCALES)[number]): PrintProfile {
  return withLayout({ ...p, options: { ...p.options, fontScale: f } }, {});
}

/** حجم الخط الفعّال على الورقة: الصفحة والنقطية بلا تخطيط 100% مهما حُفظ */
export function effectiveFontScale(p: PrintProfile): number {
  return p.printer !== 'thermal' && !p.options.layout ? 1 : p.options.fontScale;
}

/** خطّ مخطّط «المقاس والهوامش»: بالحجم الفعّال على الورقة (effectiveFontScale) — لا fontScale محفوظاً لا تطبعه الصفحة بلا تخطيط */
export function schematicFontPx(p: PrintProfile): number {
  const raster = p.printer !== 'page';
  return (p.printer === 'impact' ? 12 : raster ? 11 : 10.5) * effectiveFontScale(p);
}

export interface SectionRow { id: SectionId; up: boolean; down: boolean }

/**
 * السحب باللمس في «ترتيب الأقسام» (Pointer Events — سحب HTML5 لا يعمل بالإصبع): الصفّ تحت المؤشّر من مستطيلات الصفوف (من الأعلى)،
 * وفوق الأول ⇒ 0 وتحت الأخير ⇒ الأخير؛ بلا صفوف ⇒ -1
 */
export function rowIndexAtY(rects: readonly { top: number; bottom: number }[], y: number): number {
  if (!rects.length) return -1;
  for (let i = 0; i < rects.length; i++) if (y < rects[i].bottom) return i;
  return rects.length - 1;
}

/** صفوف «ترتيب الأقسام» بالترتيب الفعّال، و▲▼ لكلٍّ منها حيث لا تمنع قاعدة (الترويسة أولاً، التواقيع ثم التذييل آخراً…) */
export function sectionRows(p: PrintProfile): SectionRow[] {
  const l = layoutOf(p);
  return normalizeSectionOrder(l.order, p.printer, l.design).map((id, i) => ({
    id, up: canMoveSection(p, id, i - 1), down: canMoveSection(p, id, i + 1),
  }));
}

/** صفّ «ترتيب الأقسام» كما يُعرض: `at` موضعه في الترتيب الحقيقي، و`upTo`/`downTo` الموضع الذي ينقله إليه ▲/▼ */
export interface LayoutSectionRow extends SectionRow { at: number; upTo: number; downTo: number }

/**
 * صفوف «ترتيب الأقسام» المعروضة: للشركة بضريبتها sectionRows نفسها (at = موضع الصفّ، و▲▼ إلى الموضع المجاور — اليوم حرفاً).
 * «إزالة الضريبة» (E6): بلا ضريبة لا صفّ «رمز QR» (لا رمز على مستنداتها) — ويبقى الرمز في الترتيب المحفوظ بموضعه، فالنقل بمواضعه
 * الحقيقية: ▲▼ إلى موضع الصفّ الظاهر المجاور (يتخطّى الرمز المخفي فلا ضغطةَ بلا أثرٍ ظاهر)، والسحب إلى موضع الصفّ المُفلَت عليه.
 */
export function layoutSectionRows(p: PrintProfile, taxOff: boolean): LayoutSectionRow[] {
  const all = sectionRows(p);
  if (!taxOff) return all.map((r, i) => ({ ...r, at: i, upTo: i - 1, downTo: i + 1 }));
  const shown = all.map((r, i) => ({ id: r.id, at: i })).filter((r) => r.id !== 'qr');
  return shown.map((r, v) => {
    const upTo = v > 0 ? shown[v - 1].at : -1;
    const downTo = v < shown.length - 1 ? shown[v + 1].at : all.length;
    return {
      id: r.id, at: r.at, upTo, downTo,
      up: v > 0 && canMoveSection(p, r.id, upTo), down: v < shown.length - 1 && canMoveSection(p, r.id, downTo),
    };
  });
}

/**
 * زرّ ▲/▼ الذي يعود إليه التركيز بعد النقل بلوحة المفاتيح: React ينقل عقدة الصفّ في DOM (فيضيع تركيز زرّه) أو يُعطَّل الزرّ عند
 * الحدّ — فالاتجاه نفسه إن بقي متاحاً، وإلا الآخر، وإلا null
 */
export function moveFocusTarget(rows: readonly SectionRow[], id: SectionId, dir: 'up' | 'down'): 'up' | 'down' | null {
  const r = rows.find((x) => x.id === id);
  if (!r) return null;
  if (dir === 'up' ? r.up : r.down) return dir;
  if (dir === 'up' ? r.down : r.up) return dir === 'up' ? 'down' : 'up';
  return null;
}

export function orderIsDefault(p: PrintProfile): boolean {
  const l = layoutOf(p);
  const def = sectionsFor(p.printer, l.design);
  const cur = normalizeSectionOrder(l.order, p.printer, l.design);
  return cur.length === def.length && cur.every((id, i) => id === def[i]);
}

/** «إعادة الترتيب الافتراضي» — ترتيب اليوم لأقسام التصميم، وقالبٌ بلا تخطيط يبقى بلا تخطيط */
export function resetSectionOrder(p: PrintProfile): PrintProfile {
  if (orderIsDefault(p)) return p;
  return withLayout(p, { order: [...sectionsFor(p.printer, layoutOf(p).design)] });
}

/** حالة اللون المكتوب: صالحٌ، أو فاتحٌ لا يُقرأ (layoutAccent)، أو ليس #RRGGBB بعد */
export function accentInputState(text: string): 'ok' | 'light' | 'invalid' {
  if (!ACCENT_RE.test(text)) return 'invalid';
  return accentContrastOk(text) ? 'ok' : 'light';
}

/**
 * نصّ خانة «لون مخصص» بعد تغيّر اللون المحفوظ: لون الشركة أو لونٌ من اللوحة ⇒ فارغة؛ واللون المكتوب نفسه ⇒ كما كُتب؛ وغيره ⇒ قيمته
 * (فلا تبقى خانةٌ بلونٍ فاتحٍ مرفوض ورسالته بعد «العودة إلى تخطيط اليوم»)
 */
export function accentTextAfter(value: string | null, text: string): string {
  if (value === null || (ACCENT_PALETTE as readonly string[]).includes(value.toUpperCase())) return '';
  return text.toUpperCase() === value.toUpperCase() ? text : value;
}

const chip = (on: boolean): string =>
  `rounded-lg border px-3 py-1 text-xs font-semibold disabled:opacity-40 ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white'}`;

function Segmented<T extends string>({ label, options, labels, value, onPick, disabled }: {
  label: string; options: readonly T[]; labels: Readonly<Record<T, string>>; value: T; onPick: (v: T) => void; disabled?: (v: T) => boolean;
}) {
  const tr = useTr();
  return (
    <div role="group" aria-label={label}>
      <span className="label">{label}</span>
      <div className="flex gap-1.5 flex-wrap">
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={value === o} disabled={disabled?.(o)} onClick={() => onPick(o)} className={chip(value === o)}>{tr(labels[o])}</button>
        ))}
      </div>
    </div>
  );
}

/** حقول «التخطيط» في الخطوة الرابعة — اللوحة تلفّها في قسمها */
export function LayoutFields({ p, update }: { p: PrintProfile; update: (next: PrintProfile) => void }) {
  const tr = useTr();
  // «إزالة الضريبة» (E6): بلا ضريبة لا صفّ «رمز QR» في الترتيب (layoutSectionRows) — والسياق من اللوحة، وافتراضه false: اليوم حرفاً
  const taxOff = useTaxOffPrint();
  const [drag, setDrag] = useState<SectionId | null>(null);
  // السحب باللمس/القلم من المقبض: الصفّ المسحوب والصفّ تحت الإصبع — يُنقل عند الرفع وحده (والإلغاء يتركه)، والفأرة لسحب HTML5 كاليوم
  const [touch, setTouch] = useState<{ id: SectionId; from: number; over: number } | null>(null);
  // ▲▼ بلوحة المفاتيح: بعد النقل يعود التركيز إلى زرّ الصفّ نفسه (moveFocusTarget) فتتتابع الضغطات بلا Tab من جديد
  const orderRef = useRef<HTMLOListElement>(null);
  const refocus = useRef<{ id: SectionId; dir: 'up' | 'down' } | null>(null);
  useEffect(() => {
    const want = refocus.current;
    if (!want) return;
    refocus.current = null;
    const to = moveFocusTarget(layoutSectionRows(p, taxOff), want.id, want.dir);
    if (to) orderRef.current?.querySelector<HTMLButtonElement>(`[data-section="${want.id}"] [data-move="${to}"]`)?.focus();
  });
  if (!layoutEditable(p)) {
    return <p className="text-xs text-[#6E6557] flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" />{tr(PRINT_ISSUES.layoutClassic)}</p>;
  }
  const l = layoutOf(p);
  const custom = p.options.layout !== undefined;
  const set = (patch: Parameters<typeof withLayout>[1]) => update(withLayout(p, patch));
  const rows = layoutSectionRows(p, taxOff);
  const logoOff = !p.options.showLogo || p.template === 'impact_preprinted';
  const colorful = p.printer === 'page' && p.template === 'page_branded';
  const grid = l.design === 'grid_bilingual';
  const move = (id: SectionId, to: number) => update(moveSection(p, id, to));
  const rowAt = (y: number): number => rowIndexAtY(
    Array.from(orderRef.current?.querySelectorAll<HTMLElement>(':scope > li[data-section]') ?? []).map((el) => el.getBoundingClientRect()), y);
  const touchEnd = (commit: boolean) => {
    const t = touch;
    setTouch(null);
    const to = t && t.over >= 0 && rows[t.over] ? rows[t.over].at : -1;
    if (commit && t && to >= 0 && t.over !== t.from && canMoveSection(p, t.id, to)) move(t.id, to);
  };
  return (
    <>
      {!custom && <p className="text-[11px] text-[#6E6557] flex items-start gap-1.5" data-layout-today=""><Info size={12} className="mt-0.5 shrink-0" />{tr('بلا تغيير هنا تبقى المطبوعة كما هي اليوم حرفيا')}</p>}

      <Segmented label={tr('مكان الشعار')} options={logoChoices(p)} labels={LOGO_POSITION_LABELS} value={l.logo}
        onPick={(v) => set({ logo: v })} disabled={() => logoOff} />
      {logoOff && <p className="text-[11px] text-[#9A8F7E]">{tr('شعار الشركة مطفأ في «المحتوى»')}</p>}
      <Segmented label={tr('حجم الشعار')} options={LOGO_SIZES} labels={LOGO_SIZE_LABELS} value={l.logoSize}
        onPick={(v) => set({ logoSize: v })} disabled={() => logoOff || l.logo === 'none'} />

      {colorful
        ? <AccentPicker value={l.accent} onPick={(a) => set({ accent: a })} />
        : <p className="text-[11px] text-[#6E6557]">{tr('طباعة بالأبيض والأسود — لا أثر للون التمييز')}</p>}

      {p.printer !== 'thermal' && (
        <>
          <div role="group" aria-label={tr('حجم الخط')}>
            <span className="label">{tr('حجم الخط')}</span>
            <div className="flex gap-1.5 flex-wrap">
              {LAYOUT_FONT_SCALES.map((f) => (
                <button key={f} type="button" dir="ltr" aria-pressed={effectiveFontScale(p) === f} onClick={() => update(withLayoutFontScale(p, f))}
                  className={chip(effectiveFontScale(p) === f)}>{Math.round(f * 100)}%</button>
              ))}
            </div>
          </div>
          <Segmented label={tr('شكل الجدول')} options={TABLE_STYLES} labels={TABLE_STYLE_LABELS} value={grid ? 'grid' : l.tableStyle}
            onPick={(v) => set({ tableStyle: v })} disabled={(v) => grid && v !== 'grid'} />
          {grid && <p className="text-[11px] text-[#9A8F7E]">{tr('التصميم ثنائي اللغة بشبكة كاملة دائما')}</p>}
        </>
      )}

      <div>
        <span className="label">{tr('ترتيب الأقسام')}</span>
        <p className="text-[11px] text-[#9A8F7E] mb-1.5">{tr('اسحب لتغيير الترتيب')} — {tr('أو استعمل أزرار الرفع والخفض')}</p>
        <ol ref={orderRef} className="border border-[#E9E1D3] rounded-xl divide-y divide-[#F1EBDF]" data-section-order="">
          {rows.map((r, i) => {
            const label = tr(SECTION_LABELS[r.id]);
            const movable = r.up || r.down;
            return (
              <li key={r.id} data-section={r.id} draggable={movable}
                onDragStart={(e) => { setDrag(r.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.id); }}
                onDragEnd={() => setDrag(null)}
                onDragOver={(e) => { if (drag && drag !== r.id && canMoveSection(p, drag, r.at)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
                onDrop={(e) => { e.preventDefault(); if (drag && canMoveSection(p, drag, r.at)) move(drag, r.at); setDrag(null); }}
                className={`flex items-center gap-2 px-2.5 py-1.5 text-sm ${drag === r.id || touch?.id === r.id ? 'opacity-50' : ''} ${movable ? 'cursor-grab' : ''} ${touch && touch.over === i && touch.id !== r.id ? (canMoveSection(p, touch.id, r.at) ? 'bg-[#FBEBE2]' : 'bg-red-50') : ''}`}>
                <span data-grip="" aria-hidden="true" className="p-1 -m-1" style={movable ? { touchAction: 'none' } : undefined}
                  onPointerDown={(e) => {
                    if (!movable || e.pointerType === 'mouse') return;
                    e.preventDefault();
                    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* المتصفّح بلا التقاط: يكفي الحدث */ }
                    setTouch({ id: r.id, from: i, over: i });
                  }}
                  onPointerMove={(e) => { if (touch?.id === r.id) { const over = rowAt(e.clientY); if (over !== touch.over) setTouch({ ...touch, over }); } }}
                  onPointerUp={() => { if (touch?.id === r.id) touchEnd(true); }}
                  onPointerCancel={() => { if (touch?.id === r.id) touchEnd(false); }}>
                  <GripVertical size={14} className={movable ? 'text-[#9A8F7E]' : 'text-[#E9E1D3]'} />
                </span>
                <span className="text-[11px] text-[#9A8F7E] w-4" dir="ltr">{i + 1}</span>
                <span className="flex-1 min-w-0 text-[#1F1A13]">{label}</span>
                <button type="button" data-move="up" disabled={!r.up} onClick={() => { refocus.current = { id: r.id, dir: 'up' }; move(r.id, r.upTo); }} aria-label={`${tr('نقل لأعلى')}: ${label}`}
                  className="p-1 rounded-md text-[#6E6557] hover:bg-[#FAF7F0] disabled:opacity-30"><ArrowUp size={14} /></button>
                <button type="button" data-move="down" disabled={!r.down} onClick={() => { refocus.current = { id: r.id, dir: 'down' }; move(r.id, r.downTo); }} aria-label={`${tr('نقل لأسفل')}: ${label}`}
                  className="p-1 rounded-md text-[#6E6557] hover:bg-[#FAF7F0] disabled:opacity-30"><ArrowDown size={14} /></button>
              </li>
            );
          })}
        </ol>
        <div className="flex gap-2 flex-wrap mt-2">
          <button type="button" className="btn-secondary !py-1 !px-3 text-xs" disabled={orderIsDefault(p)} onClick={() => update(resetSectionOrder(p))}>
            <RotateCcw size={13} /> {tr('إعادة الترتيب الافتراضي')}
          </button>
          {custom && !grid && (
            <button type="button" className="btn-secondary !py-1 !px-3 text-xs" onClick={() => update(withLayout(p, null))}>
              <RotateCcw size={13} /> {tr('العودة إلى تخطيط اليوم')}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** لون التمييز: لون الشركة (null) أو لوحة جاهزة أو #RRGGBB مكتوب — والفاتح يُرسل فيرفضه layoutIssues برسالته */
function AccentPicker({ value, onPick }: { value: string | null; onPick: (v: string | null) => void }) {
  const tr = useTr();
  const inPalette = (v: string | null) => v !== null && (ACCENT_PALETTE as readonly string[]).includes(v.toUpperCase());
  const [text, setText] = useState(value !== null && !inPalette(value) ? value : '');
  // اللون تغيّر من خارج الخانة («العودة إلى تخطيط اليوم»، قالبٌ آخر) — فلا يبقى فيها لونٌ قديم ورسالة رفضٍ لما لم يعد محفوظاً
  useEffect(() => { setText((t) => accentTextAfter(value, t)); }, [value]);
  const state = accentInputState(text);
  const pickText = (raw: string) => {
    const v = raw.trim();
    setText(v);
    if (ACCENT_RE.test(v)) onPick(v.toUpperCase());
  };
  return (
    <div role="group" aria-label={tr('لون التمييز')}>
      <span className="label">{tr('لون التمييز')}</span>
      <div className="flex gap-1.5 flex-wrap items-center">
        <button type="button" aria-pressed={value === null} onClick={() => { setText(''); onPick(null); }} className={chip(value === null)}>{tr('لون الشركة')}</button>
        {ACCENT_PALETTE.map((c) => {
          const on = value !== null && value.toUpperCase() === c;
          return (
            <button key={c} type="button" aria-pressed={on} aria-label={c} title={c} onClick={() => { setText(''); onPick(c); }}
              className={`w-7 h-7 rounded-full border-2 ${on ? 'border-[#1F1A13] ring-2 ring-[#E15A30]/40' : 'border-white shadow'}`} style={{ background: c }} />
          );
        })}
      </div>
      <label className="flex items-center gap-2 mt-2">
        <span className="text-xs text-[#44403a] shrink-0">{tr('لون مخصص')}</span>
        <input className="input !py-1 max-w-[9rem]" dir="ltr" maxLength={7} placeholder="#1F2937" value={text} onChange={(e) => pickText(e.target.value)} />
        <input type="color" className="w-8 h-8 rounded border border-[#E9E1D3] bg-white" aria-label={tr('لون مخصص')}
          value={ACCENT_RE.test(text) ? text : value ?? '#1F2937'} onChange={(e) => pickText(e.target.value)} />
      </label>
      {text !== '' && state === 'light' && <p className="text-xs text-red-600 mt-1">{tr(PRINT_ISSUES.layoutAccent)}</p>}
      {text !== '' && state === 'invalid' && <p className="text-[11px] text-[#9A8F7E] mt-1" dir="ltr">#RRGGBB</p>}
    </div>
  );
}

/**
 * مخطّط «نموذج الشركة المطبوع مسبقاً»: ورقة الشركة الجاهزة بإطاراتها الباهتة (المطبوع مسبقاً) وعليها القيم وحدها داكنةً في فراغاتها —
 * رأس المستند، والطرفان، وصفوف الأصناف، والإجمالي، ومربع الرمز (لا مربع رمزٍ لشركةٍ بلا ضريبة)
 */
export function FormThumb({ taxOff = false }: { taxOff?: boolean }) {
  const faint = '1px dashed #C9BCA6';
  const ink = (w: string, ml = 0) => <span className="block" style={{ height: 2, width: w, marginInlineStart: ml, background: '#1F1A13' }} />;
  return (
    <span aria-hidden="true" data-thumb="preprinted" className="shrink-0 block relative bg-white border border-[#D8CDB9] rounded-md overflow-hidden" style={{ width: 56, height: 72, padding: 4 }}>
      <span className="block mx-auto rounded-sm" style={{ width: 30, height: 6, border: faint }} />
      <span className="block mt-[3px] space-y-[2px]" style={{ border: faint, padding: 2 }}>{ink('40%', 10)}{ink('30%', 10)}</span>
      <span className="flex gap-[2px] mt-[2px]">
        <span className="block flex-1" style={{ border: faint, padding: 2 }}>{ink('70%')}</span>
        <span className="block flex-1" style={{ border: faint, padding: 2 }}>{ink('60%')}</span>
      </span>
      <span className="block mt-[2px] space-y-[3px]" style={{ border: faint, padding: '2px 2px 4px' }}>
        {Array.from({ length: 3 }, (_, i) => <span key={i} className="flex gap-[3px]">{ink('6px')}{ink('16px')}{ink('8px')}</span>)}
      </span>
      <span className="flex items-end justify-between mt-[2px]">
        {!taxOff ? <span className="block" style={{ width: 8, height: 8, background: 'repeating-conic-gradient(#000 0 25%, #fff 0 50%) 0 0 / 3px 3px' }} /> : <span />}
        <span className="block" style={{ border: faint, padding: 2, width: 22 }}>{ink('80%')}</span>
      </span>
    </span>
  );
}

/** مخطّط «كلاسيكي بإطارات — ثنائي اللغة»: ترويسة بلغتين وشعار في الوسط، صندوق المستند ورمزه، صندوقا البائع والمشتري، جدول بشبكة، الإجماليات، التواقيع */
export function GridThumb({ taxOff = false }: { taxOff?: boolean }) {
  const box = { border: '1px solid #1F1A13', display: 'block' } as const;
  const bar = (w: string) => <span className="block" style={{ height: 2, width: w, background: '#1F1A13', marginTop: 2 }} />;
  return (
    <span aria-hidden="true" data-thumb="grid_bilingual" className="shrink-0 block bg-white border border-[#D8CDB9] rounded-md overflow-hidden" style={{ width: 56, height: 72, padding: 4 }}>
      <span className="flex items-start justify-between" style={{ borderBottom: '1px solid #1F1A13', paddingBottom: 2 }}>
        <span className="block" style={{ width: 16 }}>{bar('100%')}{bar('70%')}</span>
        <span className="block rounded-full" style={{ width: 9, height: 9, border: '1px solid #1F1A13' }} />
        <span className="block" style={{ width: 16 }}>{bar('100%')}{bar('70%')}</span>
      </span>
      <span className="flex gap-[2px] mt-[3px]">
        <span style={{ ...box, flex: 1, height: 9 }} />
        {/* «إزالة الضريبة» (E6): بلا مربع الرمز لشركةٍ بلا ضريبة */}
        {!taxOff && <span className="block" style={{ width: 9, height: 9, background: 'repeating-conic-gradient(#000 0 25%, #fff 0 50%) 0 0 / 3px 3px' }} />}
      </span>
      <span className="flex gap-[2px] mt-[2px]">
        <span style={{ ...box, flex: 1, height: 8 }} />
        <span style={{ ...box, flex: 1, height: 8 }} />
      </span>
      <span className="grid grid-cols-4 mt-[2px]" style={{ border: '1px solid #1F1A13' }}>
        {Array.from({ length: 12 }, (_, i) => <span key={i} className="block" style={{ height: 4, borderInlineStart: i % 4 ? '1px solid #1F1A13' : undefined, borderTop: i > 3 ? '1px solid #1F1A13' : undefined, background: i < 4 ? '#D8CDB9' : undefined }} />)}
      </span>
      <span className="flex justify-end mt-[2px]"><span style={{ ...box, width: 22, height: 7 }} /></span>
      <span className="grid grid-cols-4 gap-[2px] mt-[3px]">
        {Array.from({ length: 4 }, (_, i) => <span key={i} className="block" style={{ height: 1, background: '#1F1A13' }} />)}
      </span>
    </span>
  );
}
