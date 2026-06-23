// شعار منصّة FieldSales — أيقونة F + اسم، بهوية موحّدة عبر كل الواجهات

export function BrandIcon({ size = 40, radius = 0.22 }: { size?: number; radius?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="fsBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f72d8" />
          <stop offset="1" stopColor="#13284a" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx={512 * radius} fill="url(#fsBg)" />
      <g fill="#4aa3ff">
        <rect x="118" y="190" width="96" height="28" rx="14" />
        <rect x="118" y="250" width="128" height="28" rx="14" />
        <rect x="118" y="310" width="80" height="28" rx="14" />
      </g>
      <g fill="#ffffff">
        <rect x="292" y="148" width="50" height="216" rx="16" />
        <rect x="292" y="148" width="122" height="50" rx="16" />
        <rect x="292" y="232" width="94" height="46" rx="14" />
      </g>
    </svg>
  );
}

// الشعار الكامل: الأيقونة + الاسم (FieldSales) + سطر فرعي اختياري
export function BrandWordmark({
  iconSize = 42, dark = false, subtitle = 'إدارة مبيعات المناديب', showSubtitle = true,
}: { iconSize?: number; dark?: boolean; subtitle?: string; showSubtitle?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <BrandIcon size={iconSize} />
      <div className="leading-tight">
        <div className="font-extrabold tracking-tight" style={{ fontSize: iconSize * 0.5 }}>
          <span style={{ color: dark ? '#ffffff' : '#0d2440' }}>Field</span>
          <span style={{ color: dark ? '#38bdf8' : '#2563eb' }}>Sales</span>
        </div>
        {showSubtitle && (
          <div style={{ fontSize: iconSize * 0.26, color: dark ? '#94a3b8' : '#64748b' }}>{subtitle}</div>
        )}
      </div>
    </div>
  );
}
