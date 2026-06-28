import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { supportApi } from '../api/client';
import { LifeBuoy, X, Send, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useT } from '../i18n/strings';
import { useDir } from '../i18n/lang';

// نافذة الدعم الفني — يرسل أدمن الشركة طلباً يصل إلى help@fieldsa.net
export default function SupportModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const dir = useDir();
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState('support.catGeneral');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);

  const send = useMutation({
    mutationFn: () => supportApi.send({ subject: subject.trim() || undefined, category: t(category), message: message.trim() }),
    onSuccess: () => { setSent(true); toast.success(t('support.success')); },
    onError: () => toast.error(t('support.failed')),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) { toast.error(t('support.errMsg')); return; }
    send.mutate();
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[2000] flex items-center justify-center p-4" dir={dir}>
      <div className="relative z-[2001] bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><LifeBuoy size={20} className="text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">{t('support.title')}</h2>
              <p className="text-xs text-[#6E6557]">{t('support.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        {sent ? (
          <div className="text-center py-12 px-6">
            <div className="w-14 h-14 rounded-2xl bg-green-100 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 size={28} className="text-green-600" />
            </div>
            <h3 className="text-lg font-bold text-[#1F1A13]">{t('support.success')}</h3>
            <p className="text-sm text-[#6E6557] mt-2">{t('support.note')}</p>
            <button onClick={onClose} className="btn-primary mx-auto mt-6">{t('common.cancel')}</button>
          </div>
        ) : (
          <form onSubmit={submit} className="p-5 space-y-3.5">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label">{t('support.category')}</label>
                <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
                  <option value="support.catGeneral">{t('support.catGeneral')}</option>
                  <option value="support.catTechnical">{t('support.catTechnical')}</option>
                  <option value="support.catBilling">{t('support.catBilling')}</option>
                  <option value="support.catFeature">{t('support.catFeature')}</option>
                </select>
              </div>
              <div>
                <label className="label">{t('support.subject')}</label>
                <input className="input" value={subject} onChange={e => setSubject(e.target.value)} placeholder={t('support.subjectPh')} />
              </div>
            </div>
            <div>
              <label className="label">{t('support.message')} *</label>
              <textarea className="input" rows={5} value={message} onChange={e => setMessage(e.target.value)} placeholder={t('support.messagePh')} />
            </div>
            <p className="text-[11px] text-[#9A8F7E] flex items-center gap-1.5"><LifeBuoy size={12} /> {t('support.note')}</p>
            <div className="flex gap-3 pt-1">
              <button type="submit" disabled={send.isPending} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
                {send.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send size={16} />}
                {t('support.send')}
              </button>
              <button type="button" onClick={onClose} className="btn-secondary">{t('common.cancel')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
