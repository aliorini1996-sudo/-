import { forwardRef } from 'react';
import { BrandIcon } from '../components/BrandLogo';

/**
 * مستند عرض السعر — **مصدرٌ واحد** لصفحة الإصدار (`/q-fs7k2m`) ولمعاينة لوحة المالك،
 * فما يراه المالك في السجلّ هو حرفياً ما وصل العميل.
 *
 * العربية هنا ثابتة لا `tr()`: المستند نفسه عربيّ بتصميمه.
 */

/**
 * الأسعار المعتمدة — **شاملة الضريبة** (المنشأة مسجّلة في ضريبة القيمة المضافة).
 * `total` شهريّ، و`yearly` سعر السنة المعتمد (عشرة أشهر: شهران مجاناً — قرار المالك).
 * ⚠️ يطابق كتالوج الخادم backend/src/services/quotes.ts حرفياً (اختبارٌ يُفشل البناء عند الافتراق).
 */
export const PACKAGES = [
  { id: 'starter', name: 'المبتدئة', total: 299, yearly: 2990, limit: 'حتى ٥ مناديب ومستخدم إداري واحد' },
  { id: 'growth', name: 'المتوسطة', total: 399, yearly: 3990, limit: 'حتى ١٠ مناديب ومستخدمَين إداريَّين' },
  { id: 'pro', name: 'المتقدمة', total: 599, yearly: 5990, limit: 'حتى ٢٠ مندوباً و٥ مستخدمين إداريين', badge: 'الأكثر طلباً' },
] as const;
export type PackageId = (typeof PACKAGES)[number]['id'];

export const VAT = 0.15;
/** صلاحية العرض بالأيام — كما في نصّ الشروط بملفّ الوورد */
export const VALID_DAYS = 10;
/** سقف النصّ الإضافيّ — يُبقي المستند صفحةً واحدة مقروءة بلا تصغيرٍ ظاهر (والخادم يطابقه) */
export const NOTE_MAX = 500;

const INCLUDED = [
  'تطبيق مندوب ميدانيّ (أندرويد / iOS / ويب).',
  'التتبّع المباشر (GPS) وتسجيل الزيارات الميدانية على الخريطة.',
  'تقارير شاملة: أداء المناديب، مديونيات العملاء، ساعات العمل، والمبيعات.',
  'لوحة إدارة ويب كاملة + تطبيق لسطح المكتب (ويندوز).',
  'دعم فنّي.',
];

const r2 = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* الضريبة **تُستخرَج من السعر لا تُضاف إليه**: ٢٩٩ و٢٩٩٠ شاملتان أصلاً، والصافي يُشتقّ
 * من الإجمالي مباشرةً فلا ينحرف فلسٌ بالتقريب.
 * (الخادم يشتقّ الأرقام نفسها بالهللات — backend/src/services/quotes.ts) */
export function quoteFigures(total: number) {
  const net = r2(total / (1 + VAT));
  return { total, net, vat: r2(total - net) };
}

/** أجزاء التاريخ بتوقيت الرياض — الرقم والتاريخ واحدٌ على جوال الموظّف وفي لوحة المالك */
function riyadhParts(d: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === t)?.value ?? '00';
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour'), min: g('minute'), s: g('second') };
}

export const dmy = (d: Date) => { const p = riyadhParts(d); return `${p.d} / ${p.m} / ${p.y}`; };

/** رقمٌ مؤقّت لعرضٍ أُصدر بلا اتصال — عشر خانات تميّزه عن تسلسل الخادم (FS-QT-2026-0007) */
export function localQuoteNo(d: Date) {
  const p = riyadhParts(d);
  return `FS-QT-${p.y}-${p.m}${p.d}${p.h}${p.min}${p.s}`;
}

export interface QuoteMeta { no: string; date: string; valid: string }

export function docMeta(no: string, issuedAt: Date, validDays: number): QuoteMeta {
  return { no, date: dmy(issuedAt), valid: dmy(new Date(issuedAt.getTime() + validDays * 86_400_000)) };
}

/* ═══════════════════════ المستند ═══════════════════════ */

const ACCENT = '#E15A30';
const INK = '#1F1A13';
const MUTED = '#6E6557';
const LINE = '#E9E1D3';

export interface QuoteDocProps {
  company: string;
  unifiedNo: string;
  presenter: string;
  note: string;
  /** `total` السعر الشهريّ و`yearly` سعر السنة — كلاهما شامل */
  pkg: { name: string; limit: string; total: number; yearly: number; badge?: string };
  yearly: boolean;
  figures: { total: number; net: number; vat: number };
  meta: QuoteMeta;
  validDays: number;
}

export const QuoteDocument = forwardRef<HTMLDivElement, QuoteDocProps>(
  ({ company, unifiedNo, presenter, note, pkg, yearly, figures, meta, validDays }, ref) => {
  const th: React.CSSProperties = { background: INK, color: '#fff', padding: '10px 8px', fontSize: 12, fontWeight: 700, textAlign: 'center' };
  const td: React.CSSProperties = { padding: '12px 8px', fontSize: 13, textAlign: 'center', borderBottom: `1px solid ${LINE}` };
  return (
    <div ref={ref} dir="rtl" style={{
      width: 794, minHeight: 1123, background: '#fff', color: INK, padding: '44px 54px 34px',
      fontFamily: "'IBM Plex Sans Arabic', 'Noto Sans Arabic', Tahoma, sans-serif", boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', textAlign: 'right',
    }}>
      {/* الترويسة */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `3px solid ${ACCENT}`, paddingBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <BrandIcon size={54} radius={0.28} />
          <div>
            <div style={{ fontFamily: "'IBM Plex Serif', serif", fontSize: 24, fontWeight: 700, direction: 'ltr' }}>
              <span style={{ color: INK }}>Field</span> <span style={{ color: ACCENT }}>Sales</span>
            </div>
            <div style={{ fontSize: 12, color: MUTED }}>منصّة إدارة المبيعات الميدانية والتوزيع</div>
          </div>
        </div>
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: ACCENT }}>عرض سعر</div>
          <div style={{ fontSize: 11, letterSpacing: 3, color: MUTED }}>QUOTATION</div>
        </div>
      </div>

      {/* بيانات العرض + المُقدَّم إليه */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, marginTop: 22 }}>
        <div style={{ flex: 1, background: '#FAF7F0', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, color: MUTED, marginBottom: 6 }}>مُقدَّم إلى</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{company || '—'}</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
            الرقم الموحد: <span style={{ direction: 'ltr', unicodeBidi: 'embed', color: INK }}>{unifiedNo || '—'}</span>
          </div>
        </div>
        <div style={{ fontSize: 12, lineHeight: 2, minWidth: 210 }}>
          <div>رقم العرض: <b style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{meta.no}</b></div>
          <div>التاريخ: <b style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{meta.date}</b></div>
          <div>صالح حتى: <b style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{meta.valid}</b></div>
          {presenter && <div>مقدّم العرض: <b>{presenter}</b></div>}
        </div>
      </div>

      <p style={{ fontSize: 13, lineHeight: 1.9, color: INK, marginTop: 22 }}>
        يسعدنا في Field Sales أن نقدّم لكم عرض السعر التالي لاشتراك منصّتنا في إدارة فريق المبيعات
        الميداني والتوزيع — بأسعارٍ معلنة وشفّافة، وتفعيلٍ فوريّ، ودعمٍ عربيّ مباشر.
      </p>

      {/* جدول الباقة */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 18 }}>
        <thead>
          <tr>
            <th style={{ ...th, borderTopRightRadius: 8 }}>الباقة</th>
            <th style={th}>الحدّ الأقصى</th>
            <th style={th}>{yearly ? 'السعر السنوي (ر.س)' : 'السعر الشهري (ر.س)'}</th>
            <th style={th}>ض.ق.م ١٥٪</th>
            <th style={{ ...th, borderTopLeftRadius: 8 }}>{yearly ? 'الإجمالي السنوي' : 'الإجمالي الشهري'}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ ...td, fontWeight: 700 }}>
              {pkg.name}
              {pkg.badge && (
                <div style={{ fontSize: 10, color: ACCENT, fontWeight: 600, marginTop: 2 }}>{pkg.badge}</div>
              )}
            </td>
            <td style={{ ...td, fontSize: 12 }}>{pkg.limit}</td>
            <td style={{ ...td, direction: 'ltr' }}>{money(figures.net)}</td>
            <td style={{ ...td, direction: 'ltr' }}>{money(figures.vat)}</td>
            <td style={{ ...td, fontWeight: 800, color: ACCENT, fontSize: 15 }}>
              <span style={{ direction: 'ltr', unicodeBidi: 'embed' }}>{money(figures.total)}</span> ريال
            </td>
          </tr>
        </tbody>
      </table>
      <CycleNote pkg={pkg} yearly={yearly} />

      {note && (
        <div style={{ marginTop: 20, background: '#FBEBE2', borderRadius: 10, padding: '12px 16px' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT, marginBottom: 4 }}>ملاحظات</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.85, color: INK, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note}</div>
        </div>
      )}

      <Block title="ما تشمله جميع الباقات" items={INCLUDED} />
      <Block title="الشروط والأحكام" items={[
        `هذا العرض صالحٌ لمدّة ${validDays} أيام من تاريخه.`,
        yearly
          ? 'الاشتراك سنويّ ويُجدَّد تلقائياً ما لم يُطلب إيقافه، ويمكن الترقية في أي وقت.'
          : 'الاشتراك شهريّ ويُجدَّد تلقائياً ما لم يُطلب إيقافه، ويمكن الترقية أو التخفيض في أي وقت.',
        'الأسعار شاملة ضريبة القيمة المضافة ١٥٪.',
        'الدفع عبر تحويل بنكيّ؛ تُرسَل تفاصيل الحساب عند تأكيد الطلب.',
      ]} />

      <div style={{ marginTop: 'auto', borderTop: `1px solid ${LINE}`, paddingTop: 12, textAlign: 'center', fontSize: 12, color: MUTED, direction: 'ltr' }}>
        Field Sales · fieldsa.net · help@fieldsa.net
      </div>
    </div>
  );
});
QuoteDocument.displayName = 'QuoteDocument';

/** معلومة السعر الأخرى: السنويّ يُقارَن بالشهريّ، والشهريّ يُعرَض عليه خيار السنة وتوفيره */
function CycleNote({ pkg, yearly }: { pkg: QuoteDocProps['pkg']; yearly: boolean }) {
  const monthly12 = pkg.total * 12;
  const saving = monthly12 - pkg.yearly;
  if (saving <= 0) return null;
  const freeMonths = saving / pkg.total;
  const free = freeMonths === 2 ? 'أي شهران مجاناً' : Number.isInteger(freeMonths) ? `أي ${freeMonths} أشهر مجاناً` : '';
  const riyal = (n: number) => <span style={{ direction: 'ltr', unicodeBidi: 'embed', fontWeight: 700 }}>{money(n)}</span>;
  return (
    <div style={{ marginTop: 10, border: `1px dashed ${ACCENT}`, borderRadius: 8, padding: '8px 12px', fontSize: 12, lineHeight: 1.8, color: INK }}>
      {yearly ? (
        <>السعر السنوي {riyal(pkg.yearly)} ريال بدلاً من {riyal(monthly12)} ريال عند السداد الشهري ({pkg.total} × ١٢) — توفير {riyal(saving)} ريال{free && `، ${free}`}.</>
      ) : (
        <>خيار السداد السنوي: {riyal(pkg.yearly)} ريال سنوياً شاملة الضريبة بدلاً من {riyal(monthly12)} ريال — توفير {riyal(saving)} ريال{free && `، ${free}`}.</>
      )}
    </div>
  );
}

function Block({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: INK, borderRight: `4px solid ${ACCENT}`, paddingRight: 10, marginBottom: 10 }}>
        {title}
      </div>
      {items.map((t, i) => (
        <div key={i} style={{ fontSize: 12.5, lineHeight: 1.8, color: INK, display: 'flex', gap: 8 }}>
          <span style={{ color: ACCENT }}>•</span><span>{t}</span>
        </div>
      ))}
    </div>
  );
}

/** لقطة سجلٍّ من الخادم ⇐ خصائص المستند (المبالغ بالهللات تُردّ ريالات) */
export interface IssuedQuoteRow {
  id: string;
  quoteNo: string;
  issuedAt: string;
  company: string;
  unifiedNo: string;
  packageId: string;
  packageName: string;
  packageLimit: string;
  monthlyHalalas: number;
  yearlyHalalas: number;
  cycle: string;
  totalHalalas: number;
  netHalalas: number;
  vatHalalas: number;
  presenter: string | null;
  note: string | null;
  validDays: number;
  /** صدر برقمٍ مؤقّت من الجوال بلا تسجيلٍ لحظتها */
  offline: boolean;
}

export function rowToDocProps(r: IssuedQuoteRow): QuoteDocProps {
  const badge = PACKAGES.find(p => p.id === r.packageId);
  return {
    company: r.company,
    unifiedNo: r.unifiedNo,
    presenter: r.presenter ?? '',
    note: r.note ?? '',
    pkg: {
      name: r.packageName, limit: r.packageLimit, total: r.monthlyHalalas / 100, yearly: r.yearlyHalalas / 100,
      badge: badge && 'badge' in badge ? badge.badge : undefined,
    },
    yearly: r.cycle === 'yearly',
    figures: { total: r.totalHalalas / 100, net: r.netHalalas / 100, vat: r.vatHalalas / 100 },
    meta: docMeta(r.quoteNo, new Date(r.issuedAt), r.validDays),
    validDays: r.validDays,
  };
}
