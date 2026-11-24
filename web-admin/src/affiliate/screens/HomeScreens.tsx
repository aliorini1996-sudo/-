// ============================================================================
// «الرئيسية» و«رابطي» — الجوال أولاً (V2_SPEC §7):
//   ترحيبٌ وحالة · شريط «أكمل ملفك» · زرّ «مشاركة رابطي» العريض · خطوات البداية ·
//   بطاقات ٢×٢ · رسم أعمدة لستة أشهر (CSS بلا مكتبة) · التسوية القادمة · تنقّل سريع.
// الإفصاح يسبق الرابط دائماً في كل ما يُنسخ أو يُشارك، ونصّه عربيٌّ من الخادم يُشارك كما هو.
// ============================================================================
import type { ReactNode } from 'react';
import {
  MousePointerClick, Building2, BadgeCheck, Wallet, Scale, MessageCircle, Share2, AlertTriangle, ChevronLeft,
  ChevronRight, CheckCircle2, Circle, Hourglass, Users, Percent, CalendarClock,
} from 'lucide-react';
import { affiliateApi, qk } from '../api';
import { dashboardView } from '../dashboard';
import {
  barHeights, daysLabel, firstName, formatDay, formatPercent, formatRate, formatSar, inviteText, listJoin, monthLabel,
  sarCompact, shareText, whatsappShareUrl, SETTLEMENT_EVERY_DAYS,
} from '../format';
import { useAxT } from '../i18n';
import { PROFILE_MISSING, USER_STATUS, labelOf, textOf } from '../labels';
import type { Tab } from '../nav';
import { profileProgress } from '../profile';
import { NAV } from '../shell';
import type { MeResponse } from '../types';
import { Badge, CopyButton, ErrorBox, Loading, Money, SectionTitle } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void }

function Stat({ icon, label, children, tone = '#E15A30' }: { icon: ReactNode; label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5 shadow-sm min-w-0">
      <div className="flex items-center gap-2 text-[12px] text-[#6E6557]">
        <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${tone}1A`, color: tone }}>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-[20px] font-bold text-[#1F1A13] leading-none truncate">{children}</div>
    </div>
  );
}

function Num({ n }: { n: number }) {
  return <bdi dir="ltr" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{Number.isFinite(n) ? n.toLocaleString('en-US') : 0}</bdi>;
}

/**
 * زرّ «مشاركة رابطي» العريض: قائمة المشاركة الأصلية في الجوال (`navigator.share`) بنصٍّ جاهز
 * — الإفصاح ثم سطر الدعوة ثم الرابط — وإلا واتساب. وبجانبه «نسخ الرابط».
 */
export function ShareLinkButtons({ me }: { me: MeResponse }) {
  const { t } = useAxT();
  const text = inviteText(me.settings.disclosureText, t('share.invite'), me.link);
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const canShare = !!nav && typeof nav.share === 'function';
  const share = async () => {
    try {
      await nav!.share({ title: 'Field Sales', text });
    } catch (e) {
      // ألغى السفير القائمة ⇒ لا شيء؛ وغير ذلك (WebView يرفض) ⇒ واتساب
      if ((e as { name?: string })?.name !== 'AbortError') window.open(whatsappShareUrl(text), '_blank', 'noopener,noreferrer');
    }
  };
  const wide = 'btn-primary w-full justify-center py-3.5 text-[15.5px] rounded-2xl';
  return (
    <div className="space-y-2">
      {canShare ? (
        <button type="button" onClick={() => void share()} className={wide}>
          <Share2 size={18} /> {t('share.cta')}
        </button>
      ) : (
        <a href={whatsappShareUrl(text)} target="_blank" rel="noopener noreferrer" className={wide}>
          <MessageCircle size={18} /> {t('share.whatsapp')}
        </a>
      )}
      <CopyButton text={me.link} label={t('link.copy')} className="w-full py-2.5" />
    </div>
  );
}

/** بطاقة الرابط والإفصاح — في «رابطي» */
export function LinkCard({ me }: { me: MeResponse }) {
  const { t } = useAxT();
  const text = shareText(me.settings.disclosureText, me.link);
  return (
    <div className="card space-y-3">
      <SectionTitle>{t('link.title')}</SectionTitle>
      <div dir="ltr" className="rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] px-3 py-2.5 text-[13.5px] font-semibold text-[#1F1A13] break-all select-all text-left">
        {me.link}
      </div>
      <ShareLinkButtons me={me} />
      {me.settings.disclosureText && (
        <div className="rounded-xl border border-[#F3D3C4] bg-[#FBEBE2]/50 p-3">
          <p className="text-[12px] font-bold text-[#7A3A20] mb-1">{t('link.disclosureTitle')}</p>
          <p className="text-[13.5px] text-[#1F1A13] leading-relaxed" dir="auto">{me.settings.disclosureText}</p>
          <div className="mt-2">
            <CopyButton text={text} label={t('link.copyWithDisclosure')} className="w-full" />
          </div>
        </div>
      )}
    </div>
  );
}

/** شريط «أكمل ملفك لاستلام أرباحك» بما ينقص — لا يحجب شيئاً، شرطٌ للصرف وحده */
export function CompleteProfileBanner({ me, openTab }: { me: MeResponse; openTab: (t: Tab) => void }) {
  const { t, lang } = useAxT();
  const progress = profileProgress(me.user);
  if (progress.complete) return null;
  const items = progress.missing.map((k) => textOf(PROFILE_MISSING, k, lang));
  return (
    <div role="status" className="rounded-2xl border border-[#F0D9A8] bg-[#FDF3DC] p-3.5 flex gap-3">
      <AlertTriangle size={20} className="shrink-0 mt-0.5 text-[#B7791F]" />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-bold text-[#6B4A0E]">{t('home.completeTitle')}</p>
        {items.length > 0 && <p className="text-[12.5px] text-[#8A5A0B] mt-0.5 leading-relaxed">{t('home.completeMissing', { items: listJoin(items, lang) })}</p>}
        <div className="mt-2 flex items-center gap-3">
          <div className="flex-1 h-1.5 rounded-full bg-[#F0D9A8] overflow-hidden" aria-hidden>
            <div className="h-full bg-[#B7791F] rounded-full" style={{ width: `${progress.percent}%` }} />
          </div>
          <bdi dir="ltr" className="text-[11.5px] font-bold text-[#8A5A0B]">{progress.percent}%</bdi>
        </div>
        <button type="button" onClick={() => openTab('profile')} className="mt-2.5 btn-primary py-2 px-4 text-[13px]">
          {t('home.completeCta')}
        </button>
      </div>
    </div>
  );
}

function Steps({ steps }: { steps: { account: boolean; shared: boolean; firstPaid: boolean } }) {
  const { t } = useAxT();
  if (steps.account && steps.shared && steps.firstPaid) return null;
  const rows: Array<[boolean, string]> = [
    [steps.account, t('steps.account')],
    [steps.shared, t('steps.shared')],
    [steps.firstPaid, t('steps.firstPaid')],
  ];
  return (
    <div className="card">
      <SectionTitle>{t('steps.title')}</SectionTitle>
      <ol className="grid grid-cols-3 gap-2">
        {rows.map(([done, label], i) => (
          <li key={label} className={`rounded-xl px-2 py-2.5 text-center border ${done ? 'bg-[#E4F1EA] border-[#CBE5D6]' : 'bg-white border-[#E9E1D3]'}`}>
            <span className={`mx-auto w-8 h-8 rounded-full flex items-center justify-center ${done ? 'text-[#1E7A52]' : 'text-[#B5AB9B]'}`}>
              {done ? <CheckCircle2 size={22} /> : <Circle size={20} />}
            </span>
            <span className="block text-[11px] text-[#8A8072] mt-0.5" dir="ltr">{i + 1}</span>
            <span className={`block text-[12px] font-semibold leading-snug ${done ? 'text-[#1E7A52]' : 'text-[#44403a]'}`}>{label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** أرباح ستة أشهر — أعمدة CSS خالصة، والقيمة الكاملة في title وفي نصّ القارئ */
function EarningsChart({ months }: { months: Array<{ month: string; halalas: number }> }) {
  const { t, lang } = useAxT();
  if (months.length === 0) return null;
  const heights = barHeights(months.map((p) => p.halalas));
  const empty = heights.every((h) => h === 0);
  const summary = months.map((p) => `${monthLabel(p.month, lang)}: ${formatSar(p.halalas, lang)}`).join(' · ');
  return (
    <div className="card">
      <SectionTitle>{t('chart.title')}</SectionTitle>
      <div role="img" aria-label={summary} className="flex items-stretch gap-1.5 sm:gap-3">
        {months.map((p, i) => (
          <div key={p.month} className="flex-1 min-w-0 flex flex-col items-center" title={`${monthLabel(p.month, lang)} — ${formatSar(p.halalas, lang)}`}>
            <span className="h-4 text-[10.5px] font-semibold text-[#6E6557] leading-4" dir="ltr">{p.halalas > 0 ? sarCompact(p.halalas) : ''}</span>
            <div className="w-full h-28 flex items-end justify-center border-b border-[#E9E1D3]">
              <div
                className={`w-full max-w-[34px] rounded-t-lg ${i === months.length - 1 ? 'bg-[#E15A30]' : 'bg-[#F0A48A]'}`}
                style={{ height: `${heights[i]}%` }}
              />
            </div>
            <span className="mt-1 text-[11px] text-[#6E6557] truncate max-w-full">{monthLabel(p.month, lang)}</span>
          </div>
        ))}
      </div>
      {empty && <p className="text-[12px] text-[#8A8072] mt-2 text-center">{t('chart.empty')}</p>}
    </div>
  );
}

export function HomeTab({ me, refreshMe, openTab, trialOn }: TabProps & { openTab: (t: Tab) => void; trialOn: boolean }) {
  const { t, rich, lang, dir } = useAxT();
  const d = useAxQuery(qk.dashboard, affiliateApi.dashboard, refreshMe);
  const s = me.settings;
  const view = d.data ? dashboardView(d.data, s.nextSettlementAt ?? null) : null;
  const every = daysLabel(s.settlementEveryDays || SETTLEMENT_EVERY_DAYS, lang);
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const quick: Tab[] = ['link', 'claims', ...(trialOn ? ['trial' as Tab] : []), 'missed', 'materials', 'pricing'];

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl font-bold text-[#1F1A13]">{t('home.hello', { name: firstName(me.user.fullName) })}</h1>
          <Badge value={labelOf(USER_STATUS, me.user.status, lang)} />
        </div>
        <p className="text-[13px] text-[#6E6557] mt-1 leading-relaxed">
          {rich('home.intro', { rate: <bdi dir="ltr">{formatRate(s.rateBps)}</bdi>, days: daysLabel(s.holdDays, lang) })}
        </p>
      </div>

      <CompleteProfileBanner me={me} openTab={openTab} />

      <ShareLinkButtons me={me} />

      {d.isLoading ? <Loading /> : d.isError || !d.data || !view ? (
        <ErrorBox err={d.error} onRetry={() => void d.refetch()} />
      ) : (
        <>
          <Steps steps={view.steps} />

          <div className="grid grid-cols-2 gap-2.5">
            <Stat icon={<Wallet size={15} />} label={t('kpi.totalEarned')} tone="#1E7A52"><Money h={view.totalEarnedHalalas} className="text-[17px]" /></Stat>
            <Stat icon={<Hourglass size={15} />} label={t('kpi.pendingSettlement')} tone="#E0A02C"><Money h={view.pendingSettlementHalalas} className="text-[17px]" /></Stat>
            <Stat icon={<Users size={15} />} label={t('kpi.activeReferrals')} tone="#1F1A13"><Num n={view.activeReferrals} /></Stat>
            <Stat icon={<Percent size={15} />} label={t('kpi.conversion')}><bdi dir="ltr">{formatPercent(view.conversionRate)}</bdi></Stat>
          </div>

          <EarningsChart months={view.months} />

          <div className="rounded-2xl bg-white border border-[#E9E1D3] px-3.5 py-3 flex gap-3 items-start">
            <span className="w-9 h-9 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center shrink-0"><CalendarClock size={18} /></span>
            <div className="min-w-0">
              {view.nextSettlementAt && (
                <p className="text-[14px] font-bold text-[#1F1A13]">{t('settle.next', { date: formatDay(view.nextSettlementAt, lang) })}</p>
              )}
              <p className="text-[12px] text-[#6E6557] leading-relaxed">{t('settle.every', { every, min: formatSar(s.minPayoutHalalas, lang) })}</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {([
              [<MousePointerClick key="c" size={14} />, t('stat.clicks'), d.data.clicks30d],
              [<Building2 key="s" size={14} />, t('stat.signups'), d.data.signups],
              [<BadgeCheck key="p" size={14} />, t('stat.paid'), d.data.paidCompanies],
            ] as Array<[ReactNode, string, number]>).map(([icon, label, n]) => (
              <div key={label} className="rounded-xl bg-white border border-[#E9E1D3] px-2.5 py-2 min-w-0">
                <p className="flex items-center gap-1 text-[10.5px] text-[#6E6557] leading-tight">{icon}<span className="truncate">{label}</span></p>
                <p className="text-[16px] font-bold text-[#1F1A13] mt-0.5"><Num n={n} /></p>
              </div>
            ))}
          </div>

          {d.data.adjustmentsHalalas !== 0 && (
            <div className="flex items-center justify-between gap-2 rounded-xl bg-white border border-[#E9E1D3] px-3.5 py-2.5 text-[13px]">
              <span className="inline-flex items-center gap-2 text-[#6E6557]"><Scale size={15} /> {t('home.adjustments')}</span>
              <Money h={d.data.adjustmentsHalalas} className="font-bold" />
            </div>
          )}
        </>
      )}

      <div>
        <SectionTitle>{t('quick.title')}</SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {quick.map((id) => {
            const { label, Icon } = NAV[id];
            return (
              <button
                key={id} type="button" onClick={() => openTab(id)}
                className="flex items-center gap-2.5 rounded-2xl bg-white border border-[#E9E1D3] px-3 py-3 text-start hover:border-[#E15A30] min-w-0"
              >
                <span className="w-8 h-8 rounded-lg bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center shrink-0"><Icon size={16} /></span>
                <span className="flex-1 min-w-0 text-[12.5px] font-semibold text-[#1F1A13] leading-snug">{t(label)}</span>
                <Chevron size={15} className="shrink-0 text-[#B5AB9B]" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function LinkTab({ me }: TabProps) {
  const { t } = useAxT();
  const { user } = me;
  return (
    <div className="space-y-4">
      <div className="card text-center">
        <p className="text-[12px] text-[#6E6557]">{t('link.code')}</p>
        <p dir="ltr" className="mt-1 text-[30px] font-bold tracking-[0.18em] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
          {user.code}
        </p>
        <p className="text-[12px] text-[#8A8072] mt-1">{t('link.codeHint')}</p>
        <div className="mt-3 flex justify-center"><CopyButton text={user.code} label={t('link.copyCode')} /></div>
      </div>

      <LinkCard me={me} />
    </div>
  );
}
