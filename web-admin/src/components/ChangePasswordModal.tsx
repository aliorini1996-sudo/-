import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { authApi } from '../api/client';
import { X, KeyRound, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';

// نافذة تغيير كلمة المرور — تصلح للسوبر أدمن وأدمن الشركة والمندوب
export default function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [cf, setCf] = useState('');
  const [show, setShow] = useState(false);

  const mutation = useMutation({
    mutationFn: () => authApi.changePassword({ currentPassword: cur, newPassword: nw }),
    onSuccess: () => { toast.success('تم تغيير كلمة المرور بنجاح'); onClose(); },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر تغيير كلمة المرور'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cur) { toast.error('أدخل كلمة المرور الحالية'); return; }
    if (nw.length < 6) { toast.error('كلمة المرور الجديدة 6 أحرف على الأقل'); return; }
    if (nw !== cf) { toast.error('كلمتا المرور غير متطابقتين'); return; }
    mutation.mutate();
  };

  const field = (label: string, value: string, setter: (v: string) => void, placeholder: string) => (
    <div>
      <label className="label">{label}</label>
      <div className="relative">
        <input type={show ? 'text' : 'password'} className="input pl-10" dir="ltr" placeholder={placeholder}
          value={value} onChange={e => setter(e.target.value)} autoComplete="off" />
        <button type="button" onClick={() => setShow(s => !s)} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2"><KeyRound size={18} className="text-blue-600" /> تغيير كلمة المرور</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          {field('كلمة المرور الحالية', cur, setCur, '')}
          {field('كلمة المرور الجديدة', nw, setNw, '6 أحرف على الأقل')}
          {field('تأكيد كلمة المرور الجديدة', cf, setCf, '')}
          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={mutation.isPending} className="btn-primary flex-1 justify-center py-2.5">
              {mutation.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <KeyRound size={15} />}
              حفظ
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">إلغاء</button>
          </div>
        </form>
      </div>
    </div>
  );
}
