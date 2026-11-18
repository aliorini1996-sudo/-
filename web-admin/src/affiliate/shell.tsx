// ============================================================================
// هيكل التنقّل في البوابة (V2_SPEC §7 — الجوال أولاً، مثل ركاز):
//   · الجوال: شريطٌ سفليّ ثابت بأربعة (الرئيسية · شركاتي · أرباحي · المزيد)، و«المزيد» ورقةٌ
//     منزلقة من الأسفل بالباقي تُغلق بعد الاختيار (وبلمسة الخلفية وEsc وتغيّر العنوان وبلوغ ≥lg).
//   · الحاسوب (≥lg): شريطٌ جانبيّ بالكل.
//   · زرّ واتساب الدعم العائم فوق الشريط السفليّ.
// التبويب يبقى من `#hash` (./nav) — هنا العرض وحده، والانتقال يمرّره AffiliateApp.
// ============================================================================
import { useEffect, useRef } from 'react';
import {
  Home, Building2, Wallet, Link2, Send, UserPlus, SearchCheck, Tags, FolderOpen, CircleHelp, LifeBuoy, UserRound,
  FileText, LogOut, Ellipsis, X, MessageCircle, type LucideIcon,
} from 'lucide-react';
import { useAxT, type AxKey } from './i18n';
import { BOTTOM_TABS, isMoreTab, type Tab } from './nav';
import { supportWhatsappUrl } from './format';
import { LG_MEDIA, onMediaMatch } from './media';

export const NAV: Record<Tab, { label: AxKey; Icon: LucideIcon }> = {
  home: { label: 'tab.home', Icon: Home },
  companies: { label: 'tab.companies', Icon: Building2 },
  earnings: { label: 'tab.earnings', Icon: Wallet },
  link: { label: 'tab.link', Icon: Link2 },
  claims: { label: 'tab.claims', Icon: Send },
  // يظهر حين يفعّله الخادم وحده (me.settings.portalTrialEnabled) — visibleTabs في ./nav
  trial: { label: 'tab.trial', Icon: UserPlus },
  missed: { label: 'tab.missed', Icon: SearchCheck },
  pricing: { label: 'tab.pricing', Icon: Tags },
  materials: { label: 'tab.materials', Icon: FolderOpen },
  faq: { label: 'tab.faq', Icon: CircleHelp },
  support: { label: 'tab.support', Icon: LifeBuoy },
  profile: { label: 'tab.profile', Icon: UserRound },
  terms: { label: 'tab.terms', Icon: FileText },
};

/** الشريط الجانبيّ على الحاسوب — كل التبويبات ثم الخروج */
export function Sidebar({ tabs, active, onSelect, onLogout }: {
  tabs: Tab[]; active: Tab; onSelect: (t: Tab) => void; onLogout: () => void;
}) {
  const { t } = useAxT();
  return (
    <nav aria-label={t('nav.sections')} className="hidden lg:block w-60 shrink-0">
      <div className="sticky top-[76px] space-y-0.5 pb-6">
        {tabs.map((id) => {
          const { label, Icon } = NAV[id];
          const on = id === active;
          return (
            <button
              key={id} type="button" onClick={() => onSelect(id)} aria-current={on ? 'page' : undefined}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13.5px] font-semibold text-start transition-colors ${
                on ? 'bg-[#E15A30] text-white shadow-sm' : 'text-[#44403a] hover:bg-white'
              }`}
            >
              <Icon size={17} className="shrink-0" /> <span className="truncate">{t(label)}</span>
            </button>
          );
        })}
        <button
          type="button" onClick={onLogout}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 mt-2 rounded-xl text-[13.5px] font-semibold text-[#C0392B] hover:bg-white text-start"
        >
          <LogOut size={17} className="shrink-0" /> {t('common.logout')}
        </button>
      </div>
    </nav>
  );
}

/** الشريط السفليّ على الجوال — ثلاثة تبويبات و«المزيد» */
export function BottomBar({ active, moreOpen, onSelect, onMore }: {
  active: Tab; moreOpen: boolean; onSelect: (t: Tab) => void; onMore: () => void;
}) {
  const { t } = useAxT();
  const moreOn = moreOpen || isMoreTab(active);
  const item = (on: boolean) =>
    `flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 pt-2 pb-1.5 text-[11px] font-semibold ${on ? 'text-[#E15A30]' : 'text-[#6E6557]'}`;
  return (
    <nav
      aria-label={t('nav.bottom')}
      className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-[#E9E1D3]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="max-w-xl mx-auto flex">
        {BOTTOM_TABS.map((id) => {
          const { label, Icon } = NAV[id];
          const on = id === active && !moreOpen;
          return (
            <button key={id} type="button" onClick={() => onSelect(id)} aria-current={on ? 'page' : undefined} className={item(on)}>
              <Icon size={21} strokeWidth={on ? 2.4 : 2} />
              <span className="truncate max-w-full px-1">{t(label)}</span>
            </button>
          );
        })}
        <button type="button" onClick={onMore} aria-haspopup="dialog" aria-expanded={moreOpen} className={item(moreOn)}>
          <Ellipsis size={21} strokeWidth={moreOn ? 2.4 : 2} />
          <span className="truncate max-w-full px-1">{t('nav.more')}</span>
        </button>
      </div>
    </nav>
  );
}

/** انزلاقٌ من الأسفل — ويُلغى لمن يطلب تقليل الحركة */
const SHEET_CSS = '@keyframes axSheetIn{from{transform:translateY(100%)}to{transform:none}}'
  + '.ax-sheet-in{animation:axSheetIn .22s ease-out}'
  + '@media (prefers-reduced-motion: reduce){.ax-sheet-in{animation:none}}';

/**
 * ورقة «المزيد» المنزلقة — تُغلق بعد الاختيار (المواصفة)، وبلمسة الخلفية وEsc. التمرير
 * خلفها موقوف ما دامت مفتوحة، والتركيز ينتقل إليها ويعود لزرّ «المزيد» عند الإغلاق.
 */
export function MoreSheet({ open, tabs, active, onSelect, onClose, onLogout }: {
  open: boolean; tabs: Tab[]; active: Tab; onSelect: (t: Tab) => void; onClose: () => void; onLogout: () => void;
}) {
  const { t } = useAxT();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    const prevFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // الورقة مخفيّةٌ بـCSS وحدها على ≥lg: تدوير جهازٍ لوحيّ أو تكبير النافذة وهي مفتوحة كان يُخفيها
    // ويُبقي التمرير موقوفاً وزرّ الدعم غائباً بلا زرّ إغلاقٍ ظاهر — فتُغلق عند بلوغ lg (فيُعاد التمرير)
    const stopLg = onMediaMatch(LG_MEDIA, onClose);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      stopLg();
      prevFocus?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  const pick = (id: Tab) => { onSelect(id); onClose(); };
  return (
    <div className="lg:hidden fixed inset-0 z-40">
      <style>{SHEET_CSS}</style>
      <button type="button" aria-label={t('nav.close')} className="absolute inset-0 bg-[#1F1A13]/40" onClick={onClose} />
      <div
        ref={panel} role="dialog" aria-modal="true" aria-label={t('nav.more')} tabIndex={-1}
        className="absolute bottom-0 inset-x-0 bg-[#FAF7F0] rounded-t-3xl shadow-2xl max-h-[85vh] overflow-y-auto outline-none ax-sheet-in"
        style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }}
      >
        <div className="sticky top-0 bg-[#FAF7F0] pt-2.5 pb-1 px-4">
          <div className="mx-auto w-10 h-1.5 rounded-full bg-[#DED5C4]" aria-hidden />
          <div className="flex items-center justify-between mt-2">
            <h2 className="text-base font-bold text-[#1F1A13]">{t('nav.more')}</h2>
            <button type="button" onClick={onClose} aria-label={t('nav.close')} className="w-9 h-9 rounded-full flex items-center justify-center text-[#6E6557] hover:bg-white">
              <X size={19} />
            </button>
          </div>
        </div>
        <div className="px-3 pt-1 grid grid-cols-1 gap-0.5">
          {tabs.map((id) => {
            const { label, Icon } = NAV[id];
            const on = id === active;
            return (
              <button
                key={id} type="button" onClick={() => pick(id)} aria-current={on ? 'page' : undefined}
                className={`flex items-center gap-3 px-3 py-3 rounded-xl text-[14.5px] font-semibold text-start ${on ? 'bg-white text-[#E15A30]' : 'text-[#1F1A13] active:bg-white'}`}
              >
                <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${on ? 'bg-[#FBEBE2]' : 'bg-white'}`}><Icon size={18} /></span>
                <span className="truncate">{t(label)}</span>
              </button>
            );
          })}
          <button
            type="button" onClick={() => { onClose(); onLogout(); }}
            className="flex items-center gap-3 px-3 py-3 mt-1 rounded-xl text-[14.5px] font-semibold text-[#C0392B] text-start active:bg-white"
          >
            <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-white"><LogOut size={18} /></span>
            {t('common.logout')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * زرّ واتساب الدعم العائم داخل البوابة (V2_SPEC §7) — رقم فيلد سيلز الرسمي، بنصٍّ أوّل يحمل
 * رمز السفير فيُعرف حسابه. فوق الشريط السفليّ على الجوال، وفي الركن على الحاسوب.
 * (زرّ الموقع العامّ WhatsAppFab مخفيٌّ على /ax عمداً — هذا زرّ البوابة نفسها.)
 */
export function SupportFab({ code }: { code: string }) {
  const { t } = useAxT();
  return (
    <a
      href={supportWhatsappUrl(t('support.waMessage', { code }))} target="_blank" rel="noopener noreferrer"
      aria-label={t('support.fab')} title={t('support.fab')}
      style={{ bottom: 'calc(76px + env(safe-area-inset-bottom))' }}
      className="fixed z-20 end-4 lg:!bottom-6 w-12 h-12 rounded-full bg-[#1E7A52] text-white shadow-lg flex items-center justify-center hover:brightness-110"
    >
      <MessageCircle size={23} />
    </a>
  );
}
