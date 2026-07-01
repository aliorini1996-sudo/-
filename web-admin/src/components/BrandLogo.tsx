// شعار منصّة FieldSales — رمز «المسار الصاعد» مطابق لدليل الهوية الرسمي

// الأيقونة المربّعة (مربع مرجاني + مسار التوزيع الصاعد + نقاط)
export function BrandIcon({ size = 40, radius = 0.233 }: { size?: number; radius?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
      <rect x="0" y="0" width="120" height="120" rx={120 * radius} fill="#E15A30" />
      <line x1="32" y1="88" x2="88" y2="32" stroke="#1F1A13" strokeWidth="15" strokeLinecap="round" />
      <circle cx="32" cy="88" r="10" fill="#FAF7F0" />
      <circle cx="60" cy="60" r="8" fill="#FAF7F0" />
      <circle cx="88" cy="32" r="13" fill="#1F1A13" />
      <circle cx="88" cy="32" r="7" fill="#FAF7F0" />
    </svg>
  );
}

// الرمز المعكوس بلا خلفية — للاستخدام على الخلفيات الداكنة (مسار مرجاني)
export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
      <line x1="32" y1="88" x2="88" y2="32" stroke="#E15A30" strokeWidth="15" strokeLinecap="round" />
      <circle cx="32" cy="88" r="10" fill="#FAF7F0" />
      <circle cx="60" cy="60" r="8" fill="#FAF7F0" />
      <circle cx="88" cy="32" r="13" fill="#E15A30" />
      <circle cx="88" cy="32" r="7" fill="#1F1A13" />
    </svg>
  );
}

// الاسم اللفظي FieldSales — Field (حبر) + Sales (مرجاني)
export function BrandWordmark({
  iconSize = 44, dark = false, subtitle = 'إدارة مبيعات المناديب', showSubtitle = true,
}: { iconSize?: number; dark?: boolean; subtitle?: string; showSubtitle?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <BrandIcon size={iconSize} />
      <div className="leading-tight">
        <div style={{ fontFamily: "'IBM Plex Serif', serif", fontWeight: 600, fontSize: iconSize * 0.5, letterSpacing: '-0.3px' }}>
          <span style={{ color: dark ? '#FAF7F0' : '#1F1A13' }}>Field</span>
          <span style={{ color: '#E15A30' }}> Sales</span>
        </div>
        {showSubtitle && (
          <div style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif", fontSize: iconSize * 0.27, color: dark ? '#9A8F7E' : '#6E6557', marginTop: 2 }}>{subtitle}</div>
        )}
      </div>
    </div>
  );
}
