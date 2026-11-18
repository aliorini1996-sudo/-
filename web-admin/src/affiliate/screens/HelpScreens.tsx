// ============================================================================
// «الأسئلة الشائعة» و«الدعم» (V2_SPEC §7) — ثابتةٌ بالخمس لغات من القاموس، والأرقام فيها من
// إعدادات السفير نفسه (النسبة والحجز والحدّ الأدنى) فلا تتقادم إذا تغيّرت الشروط.
// الدعم: واتساب فيلد سيلز الرسمي وبريدها — والزرّ العائم في كل الشاشات (./shell).
// ============================================================================
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Mail, MessageCircle, CircleHelp } from 'lucide-react';
import { affiliateApi, qk, shouldRetry } from '../api';
import {
  SETTLEMENT_EVERY_DAYS, SUPPORT_EMAIL, SUPPORT_WHATSAPP, daysLabel, formatRate, formatSar, supportWhatsappUrl,
} from '../format';
import { useAxT, type AxKey } from '../i18n';
import type { Tab } from '../nav';
import type { MeResponse } from '../types';
import { SectionTitle } from '../ui';

/** الأسئلة بترتيب المواصفة: العمولة · الحجز والتسوية · الإحالة · الحساب التجريبي · المطالبة الفائتة · الملف والصرف */
export const FAQ_KEYS: ReadonlyArray<{ q: AxKey; a: AxKey }> = [
  { q: 'faq.q.commission', a: 'faq.a.commission' },
  { q: 'faq.q.hold', a: 'faq.a.hold' },
  { q: 'faq.q.referral', a: 'faq.a.referral' },
  { q: 'faq.q.trial', a: 'faq.a.trial' },
  { q: 'faq.q.missed', a: 'faq.a.missed' },
  { q: 'faq.q.profile', a: 'faq.a.profile' },
];

/** نافذة الإسناد الافتراضية (V2_SPEC §0 «يبقى كما هو») — حين لم تُحمَّل الشروط العامة بعد */
const REF_WINDOW_DAYS = 90;

export function FaqTab({ me }: { me: MeResponse }) {
  const { t, lang } = useAxT();
  const terms = useQuery({ queryKey: qk.terms, queryFn: affiliateApi.publicTerms, retry: shouldRetry, staleTime: 60_000 });
  const s = me.settings;
  const vars = {
    rate: formatRate(s.rateBps),
    days: daysLabel(s.holdDays, lang),
    every: daysLabel(s.settlementEveryDays || SETTLEMENT_EVERY_DAYS, lang),
    min: formatSar(s.minPayoutHalalas, lang),
    window: daysLabel(terms.data?.refWindowDays || REF_WINDOW_DAYS, lang),
  };
  return (
    <div className="space-y-3">
      <SectionTitle>{t('tab.faq')}</SectionTitle>
      {FAQ_KEYS.map(({ q, a }, i) => (
        <details key={q} className="group bg-white rounded-2xl border border-[#E9E1D3] open:border-[#E15A30]/40" open={i === 0}>
          <summary className="flex items-center justify-between gap-3 cursor-pointer list-none px-4 py-3.5 text-[14px] font-bold text-[#1F1A13] [&::-webkit-details-marker]:hidden">
            <span>{t(q)}</span>
            <ChevronDown size={18} className="shrink-0 text-[#8A8072] transition-transform group-open:rotate-180" />
          </summary>
          <p className="px-4 pb-4 -mt-1 text-[13px] text-[#44403a] leading-7">{t(a, vars)}</p>
        </details>
      ))}
    </div>
  );
}

export function SupportTab({ me, openTab }: { me: MeResponse; openTab: (t: Tab) => void }) {
  const { t } = useAxT();
  const code = me.user.code;
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <SectionTitle>{t('support.title')}</SectionTitle>
        <p className="text-[13px] text-[#6E6557] leading-relaxed -mt-1">{t('support.intro')}</p>
        <a
          href={supportWhatsappUrl(t('support.waMessage', { code }))} target="_blank" rel="noopener noreferrer"
          className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-[#1E7A52] text-white font-bold text-[15px] py-3.5 hover:brightness-110"
        >
          <MessageCircle size={19} /> {t('support.whatsapp')}
          <bdi dir="ltr" className="font-semibold opacity-90 text-[13px]">+{SUPPORT_WHATSAPP}</bdi>
        </a>
        <a href={`mailto:${SUPPORT_EMAIL}`} className="btn-secondary w-full justify-center py-3">
          <Mail size={17} /> {t('support.email')} <bdi dir="ltr" className="text-[13px]">{SUPPORT_EMAIL}</bdi>
        </a>
        <p className="text-[12px] text-[#8A8072] leading-relaxed">
          {t('support.codeNote', { code })}
        </p>
      </div>
      <button
        type="button" onClick={() => openTab('faq')}
        className="w-full flex items-center gap-3 rounded-2xl bg-white border border-[#E9E1D3] px-3.5 py-3 text-start hover:border-[#E15A30]"
      >
        <span className="w-9 h-9 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center shrink-0"><CircleHelp size={18} /></span>
        <span className="text-[13.5px] font-semibold text-[#1F1A13]">{t('support.faqCta')}</span>
      </button>
    </div>
  );
}
