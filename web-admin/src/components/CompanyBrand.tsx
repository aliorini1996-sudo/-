import { useEffect, useState } from 'react';
import { BrandIcon } from './BrandLogo';

/**
 * علامة رأس التطبيق لحساب الشركة — لوحة التحكم (الشريط الجانبي)، وتطبيق الإدارة على الجوال،
 * وتطبيق المندوب.
 *
 * إن رفعت الشركة شعارها من «إعدادات الشركة» يظهر **الشعار نفسه** (حقل `logo` الذي تُطبع به
 * الفواتير والسندات) مع اسم الشركة، وتبقى «Field Sales» سطراً صغيراً تحته. وبلا شعار — أو
 * بصورةٍ تالفة — تبقى علامة Field Sales كما كانت.
 */

/** شعارٌ صالح للعرض: صورة base64 كما يحفظها رافع الإعدادات، أو رابط https */
export const isLogoSrc = (v: unknown): v is string =>
  typeof v === 'string' && (/^data:image\/[a-z0-9.+-]+;base64,/i.test(v) || /^https:\/\//i.test(v));

interface Props {
  logo?: string | null;
  companyName?: string | null;
  /** `sidebar` للشريط الجانبي في لوحة التحكم، و`bar` لشريط الجوال العلوي */
  variant?: 'sidebar' | 'bar';
  /** الشريط الجانبي المطويّ: الشعار وحده */
  collapsed?: boolean;
  /** سطرٌ فرعيّ حين لا شعار (اسم الشركة تحت Field Sales) — يُخفى إن كان فارغاً */
  fallbackSubtitle?: string | null;
}

const Wordmark = ({ className }: { className: string }) => (
  <span className={className} style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }}>
    <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
  </span>
);

export default function CompanyBrand({ logo, companyName, variant = 'sidebar', collapsed = false, fallbackSubtitle }: Props) {
  const [broken, setBroken] = useState(false);
  // شعارٌ جديد بعد الحفظ يُجرَّب من جديد ولو تعطّل السابق
  useEffect(() => { setBroken(false); }, [logo]);

  const size = variant === 'sidebar' ? 36 : 28;
  const showLogo = isLogoSrc(logo) && !broken;
  const name = (companyName || '').trim();

  if (!showLogo) {
    return (
      <span className="flex items-center gap-2.5 min-w-0">
        <BrandIcon size={variant === 'sidebar' ? 36 : 26} radius={variant === 'sidebar' ? 0.28 : 0.3} />
        {!collapsed && (
          <span className="min-w-0">
            <Wordmark className="block text-sm leading-tight" />
            {fallbackSubtitle && (
              <span className={`block text-[#9A8F7E] truncate ${variant === 'sidebar' ? 'text-xs max-w-[150px]' : 'text-[10px]'}`}>
                {fallbackSubtitle}
              </span>
            )}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2.5 min-w-0">
      {/* خلفيةٌ بيضاء: أغلب الشعارات مصمَّمة لخلفية فاتحة، والشريط داكن */}
      <span className="bg-white rounded-lg flex items-center justify-center overflow-hidden flex-shrink-0 shadow-sm"
        style={{ width: size, height: size, padding: Math.round(size * 0.08) }}>
        <img src={logo as string} alt={name} className="w-full h-full object-contain" onError={() => setBroken(true)} />
      </span>
      {!collapsed && (
        <span className="min-w-0">
          <span className={`block text-[#FAF7F0] font-bold leading-tight truncate ${variant === 'sidebar' ? 'text-sm max-w-[150px]' : 'text-sm'}`}>
            {name || <Wordmark className="" />}
          </span>
          {name && <Wordmark className="block text-[10px] leading-tight opacity-80" />}
        </span>
      )}
    </span>
  );
}
