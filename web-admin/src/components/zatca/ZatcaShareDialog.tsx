import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, ExternalLink, Link2, Loader2, MessageCircle, ShieldAlert } from 'lucide-react';
import { invoiceApi } from '../../api/client';
import { shareMessageOf, waShareUrl } from '../../lib/zatca/shareView';

/**
 * ZATCA المرحلة الثانية (Z5.7) — حوار «رابط المشتري»: الرابط العلنيّ لمستندٍ نهائيّ كي يُرسل لصاحبه.
 *
 * الفاتورة القياسية لا تُسلَّم إلا بعد اعتماد الهيئة، والمسلَّم هو مستند الهيئة (XML ورمزه المختوم) لا صورة ورقة.
 * فهنا مخرجه: رابطٌ واحد، ورمز QR له يمسحه المشتري من شاشة المندوب، وزرّ واتساب برسالةٍ جاهزة.
 *
 * ثلاثة أشياء مقصودة:
 *   • **الرمز يأتي من الخادم ولا يُبنى هنا**: هو HMAC بسرٍّ خادميّ، وأيّ اشتقاقٍ في المتصفّح يعني تسريب السرّ.
 *   • **`available:false` تُعرض بسببها لا تُخفى**: مستندٌ لم تحسمه الهيئة لا رابط له — وقولها صراحةً يمنع المدير
 *     من انتظار رابطٍ لن يأتي، ويمنعه من تسليم المشتري فاتورةً قد تُرفض بعد ساعة.
 *   • **الرابط سرّ**: من يملكه يرى هذا المستند وحده — مكتوبةٌ في الحوار، فالمدير هو من يقرّر لمن يرسله.
 */
export default function ZatcaShareDialog({ invoiceId, number, sellerName, tr, onClose }: {
  invoiceId: string;
  number: string;
  sellerName?: string | null;
  tr: (s: string) => string;
  onClose: () => void;
}) {
  const [state, setState] = useState<'loading' | 'ready' | 'blocked' | 'error'>('loading');
  const [url, setUrl] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const body = (await invoiceApi.einvoiceShare(invoiceId)).data as {
          data?: { available?: boolean; reason?: string | null; url?: string | null };
        };
        const d = body?.data ?? {};
        if (dead) return;
        if (d.available === true && typeof d.url === 'string' && d.url !== '') {
          setUrl(d.url);
          setState('ready');
          QRCode.toDataURL(d.url, { width: 220, margin: 1 }).then(u => { if (!dead) setQr(u); }).catch(() => {});
        } else {
          setReason(typeof d.reason === 'string' ? d.reason : null);
          setState('blocked');
        }
      } catch {
        if (!dead) setState('error');
      }
    })();
    return () => { dead = true; };
  }, [invoiceId]);

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // متصفّحٌ يمنع الحافظة (سياق غير آمن): الحقل نفسه قابل للتحديد يدوياً — لا رسالة نجاحٍ كاذبة
      setCopied(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5" onClick={e => e.stopPropagation()}>
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3 bg-[#FBEBE2] text-[#E15A30]">
          <Link2 size={24} />
        </div>
        <h3 className="font-bold text-[#1F1A13]">{tr('رابط المشتري')}</h3>
        <p className="text-xs text-[#44403a] mt-1 font-mono" dir="ltr">{number}</p>

        {state === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-[#6E6557] py-6">
            <Loader2 size={15} className="animate-spin" /> {tr('جاري التحميل')}
          </p>
        )}

        {state === 'error' && (
          <p className="mt-3 text-sm text-[#C0392B]">{tr('تعذر جلب رابط المشتري')}</p>
        )}

        {state === 'blocked' && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#F0DDA6] bg-[#FDF3D8] px-3 py-2.5 text-[13px] text-[#6B4B00]">
            <ShieldAlert size={16} className="mt-0.5 shrink-0" />
            <p>
              {reason === 'NOT_CONFIGURED'
                ? tr('خاصية الرابط غير مهيأة على الخادم')
                : tr('الرابط يفتح بعد أن تحسم الهيئة المستند فالمعلق والمرفوض والمسحوب لا رابط لها')}
            </p>
          </div>
        )}

        {state === 'ready' && url && (
          <>
            {qr && <img src={qr} alt={tr('رابط المشتري')} className="mx-auto mt-3 w-36 h-36" />}
            <input
              readOnly
              value={url}
              onFocus={e => e.currentTarget.select()}
              dir="ltr"
              className="w-full mt-3 border border-[#E9E1D3] rounded-xl px-3 py-2 text-[11px] font-mono bg-[#FAF6EF]"
            />
            <p className="text-[11px] text-[#6E6557] mt-1.5 leading-relaxed">
              {tr('الرمز في الرابط هو الإذن ومن يملكه يرى هذا المستند وحده')}
            </p>
            <div className="flex gap-2 mt-3">
              <button type="button" onClick={() => { void copy(); }}
                className="flex-1 justify-center py-2.5 rounded-xl bg-[#E15A30] text-white font-semibold flex items-center gap-2 text-sm">
                {copied ? <Check size={15} /> : <Copy size={15} />} {tr(copied ? 'تم نسخ الرابط' : 'نسخ الرابط')}
              </button>
              <a
                href={waShareUrl(shareMessageOf({ number, sellerName }, url))}
                target="_blank" rel="noopener noreferrer"
                className="py-2.5 px-3 rounded-xl bg-[#E4F1EA] text-[#1E7A52] font-semibold flex items-center gap-2 text-sm"
                title={tr('إرسال بواتساب')}
              >
                <MessageCircle size={15} />
              </a>
              <a
                href={url} target="_blank" rel="noopener noreferrer"
                className="py-2.5 px-3 rounded-xl bg-[#F1EBDF] text-[#6E6557] flex items-center"
                title={tr('فتح الصفحة')}
              >
                <ExternalLink size={15} />
              </a>
            </div>
          </>
        )}

        <button type="button" className="btn-secondary w-full justify-center mt-4" onClick={onClose}>
          {tr('إغلاق')}
        </button>
      </div>
    </div>
  );
}
