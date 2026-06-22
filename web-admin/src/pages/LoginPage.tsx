import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { authApi } from '../api/client';
import { useAuthStore } from '../store/authStore';

export default function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [mode, setMode] = useState<'admin' | 'super_admin'>('admin');
  const [form, setForm] = useState({ username: '', password: '' });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.password) {
      toast.error('يرجى ملء جميع الحقول');
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.login({ ...form, role: mode });
      const { token, user } = res.data.data;
      login(token, user);
      toast.success(`مرحباً ${user.name}`);
      navigate(user.role === 'SUPER_ADMIN' ? '/platform' : '/');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'خطأ في تسجيل الدخول';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-blue-800 to-indigo-900 flex items-center justify-center p-4" dir="rtl">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/20 rounded-2xl mb-4 backdrop-blur-sm">
            <TrendingUp size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">نظام إدارة المبيعات</h1>
          <p className="text-blue-200 mt-1 text-sm">DSD Sales Management System</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-xl font-bold text-gray-800 mb-4">تسجيل الدخول</h2>

          {/* تبويب نوع الحساب */}
          <div className="flex gap-2 mb-5 bg-gray-100 rounded-xl p-1">
            <button type="button" onClick={() => setMode('admin')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${mode === 'admin' ? 'bg-white text-blue-700 shadow' : 'text-gray-500'}`}>
              دخول الشركة
            </button>
            <button type="button" onClick={() => setMode('super_admin')}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${mode === 'super_admin' ? 'bg-white text-blue-700 shadow' : 'text-gray-500'}`}>
              مالك المنصّة
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">البريد الإلكتروني{mode === 'admin' ? ' / اسم المستخدم' : ''}</label>
              <input
                type="text"
                className="input"
                placeholder="أدخل البريد الإلكتروني"
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                autoComplete="username"
                dir="ltr"
              />
            </div>

            <div>
              <label className="label">كلمة المرور</label>
              <div className="relative">
                <input
                  type={showPass ? 'text' : 'password'}
                  className="input pl-10"
                  placeholder="أدخل كلمة المرور"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  autoComplete="current-password"
                  dir="ltr"
                />
                <button
                  type="button"
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  onClick={() => setShowPass(s => !s)}
                >
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : null}
              دخول
            </button>
          </form>

          <div className="mt-6 p-3 bg-blue-50 rounded-lg text-xs text-blue-700">
            <p className="font-semibold mb-1">بيانات تجريبية:</p>
            {mode === 'admin' ? (
              <><p>البريد: admin@dsd.com</p><p>كلمة المرور: admin123</p></>
            ) : (
              <><p>البريد: owner@dsd.com</p><p>كلمة المرور: owner123</p></>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
