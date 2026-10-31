import { useEffect, type ReactNode, type Ref } from 'react';
import { Check, Printer, X } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { backdropClose } from '../lib/backdropClose';
import { useBackClose } from '../lib/useBackClose';
import {
  DOC_KIND_LABELS, PRESET_LABELS, PRINTER_SHORT, TEMPLATE_LABELS, deviceProfilesFor, profileDisplayName,
  type DevicePrintChoice, type PrintDocKind, type PrintProfile, type PrintSettingsV1,
} from '../lib/print/printSettings';
import PrintDeviceTools from '../components/print/PrintDeviceTools';
import { fromRollView, rollViewOf, withConnection } from './printDevice';
import type { Company, InvoiceDoc } from './RepDocuments';

/**
 * «إعداد الطباعة على هذا الجهاز» (التصميم §5.2) — من سطر «الطابعة: … · تغيير» تحت زرّ الطباعة.
 *
 * يختار الجهاز قالب هذا النوع من المستندات بين قوالب الشركة (حين تسمح الشركة بذلك)، أو يعود لاختيار الشركة. يُحفظ على
 * الجهاز وحده (rep/printDevice.ts): الطابعة صفةُ السيارة أو الجوال. ومنذ M3 هنا أيضاً طريقة الاتصال (البلوتوث المباشر أو
 * نظام الطباعة) و«ربط الطابعة» وصفحة المعايرة والطباعة التجريبية (components/print/PrintDeviceTools.tsx) — للقالب الفعّال.
 * ولقالب الجهاز (deviceRoll: شريطٌ كلاسيكيّ أو شركةٌ بلا إعدادات) عرض رول هذه الطابعة 58/80 مم للبلوتوث المباشر.
 */
export default function PrintDeviceSheet({ settings, kind, current, deviceRoll = false, systemProfile, pickable = true, chosenId, onPick, choice, onChoice, company, renderSheet, onClose }: {
  settings: PrintSettingsV1;
  kind: PrintDocKind;
  /** القالب الفعّال الآن (اختيار الجهاز أو الشركة) — أو قالب الجهاز deviceRollProfile حين deviceRoll */
  current: PrintProfile;
  /** القالب قالب الجهاز (rep/RepDocuments.tsx: deviceRoll) — يُختار عرض الرول هنا */
  deviceRoll?: boolean;
  /** قالب المستند حين deviceRoll — ما يطبعه «نظام الطباعة» فعلاً (الشريط الكلاسيكي)، فتطابقه المعايرة والتجربة بتلك الطريقة */
  systemProfile?: PrintProfile;
  /** للجهاز أن يختار بين قوالب الشركة — لا لشركةٍ بلا إعدادات مخصّصة (اختيارٌ لا يُقرأ فلا يُعرض) */
  pickable?: boolean;
  /** ما حفظه الجهاز لهذا النوع — null = اختيار الشركة */
  chosenId: string | null;
  onPick: (profileId: string | null) => void;
  /** اختيار الجهاز كاملاً (الطريقة والرابط البطيء) */
  choice: DevicePrintChoice | null;
  onChoice: (c: DevicePrintChoice | null) => void;
  /** للطباعة التجريبية: بيانات الشركة والقالب الحقيقيّ */
  company: Company | null | undefined;
  renderSheet: (doc: InvoiceDoc, ref: Ref<HTMLDivElement>) => ReactNode;
  onClose: () => void;
}) {
  const tr = useTr();
  useBackClose(true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const profiles = deviceProfilesFor(settings, kind);
  const companyId = settings.routing[kind];
  const companyProfile = profiles.find((p) => p.id === companyId) ?? null;
  // اختيارٌ محفوظ لقالبٍ حُذف لا يُعلَّم: الفعّال حينها اختيار الشركة
  const chosen = chosenId !== null && profiles.some((p) => p.id === chosenId) ? chosenId : null;
  // الاختيار بين القوالب بإذن الشركة وحده؛ والطريقة والمعايرة لكل جهازٍ دائماً
  const canPick = pickable && settings.repMayChoose && profiles.length > 1;

  const Option = ({ id, title, hint }: { id: string | null; title: string; hint: string }) => {
    const on = chosen === id;
    return (
      <button type="button" onClick={() => onPick(id)}
        className={`w-full text-right rounded-xl border-2 px-3 py-2.5 flex items-center gap-3 transition-colors ${on ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#E9E1D3] bg-white'}`}>
        <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${on ? 'border-[#E15A30] bg-[#E15A30] text-white' : 'border-[#D8CDB9]'}`}>
          {on && <Check size={12} />}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-[#1F1A13]">{title}</span>
          <span className="block text-[11px] text-[#6E6557]">{hint}</span>
        </span>
      </button>
    );
  };
  const hintOf = (p: PrintProfile) => `${tr(PRINTER_SHORT[p.printer])} · ${tr(PRESET_LABELS[p.paper.preset])} · ${tr(TEMPLATE_LABELS[p.template])}`;

  return (
    <div className="fixed inset-0 z-[1250] bg-black/40 flex items-end sm:items-center justify-center" {...backdropClose(onClose)}>
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-4 max-h-[85vh] overflow-y-auto"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="font-bold text-[#1F1A13] flex items-center gap-2"><Printer size={17} className="text-[#E15A30]" /> {tr('إعداد الطباعة على هذا الجهاز')}</p>
            <p className="text-xs text-[#6E6557] mt-0.5">{tr(DOC_KIND_LABELS[kind])}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={tr('إغلاق')} className="p-1.5 rounded-lg text-[#6E6557] hover:bg-[#FAF7F0]"><X size={18} /></button>
        </div>

        {canPick && (
          <div className="space-y-2 mb-4">
            <Option id={null} title={tr('اختيار الشركة')} hint={companyProfile ? profileDisplayName(companyProfile, tr) : '—'} />
            {profiles.map((p) => <Option key={p.id} id={p.id} title={profileDisplayName(p, tr)} hint={hintOf(p)} />)}
          </div>
        )}

        {deviceRoll && (
          <div className="rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] p-3 mb-3 space-y-2" data-device-roll="">
            <p className="text-xs font-bold text-[#44403a]">{tr('عرض ورق الطابعة')}</p>
            <div className="grid grid-cols-2 gap-2">
              {([58, 80] as const).map((mm) => {
                const on = (choice?.rollMm ?? 58) === mm;
                return (
                  <button key={mm} type="button" aria-pressed={on} onClick={() => onChoice(withConnection(choice, { rollMm: mm }))}
                    className={`rounded-xl border-2 px-3 py-2 text-sm font-semibold transition-colors ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#44403a]'}`}>
                    {tr(mm === 80 ? 'رول 80 مم' : 'رول 58 مم')}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-[#6E6557]">{tr('للبلوتوث المباشر — يطبع الشريط المختصر بهذا العرض')}</p>
          </div>
        )}
        <p className="text-xs text-[#6E6557] mb-2">{tr('الطابعة')}: <b className="text-[#1F1A13]">{profileDisplayName(current, tr)}</b> — {hintOf(current)}</p>
        {/* قالب الجهاز: طريقته rollVia مستقلةٌ عن طريقة قوالب الشركة (rep/printDevice.ts: rollViewOf/fromRollView) */}
        <PrintDeviceTools profile={current} name={profileDisplayName(current, tr)} company={company} renderSheet={renderSheet}
          systemProfile={deviceRoll ? systemProfile : undefined}
          choice={deviceRoll ? rollViewOf(choice) : choice}
          onChoice={deviceRoll ? (c) => onChoice(fromRollView(choice, c)) : onChoice} />
        <p className="text-[11px] text-[#9A8F7E] mt-3">{tr('يحفظ اختيارك على هذا الجهاز وحده')}</p>

        <button type="button" onClick={onClose} className="mt-4 w-full bg-[#1F1A13] text-white font-semibold py-3 rounded-xl">{tr('تم')}</button>
      </div>
    </div>
  );
}
