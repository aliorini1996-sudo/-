import { BrandIcon } from './BrandLogo';
import LanguageToggle from './LanguageToggle';
import { useT } from '../i18n/strings';
import {
  FileText, Users, ClipboardCheck, WifiOff,
  LayoutDashboard, Wallet, MapPin, LogIn,
} from 'lucide-react';

/**
 * الشاشة التعريفية قبل الدخول — تُعرض للمستخدم غير المصادَق **قبل** شاشة تسجيل الدخول.
 *
 * سببها متطلّب App Store (Guideline 5.1.1(v)): لا يجوز أن يفتح التطبيق مباشرةً على
 * شاشة دخول دون إتاحة محتوى غير مرتبط بحساب. فهذه الشاشة تُعرّف بالتطبيق وبمنصّة
 * فيلد سيلز وميزاتها — محتوى متاح للجميع بلا تسجيل — وتوفّر زرّاً للانتقال للدخول.
 *
 * تخدم التطبيقين: المندوب (`app="rep"`) والإدارة (`app="m"`).
 */
export default function AppIntro({ app, onProceed }: { app: 'rep' | 'm'; onProceed: () => void }) {
  const t = useT();
  const isRep = app === 'rep';
  const title = t(isRep ? 'intro.repTitle' : 'intro.mTitle');
  const what = t(isRep ? 'intro.repWhat' : 'intro.mWhat');
  const features: [string, React.ElementType][] = isRep
    ? [['intro.repF1', FileText], ['intro.repF2', Users], ['intro.repF3', ClipboardCheck], ['intro.repF4', WifiOff]]
    : [['intro.mF1', LayoutDashboard], ['intro.mF2', FileText], ['intro.mF3', Wallet], ['intro.mF4', MapPin]];

  return (
    <div className="h-full relative flex flex-col bg-[#1F1A13] text-[#FAF7F0]">
      <div className="absolute top-3 z-20" style={{ insetInlineEnd: '12px' }}><LanguageToggle variant="dark" /></div>

      {/* محتوى قابل للتمرير */}
      <div className="flex-1 overflow-y-auto px-6 pt-14 pb-4">
        {/* الهوية */}
        <div className="flex flex-col items-center text-center">
          <div style={{ filter: 'drop-shadow(0 12px 30px rgba(225,90,48,.45))' }}>
            <BrandIcon size={64} radius={0.26} />
          </div>
          <h1 className="text-xl tracking-tight mt-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }}>
            <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
          </h1>
          <p className="text-[#E8A87C] text-sm font-semibold mt-1">{title}</p>
        </div>

        {/* تعريف المنصّة */}
        <div className="mt-6 bg-white/5 border border-white/10 rounded-2xl p-4">
          <h2 className="text-sm font-bold text-[#FAF7F0] mb-1.5">{t('intro.aboutTitle')}</h2>
          <p className="text-[13px] leading-relaxed text-[#C9C0B4]">{t('intro.about')}</p>
        </div>

        {/* ماذا يفعل هذا التطبيق */}
        <p className="text-[13px] leading-relaxed text-[#C9C0B4] mt-4">{what}</p>

        {/* الميزات */}
        <h3 className="text-xs font-bold text-[#9A8F7E] mt-6 mb-2">{t('intro.featuresTitle')}</h3>
        <div className="space-y-2">
          {features.map(([key, Icon]) => (
            <div key={key} className="flex items-center gap-3 bg-white/5 rounded-xl px-3 py-2.5">
              <span className="w-8 h-8 rounded-lg bg-[#E15A30]/15 text-[#E15A30] flex items-center justify-center flex-shrink-0">
                <Icon size={17} />
              </span>
              <span className="text-[13px] text-[#EDE7DD]">{t(key)}</span>
            </div>
          ))}
        </div>

        {/* ملاحظة B2B */}
        <p className="text-[11px] leading-relaxed text-[#9A8F7E] mt-5 text-center">{t('intro.b2bNote')}</p>
      </div>

      {/* أسفل ثابت: زرّ الدخول */}
      <div className="flex-shrink-0 px-6 pt-3 bg-[#1F1A13] border-t border-white/5"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <button onClick={onProceed}
          className="w-full bg-[#E15A30] hover:bg-[#C94E28] text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2 min-h-[48px]">
          <LogIn size={18} /> {t('intro.login')}
        </button>
      </div>
    </div>
  );
}
