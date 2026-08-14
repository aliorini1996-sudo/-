import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

export interface HistPoint { t: string; total: number; reps: number; admins: number }

/**
 * مؤشّر «الزيارات الحية» عبر الوقت — **محمَّل كسولاً وحده** لعزل حزمة recharts
 * الثقيلة عن إقلاع لوحة المالك (تُحمَّل فقط عند فتح اللوحة ورؤية منحنى).
 *
 * bucket يحدّد تنسيق المحور الأفقيّ: خام (ساعة:دقيقة) · بالساعة (يوم ساعة) · باليوم (شهر/يوم).
 */
export default function LiveHistoryChart({ points, bucket }: { points: HistPoint[]; bucket: string }) {
  const fmtX = (iso: string): string => {
    const d = new Date(iso);
    if (bucket === 'day') return d.toLocaleDateString('ar', { month: '2-digit', day: '2-digit' });
    if (bucket === 'hour') return d.toLocaleString('ar', { day: '2-digit', hour: '2-digit' });
    return d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  };
  const fmtFull = (iso: string): string => {
    const d = new Date(iso);
    const date = d.toLocaleDateString('ar', { year: 'numeric', month: '2-digit', day: '2-digit' });
    if (bucket === 'day') return date;
    const time = d.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
    return `${date} — ${time}`;
  };

  // وسم كل N نقطة كي لا تتراكب على العرض الصغير
  const interval = Math.max(0, Math.floor(points.length / 8));

  // تلميح مخصّص: الإجمالي + تفصيل المناديب/مستخدمي الشركة عند كل وقتٍ بعينه
  const renderTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ payload?: HistPoint }> }) => {
    const { active, label, payload } = props;
    if (!active || !payload || !payload.length) return null;
    const p = payload[0].payload;
    if (!p) return null;
    return (
      <div style={{ borderRadius: 12, border: '1px solid #F1EBDF', background: '#fff', padding: '8px 12px', fontSize: 12, direction: 'rtl', boxShadow: '0 6px 20px rgba(0,0,0,.08)' }}>
        <div style={{ color: '#6E6557', marginBottom: 4 }}>{fmtFull(String(label ?? ''))}</div>
        <div style={{ fontWeight: 700, color: '#1F1A13' }}>الإجمالي: {p.total}</div>
        <div style={{ color: '#E15A30' }}>المناديب: {p.reps}</div>
        <div style={{ color: '#2563EB' }}>مستخدمو الشركة: {p.admins}</div>
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={points} margin={{ top: 6, right: 6, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="liveArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#1E7A52" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#1E7A52" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#F1EBDF" vertical={false} />
        <XAxis dataKey="t" tick={{ fontSize: 9, fill: '#9A8F7E' }} interval={interval} tickFormatter={fmtX}
          axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 9, fill: '#9A8F7E' }} allowDecimals={false} width={30}
          axisLine={false} tickLine={false} />
        <Tooltip content={renderTooltip} />
        <Area type="monotone" dataKey="total" stroke="#1E7A52" strokeWidth={2} fill="url(#liveArea)" name="total" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
