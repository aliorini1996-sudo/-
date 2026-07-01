import { useState } from 'react';
import { KeyRound, X, Eye, EyeOff, RefreshCw, Copy, Check, CheckCircle2 } from 'lucide-react';
import { useTr } from '../i18n/strings';

interface Props {
  title: string;            // عنوان النافذة، مثل: إعادة تعيين كلمة مرور المندوب
  subject: string;          // وصف صاحب الحساب: الاسم / البريد / اسم المستخدم
  onConfirm: (newPassword: string) => Promise<void>; // ينفّذ الطلب ويرمي عند الفشل
  onClose: () => void;
}

// نافذة موحّدة لإعادة تعيين كلمة المرور (للسوبر أدمن مع الأدمن، وللأدمن مع المندوب)
// بعد النجاح تعرض كلمة المرور الجديدة لنسخها وتسليمها لصاحب الحساب.
export default function ResetPasswordModal({ title, subject, onConfirm, onClose }: Props) {
  const tr = useTr();
  const [pwd, setPwd] = useState('');
  const [show, setShow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<string | null>(null); // كلمة المرور بعد النجاح
  const [copied, setCopied] = useState(false);

  const generate = () => {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let p = '';
    for (let i = 0; i < 8; i++) p += chars[Math.floor(Math.random() * chars.length)];
    setPwd(p); setShow(true); setErr('');
  };

  const submit = async () => {
    if (pwd.trim().length < 6) { setErr(tr('كلمة المرور 6 أحرف على الأقل')); return; }
    setBusy(true); setErr('');
    try {
      await onConfirm(pwd.trim());
      setDone(pwd.trim());
    } catch (e) {
      setErr((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذّر إعادة التعيين'));
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    navigator.clipboard?.writeText(done || '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
        {/* الترويسة */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${done ? 'bg-green-100' : 'bg-[#FBEBE2]'}`}>
              {done ? <CheckCircle2 size={18} className="text-green-600" /> : <KeyRound size={18} className="text-[#E15A30]" />}
            </div>
            <div>
              <h2 className="text-base font-bold text-[#1F1A13]">{done ? tr('تم إعادة التعيين') : title}</h2>
              <p className="text-xs text-[#6E6557]">{subject}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        {done ? (
          // شاشة النجاح — عرض كلمة المرور الجديدة لتسليمها لصاحب الحساب
          <div className="p-5 space-y-4">
            <p className="text-xs text-[#9C4423] bg-[#FBEBE2] rounded-lg px-3 py-2 leading-relaxed">
              {tr('سلّم كلمة المرور الجديدة لصاحب الحساب — لن تظهر مرة أخرى بعد إغلاق النافذة.')}
            </p>
            <div className="bg-gray-50 rounded-xl px-3 py-3 flex items-center justify-between">
              <span className="font-mono font-bold text-lg text-[#1F1A13]" dir="ltr">{done}</span>
              <button onClick={copy} className="text-[#E15A30] hover:text-[#C94E28] flex items-center gap-1 text-sm">
                {copied ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
                {copied ? tr('تم النسخ') : tr('نسخ')}
              </button>
            </div>
            <button onClick={onClose} className="btn-primary w-full justify-center py-2.5">{tr('تم')}</button>
          </div>
        ) : (
          // شاشة الإدخال
          <div className="p-5 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="label mb-0">{tr('كلمة المرور الجديدة')}</label>
                <button type="button" onClick={generate} className="text-xs text-[#E15A30] hover:text-[#C94E28] flex items-center gap-1">
                  <RefreshCw size={11} /> {tr('توليد')}
                </button>
              </div>
              <div className="relative">
                <input type={show ? 'text' : 'password'} className="input pl-9" dir="ltr" autoFocus
                  placeholder={tr('6 أحرف على الأقل')} value={pwd} onChange={e => { setPwd(e.target.value); setErr(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
                <button type="button" onClick={() => setShow(s => !s)} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                  {show ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {err && <p className="text-[#C0392B] text-xs mt-1.5">{err}</p>}
            </div>
            <div className="flex gap-3">
              <button onClick={submit} disabled={busy} className="btn-primary flex-1 justify-center py-2.5">
                {busy ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <KeyRound size={15} />}
                {tr('إعادة التعيين')}
              </button>
              <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
