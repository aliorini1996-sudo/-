import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

export interface ReqPoint { day: string; requests: number; reps: number; admins: number }

const nf = (n: number): string => n.toLocaleString('en-US');

/**
 * مؤشّر «استهلاك الطلبات» عبر الأيّام — **محمَّل كسولاً وحده** (recharts الثقيلة).
 * البيانات يوميّة (RequestStat.day)، فالمحور الأفقيّ تواريخ. التلميح يكشف إجمالي
 * الطلبات وتقسيمها (مناديب/مستخدمو شركة) لكل يومٍ بعينه.
 */
export default function RequestHistoryChart({ points }: { points: ReqPoint[] }) {
  const fmtX = (day: string): string => {
    const d = new Date(day + 'T00:00:00');
    return d.toLocaleDateString('ar', { month: '2-digit', day: '2-digit' });
  };
  const fmtFull = (day: string): string => {
    const d = new Date(day + 'T00:00:00');
    return d.toLocaleDateString('ar', { year: 'numeric', month: '2-digit', day: '2-digit' });
  };
  const interval = Math.max(0, Math.floor(points.length / 8));

  const renderTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ payload?: ReqPoint }> }) => {
    const { active, label, payload } = props;
    if (!active || !payload || !payload.length) return null;
    const p = payload[0].payload;
    if (!p) return null;
    return (
      <div style={{ borderRadius: 12, border: '1px solid #F1EBDF', background: '#fff', padding: '8px 12px', fontSize: 12, direction: 'rtl', boxShadow: '0 6px 20px rgba(0,0,0,.08)' }}>
        <div style={{ color: '#6E6557', marginBottom: 4 }}>{fmtFull(String(label ?? ''))}</div>
        <div style={{ fontWeight: 700, color: '#1F1A13' }}>الطلبات {nf(p.requests)}</div>
        <div style={{ color: '#E15A30' }}>المناديب {nf(p.reps)}</div>
        <div style={{ color: '#2563EB' }}>مستخدمو الشركة {nf(p.admins)}</div>
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={points} margin={{ top: 6, right: 6, left: -6, bottom: 0 }}>
        <defs>
          <linearGradient id="reqArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#E15A30" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#E15A30" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#F1EBDF" vertical={false} />
        <XAxis dataKey="day" tick={{ fontSize: 9, fill: '#9A8F7E' }} interval={interval} tickFormatter={fmtX}
          axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 9, fill: '#9A8F7E' }} allowDecimals={false} width={44}
          tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
          axisLine={false} tickLine={false} />
        <Tooltip content={renderTooltip} />
        <Area type="monotone" dataKey="requests" stroke="#E15A30" strokeWidth={2} fill="url(#reqArea)" name="requests" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
