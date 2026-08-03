import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { formatCurrency } from '../utils/format';

/**
 * رسم مبيعات آخر ٣٠ يوماً — **محمَّل كسولاً وحده**.
 *
 * `recharts` هي الاعتماد الثقيل الوحيد في هذه الشاشة، وتطبيق المندوب لا
 * يستوردها إطلاقاً. عزلها في حزمة مستقلّة يُبقي إقلاع التطبيق خفيفاً على
 * شبكة الجوال، والرسم يظهر بعده بلحظة.
 *
 * ووسوم المحور مخفَّفة عمداً: ٣٠ وسماً يومياً على عرض ٣٦٠px تتراكب فتصير
 * خطّاً رمادياً لا يُقرأ — فنعرض وسماً كل خمسة أيام.
 */
export default function MSalesChart({ data }: { data: { date: string; total: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={170}>
      <AreaChart data={data} margin={{ top: 6, right: 4, left: -22, bottom: 0 }}>
        <defs>
          <linearGradient id="mSales" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#E15A30" stopOpacity={0.28} />
            <stop offset="95%" stopColor="#E15A30" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" tick={{ fontSize: 9 }} interval={4} tickFormatter={v => v.slice(5)}
          axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 9 }} tickFormatter={v => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
          axisLine={false} tickLine={false} width={38} />
        <Tooltip formatter={(v: number) => formatCurrency(v)} labelStyle={{ direction: 'ltr' }}
          contentStyle={{ borderRadius: 12, border: '1px solid #F1EBDF', fontSize: 12 }} />
        <Area type="monotone" dataKey="total" stroke="#E15A30" strokeWidth={2} fill="url(#mSales)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
