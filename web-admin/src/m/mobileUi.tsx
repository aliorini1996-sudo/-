import { ReactNode } from 'react';
import { ArrowRight, AlertTriangle, Inbox } from 'lucide-react';
import { useTr } from '../i18n/strings';

/**
 * لبنات واجهة تطبيق الإدارة على الجوال.
 *
 * لماذا لبنات جديدة بدل أصناف `.card` و`.stat-card` من `index.css`:
 * تلك مضبوطة لسطح المكتب (`p-5` + ظلّ + حدّ)، واستعمالها هنا يعطي مظهراً
 * مغايراً لتطبيق المندوب — والمطلوب **مماثلة تامّة** له لا شبهاً. فالبطاقات
 * هنا `rounded-2xl` بحدّ خفيف بلا ظلّ، تماماً كبطاقات `RepApp`.
 *
 * وكل هدف لمس ≥ 44px: التطبيق يُستعمل بإبهام واحد في السيارة أو المستودع.
 */

const CARD = 'bg-white rounded-2xl border border-[#F1EBDF]';

export function MCard({ children, className = '', onClick }: {
  children: ReactNode; className?: string; onClick?: () => void;
}) {
  if (onClick) {
    return (
      <button type="button" onClick={onClick}
        className={`${CARD} w-full text-start active:bg-[#FAF7F0] transition-colors ${className}`}>
        {children}
      </button>
    );
  }
  return <div className={`${CARD} ${className}`}>{children}</div>;
}

/** بطاقة رقم — عمودية لا أفقية: العرض على 360px لا يحتمل أيقونةً بجانب النصّ */
export function MStat({ label, value, tone = 'default', icon: Icon }: {
  label: string; value: string; tone?: 'default' | 'good' | 'warn' | 'bad';
  icon?: React.ElementType;
}) {
  const color = tone === 'good' ? 'text-[#2F855A]'
    : tone === 'warn' ? 'text-[#B7791F]'
    : tone === 'bad' ? 'text-[#C0392B]'
    : 'text-[#1F1A13]';
  return (
    <div className={`${CARD} p-3.5`}>
      <div className="flex items-center gap-1.5 text-[11px] text-[#9A8F7E] mb-1">
        {Icon && <Icon size={13} />}
        <span className="truncate">{label}</span>
      </div>
      <p className={`text-lg font-bold ${color} truncate`} dir="auto">{value}</p>
    </div>
  );
}

/** صفّ قائمة قابل للنقر — الارتفاع الأدنى 56px (هدف لمس مريح) */
export function MRow({ title, subtitle, trailing, leading, onClick }: {
  title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; leading?: ReactNode;
  onClick?: () => void;
}) {
  const inner = (
    <div className="flex items-center gap-3 px-3.5 py-3 min-h-[56px]">
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-[#1F1A13] truncate">{title}</span>
        {subtitle && <span className="block text-[11px] text-[#9A8F7E] truncate mt-0.5">{subtitle}</span>}
      </span>
      {trailing}
    </div>
  );
  if (!onClick) return <div className="border-b border-[#F1EBDF] last:border-0">{inner}</div>;
  return (
    <button type="button" onClick={onClick}
      className="w-full text-start border-b border-[#F1EBDF] last:border-0 active:bg-[#FAF7F0] transition-colors">
      {inner}
    </button>
  );
}

/** ترويسة شاشة فرعية ملء الشاشة (بزرّ رجوع) */
export function MHeader({ title, subtitle, onBack, action }: {
  title: string; subtitle?: string; onBack: () => void; action?: ReactNode;
}) {
  return (
    <div className="flex-shrink-0 bg-[#1F1A13] text-white px-3 py-3 flex items-center gap-2">
      <button onClick={onBack} className="p-2 -m-1 text-[#9A8F7E] hover:text-white" aria-label="رجوع">
        <ArrowRight size={20} />
      </button>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold truncate">{title}</span>
        {subtitle && <span className="block text-[11px] text-[#9A8F7E] truncate">{subtitle}</span>}
      </span>
      {action}
    </div>
  );
}

/** حالة فراغ تملأ الارتفاع — لا كتلة صغيرة تائهة وسط شاشة فارغة */
export function MEmpty({ text, icon: Icon = Inbox }: { text: string; icon?: React.ElementType }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-[#9A8F7E] px-8 text-center">
      <Icon size={34} className="opacity-40" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

/** حالة خطأ بزرّ إعادة محاولة كبير (هدف لمس، لا رابط صغير) */
export function MError({ onRetry, text }: { onRetry?: () => void; text?: string }) {
  const tr = useTr();
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
      <AlertTriangle size={34} className="text-[#C0392B] opacity-70" />
      <p className="text-sm text-[#6E6557]">{text || tr('تعذّر تحميل البيانات')}</p>
      {onRetry && (
        <button onClick={onRetry}
          className="bg-[#E15A30] text-white font-bold px-6 py-3 rounded-xl min-h-[44px]">
          {tr('إعادة المحاولة')}
        </button>
      )}
    </div>
  );
}

export function MSpinner({ text }: { text?: string }) {
  const tr = useTr();
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-[#9A8F7E]">
      <span className="w-7 h-7 border-2 border-[#E9E1D3] border-t-[#E15A30] rounded-full animate-spin" />
      <p className="text-xs">{text || tr('جاري التحميل...')}</p>
    </div>
  );
}

/** غلاف شاشة: ترويسة ثابتة + جسم يُمرَّر وحده (لا تمرير للصفحة كلّها) */
export function MScreen({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full flex flex-col">
      {header}
      <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </div>
  );
}
