import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTr } from '../../i18n/strings';
import {
  PRINT_SAMPLE_WATERMARK, STAMPED_QR_CELLS, geometry, pageQrModuleMm, qrPlan, type PrintProfile,
} from '../../lib/print/printSettings';

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

export default function PrintPreview({ profile, companyName, brandColor }: { profile: PrintProfile; companyName: string; brandColor: string }) {
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
  const basePx = (profile.printer === 'impact' ? 12 : raster ? 11 : 10.5) * o.fontScale;

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

          <div ref={contentRef} style={contentStyle}>
            {raster
              ? <RollOrImpactSample profile={profile} companyName={companyName} qrMm={qrMm} qrCells={qrCells} tr={tr} />
              : <PageSample profile={profile} companyName={companyName} brandColor={mono ? '#000' : brandColor} mono={mono} qrMm={qrMm} qrCells={qrCells} tr={tr} />}
          </div>

          {/* العلامة المائية — كل معاينة واختبار «ليس مستندا ضريبيا» */}
          <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span style={{ transform: 'rotate(-28deg)', color: 'rgba(225,90,48,0.32)', fontWeight: 800, fontSize: Math.max(13, paperW / 13), whiteSpace: 'nowrap' }}>
              {tr(PRINT_SAMPLE_WATERMARK)}
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

function RollOrImpactSample({ profile, companyName, qrMm, qrCells, tr }: { profile: PrintProfile; companyName: string; qrMm: number; qrCells: number; tr: Tr }) {
  const o = profile.options;
  const t = profile.template;
  const detailed = t === 'roll_detailed' || profile.printer === 'impact';
  const logo = o.showLogo && t !== 'impact_preprinted' && t !== 'roll_classic';
  return (
    <div>
      {logo && <div style={{ margin: '0 auto 4px', width: 44, height: 22, border: '1.5px solid #000', fontSize: '0.75em', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{tr('شعار الشركة')}</div>}
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '1.25em' }}>{companyName}</div>
      <div style={{ textAlign: 'center', fontSize: '0.9em' }}>{tr('الرقم الضريبي')} <span dir="ltr">300000000000003</span></div>
      {o.showContact && <div style={{ textAlign: 'center', fontSize: '0.9em' }}>{tr('العنوان')} · <span dir="ltr">0500000000</span></div>}
      <Sep />
      <div style={{ textAlign: 'center', fontWeight: 700 }}>{tr('فاتورة ضريبية مبسطة')}</div>
      {o.copyLabels && <div style={{ textAlign: 'center', fontSize: '0.85em' }}>{tr('الأصل')}</div>}
      <Sep />
      <Row a={tr('رقم')} b="INV-1024" />
      <Row a={tr('التاريخ')} b="23/10/2026 10:30" />
      {o.showRepName && <Row a={tr('المندوب')} b={tr('مندوب تجريبي')} />}
      <Row a={tr('العميل')} b={tr('عميل نقدي')} />
      <Sep />
      {detailed ? (
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
      <Row a={tr('المجموع قبل الضريبة')} b="100.00" />
      <Row a={`${tr('ضريبة القيمة المضافة')} 15%`} b="15.00" />
      <Row a={tr('الإجمالي')} b="115.00" bold />
      {o.showSignatures && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          {['توقيع المستلم', 'توقيع المندوب'].map((l) => (
            <div key={l} style={{ flex: 1, borderTop: '1px solid #000', paddingTop: 2, marginTop: 18, textAlign: 'center', fontSize: '0.8em' }}>{tr(l)}</div>
          ))}
        </div>
      )}
      <QrSlot mm={qrMm} cells={qrCells} tr={tr} />
      <div style={{ textAlign: 'center', fontSize: '0.9em' }}>{o.footerText ?? tr('شكرا لتعاملكم معنا')}</div>
    </div>
  );
}

function PageSample({ profile, companyName, brandColor, mono, qrMm, qrCells, tr }: { profile: PrintProfile; companyName: string; brandColor: string; mono: boolean; qrMm: number; qrCells: number; tr: Tr }) {
  const o = profile.options;
  const rule = mono ? '1.5px solid #000' : `2px solid ${brandColor}`;
  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 6, borderBottom: rule }}>
        {o.showLogo && <div style={{ width: 54, height: 54, border: mono ? '1.5px solid #000' : `1.5px solid ${brandColor}`, borderRadius: 6, fontSize: '0.8em', display: 'flex', alignItems: 'center', justifyContent: 'center', color: mono ? '#000' : brandColor }}>{tr('شعار الشركة')}</div>}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: '1.5em', color: mono ? '#000' : brandColor }}>{companyName}</div>
          <div>{tr('الرقم الضريبي')} <span dir="ltr">300000000000003</span></div>
          {o.showContact && <div>{tr('العنوان')} · <span dir="ltr">0500000000</span></div>}
        </div>
        <div style={{ fontWeight: 800, fontSize: '1.3em' }}>{tr('فاتورة ضريبية مبسطة')}</div>
      </div>
      {o.copyLabels && <div style={{ textAlign: 'center', marginTop: 4 }}>{tr('الأصل')}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 16px', margin: '8px 0' }}>
        <Row a={tr('رقم')} b="INV-1024" />
        <Row a={tr('التاريخ')} b="23/10/2026 10:30" />
        <Row a={tr('العميل')} b={tr('عميل نقدي')} />
        {o.showRepName && <Row a={tr('المندوب')} b={tr('مندوب تجريبي')} />}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
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
      </table>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Row a={tr('المجموع قبل الضريبة')} b="100.00" />
          <Row a={`${tr('ضريبة القيمة المضافة')} 15%`} b="15.00" />
          <Row a={tr('الإجمالي')} b="115.00" bold />
        </div>
        <QrSlot mm={qrMm} cells={qrCells} tr={tr} />
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
