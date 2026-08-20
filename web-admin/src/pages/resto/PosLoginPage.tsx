import { useState } from 'react';
import { Delete, User, ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { authApi } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { BrandIcon } from '../../components/BrandLogo';

// دخول الكاشير/النادل — اسم دخول + PIN، يوجّه إلى /pos فقط (منفصل عن دخول الأدمن).
export default function PosLoginPage() {
  const { login } = useAuthStore();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);

  const press = (d: string) => setPin(p => (p.length < 6 ? p + d : p));
  const back = () => setPin(p => p.slice(0, -1));

  const submit = async () => {
    if (!username.trim()) { toast.error('أدخل اسم الدخول'); return; }
    if (pin.length < 4) { toast.error('الرمز 4 أرقام على الأقل'); return; }
    setLoading(true);
    try {
      const res = await authApi.login({ username: username.trim(), password: pin, role: 'sales_rep' });
      const { token, user } = res.data.data;
      if (user.vertical !== 'restaurant') { toast.error('هذا الدخول لكاشير المطاعم فقط'); setLoading(false); return; }
      login(token, user);
      toast.success(`أهلا ${user.name}`);
      window.location.replace('/pos');
    } catch (err: unknown) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'بيانات الدخول غير صحيحة');
      setPin('');
    } finally { setLoading(false); }
  };

  return (
    <div dir="rtl" className="min-h-screen flex items-center justify-center bg-[#1F1A13] p-4" style={{ fontFamily: "'IBM Plex Sans','IBM Plex Sans Arabic',sans-serif" }}>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <div className="mb-3" style={{ filter: 'drop-shadow(0 12px 30px rgba(225,90,48,.4))' }}><BrandIcon size={64} radius={0.26} /></div>
          <div className="text-2xl font-bold tracking-tight"><span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Restaurant</span></div>
          <p className="text-[#9A8F7E] text-sm mt-1">دخول الكاشير</p>
        </div>

        <div className="bg-[#2C261D] rounded-3xl p-5 border border-white/10">
          <div className="relative mb-3">
            <User size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
            <input value={username} onChange={e => setUsername(e.target.value)} dir="ltr" autoCapitalize="none"
              className="w-full bg-[#1F1A13] border border-white/10 rounded-xl text-white text-center py-3 pr-9 outline-none focus:border-[#E15A30]"
              placeholder="اسم الدخول" />
          </div>

          {/* عرض الـPIN */}
          <div className="flex justify-center gap-2.5 my-4 h-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i} className="w-3 h-3 rounded-full transition-colors" style={{ background: i < pin.length ? '#E15A30' : '#4a4238' }} />
            ))}
          </div>

          {/* لوحة الأرقام */}
          <div className="grid grid-cols-3 gap-2.5">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
              <button key={d} onClick={() => press(d)} className="h-14 rounded-2xl bg-white/5 hover:bg-white/10 text-white text-xl font-bold transition-colors">{d}</button>
            ))}
            <button onClick={back} className="h-14 rounded-2xl bg-white/5 hover:bg-white/10 text-[#9A8F7E] flex items-center justify-center"><Delete size={20} /></button>
            <button onClick={() => press('0')} className="h-14 rounded-2xl bg-white/5 hover:bg-white/10 text-white text-xl font-bold">0</button>
            <button onClick={submit} disabled={loading} className="h-14 rounded-2xl bg-[#E15A30] hover:bg-[#C94E28] disabled:opacity-60 text-white font-bold flex items-center justify-center">
              {loading ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ArrowLeft size={20} />}
            </button>
          </div>
        </div>

        <a href="/login" className="block text-center text-[#9A8F7E] hover:text-white text-sm mt-5">دخول المدير</a>
      </div>
    </div>
  );
}
