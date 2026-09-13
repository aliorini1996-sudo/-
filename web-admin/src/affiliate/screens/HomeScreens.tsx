// ============================================================================
// «الرئيسية» و«رابطي» — الإفصاح يسبق الرابط دائماً في كل ما يُنسخ أو يُشارك.
// ============================================================================
import type { ReactNode } from 'react';
import {
  MousePointerClick, Building2, BadgeCheck, Hourglass, CheckCircle2, Wallet, Scale, MessageCircle, Megaphone, Info,
} from 'lucide-react';
import { affiliateApi, qk } from '../api';
import { firstName, formatRate, formatSar, shareText, whatsappShareUrl } from '../format';
import type { MeResponse } from '../types';
import { CopyButton, ErrorBox, Loading, Money, SectionTitle } from '../ui';
import { useAxQuery } from '../useAx';

interface TabProps { me: MeResponse; refreshMe: () => void }

function Stat({ icon, label, children, tone = '#E15A30' }: { icon: ReactNode; label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-[#E9E1D3] p-3.5 shadow-sm">
      <div className="flex items-center gap-2 text-[12px] text-[#6E6557]">
        <span className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${tone}1A`, color: tone }}>{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-[20px] font-bold text-[#1F1A13] leading-none">{children}</div>
    </div>
  );
}

function Num({ n }: { n: number }) {
  return <bdi dir="ltr" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>{Number.isFinite(n) ? n.toLocaleString('en-US') : 0}</bdi>;
}

/** بطاقة الرابط والإفصاح — مشتركة بين الرئيسية ورابطي */
export function LinkCard({ me }: { me: MeResponse }) {
  const text = shareText(me.settings.disclosureText, me.link);
  return (
    <div className="card space-y-3">
      <SectionTitle>رابط الإحالة الخاص بك</SectionTitle>
      <div dir="ltr" className="rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] px-3 py-2.5 text-[13.5px] font-semibold text-[#1F1A13] break-all select-all text-left">
        {me.link}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <CopyButton text={me.link} label="نسخ الرابط" primary />
        <a
          href={whatsappShareUrl(text)} target="_blank" rel="noopener noreferrer"
          className="btn-secondary justify-center"
        >
          <MessageCircle size={15} /> واتساب
        </a>
      </div>
      {me.settings.disclosureText && (
        <div className="rounded-xl border border-[#F3D3C4] bg-[#FBEBE2]/50 p-3">
          <p className="text-[12px] font-bold text-[#7A3A20] mb-1">نصّ الإفصاح — أرفقه دائماً مع الرابط</p>
          <p className="text-[13.5px] text-[#1F1A13] leading-relaxed">{me.settings.disclosureText}</p>
          <div className="mt-2">
            <CopyButton text={text} label="نسخ الإفصاح مع الرابط" className="w-full" />
          </div>
        </div>
      )}
    </div>
  );
}

export function HomeTab({ me, refreshMe }: TabProps) {
  const d = useAxQuery(qk.dashboard, affiliateApi.dashboard, refreshMe);
  const s = me.settings;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-[#1F1A13]">أهلاً {firstName(me.user.fullName)}</h1>
        <p className="text-[13px] text-[#6E6557] mt-1 leading-relaxed">
          عمولتك {formatRate(s.rateBps)} من مبلغ الدفعة الأولى المؤكَّدة لكل منشأة تشترك عبرك، وتُعتمد بعد {s.holdDays} يوماً من الدفع.
        </p>
      </div>

      {d.isLoading ? <Loading /> : d.isError || !d.data ? (
        <ErrorBox err={d.error} onRetry={() => void d.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            <Stat icon={<MousePointerClick size={15} />} label="نقرات آخر 30 يوماً"><Num n={d.data.clicks30d} /></Stat>
            <Stat icon={<Building2 size={15} />} label="منشآت سجّلت" tone="#1F1A13"><Num n={d.data.signups} /></Stat>
            <Stat icon={<BadgeCheck size={15} />} label="منشآت دفعت" tone="#1E7A52"><Num n={d.data.paidCompanies} /></Stat>
            <Stat icon={<Hourglass size={15} />} label="عمولات معلّقة" tone="#E0A02C"><Money h={d.data.pendingHalalas} className="text-[17px]" /></Stat>
            <Stat icon={<CheckCircle2 size={15} />} label="عمولات معتمدة" tone="#1E7A52"><Money h={d.data.approvedHalalas} className="text-[17px]" /></Stat>
            <Stat icon={<Wallet size={15} />} label="عمولات مدفوعة"><Money h={d.data.paidHalalas} className="text-[17px]" /></Stat>
          </div>
          {d.data.adjustmentsHalalas !== 0 && (
            <div className="flex items-center justify-between gap-2 rounded-xl bg-white border border-[#E9E1D3] px-3.5 py-2.5 text-[13px]">
              <span className="inline-flex items-center gap-2 text-[#6E6557]"><Scale size={15} /> تسويات تُحتسب في دفعتك القادمة</span>
              <Money h={d.data.adjustmentsHalalas} className="font-bold" />
            </div>
          )}
        </>
      )}

      <LinkCard me={me} />

      <p className="flex gap-2 text-[12px] text-[#8A8072] leading-relaxed">
        <Info size={14} className="shrink-0 mt-0.5" />
        <span>تُحوَّل مستحقاتك المعتمدة يدوياً إلى حسابك البنكي متى بلغ رصيدك {formatSar(s.minPayoutHalalas)}.</span>
      </p>
    </div>
  );
}

export function LinkTab({ me }: TabProps) {
  const { user, settings } = me;
  return (
    <div className="space-y-4">
      <div className="card text-center">
        <p className="text-[12px] text-[#6E6557]">رمز الإحالة</p>
        <p dir="ltr" className="mt-1 text-[30px] font-bold tracking-[0.18em] text-[#1F1A13]" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
          {user.code}
        </p>
        <p className="text-[12px] text-[#8A8072] mt-1">تستطيع المنشأة كتابته يدوياً في خانة «رمز الإحالة» عند التسجيل</p>
        <div className="mt-3 flex justify-center"><CopyButton text={user.code} label="نسخ الرمز" /></div>
      </div>

      <LinkCard me={me} />

      <div className="card space-y-2.5">
        <SectionTitle>قبل أن تشارك</SectionTitle>
        <Rule>أفصح دائماً لمن ترسل له أنك تحصل على عمولة إن اشترك — أرفق نصّ الإفصاح كما هو.</Rule>
        <Rule>
          عند النشر العلني ضع وسم <b>«إعلان»</b> بوضوح على كل منشور، ويلزمك ترخيص «موثوق» ساري المفعول.
        </Rule>
        <Rule>لا رسائل جماعية ولا تواصل مع من لا تعرفه أو لم يأذن لك.</Rule>
        <Rule>تُنسب المنشأة لآخر رابط إحالة فتحته قبل التسجيل على الجهاز نفسه.</Rule>
        {!user.publicPromoter && (
          <div className="flex gap-2 rounded-xl bg-[#FAEFD8] text-[#8A5A0B] px-3 py-2.5 text-[12.5px] leading-relaxed">
            <Megaphone size={16} className="shrink-0 mt-0.5" />
            <span>حسابك مسجّل للإحالة الشخصية. إن أردت النشر العلني ففعّل «سأنشر علناً» من «الملف» وأدخل بيانات ترخيص موثوق.</span>
          </div>
        )}
        {settings.rateBps > 0 && (
          <p className="text-[12px] text-[#8A8072]">نسبة عمولتك الحالية {formatRate(settings.rateBps)}.</p>
        )}
      </div>
    </div>
  );
}

function Rule({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 text-[13px] text-[#44403a] leading-relaxed">
      <span className="mt-2 w-1.5 h-1.5 rounded-full bg-[#E15A30] shrink-0" />
      <span>{children}</span>
    </p>
  );
}
