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
import type { Company, InvoiceDoc } from './RepDocuments';

/**
 * «إعداد الطباعة على هذا الجهاز» (التصميم §5.2) — من سطر «الطابعة: … · تغيير» تحت زرّ الطباعة.
 *
 * يختار الجهاز قالب هذا النوع من المستندات بين قوالب الشركة (حين تسمح الشركة بذلك)، أو يعود لاختيار الشركة. يُحفظ على
 * الجهاز وحده (rep/printDevice.ts): الطابعة صفةُ السيارة أو الجوال. ومنذ M3 هنا أيضاً طريقة الاتصال (البلوتوث المباشر أو
 * نظام الطباعة) و«ربط الطابعة» وصفحة المعايرة والطباعة التجريبية (components/print/PrintDeviceTools.tsx) — للقالب الفعّال.
 */
export default function PrintDeviceSheet({ settings, kind, current, chosenId, onPick, choice, onChoice, company, renderSheet, onClose }: {
  settings: PrintSettingsV1;
  kind: PrintDocKind;
  /** القالب الفعّال الآن (اختيار الجهاز أو الشركة) */
  current: PrintProfile;
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
  const canPick = settings.repMayChoose && profiles.length > 1;

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

        <p className="text-xs text-[#6E6557] mb-2">{tr('الطابعة')}: <b className="text-[#1F1A13]">{profileDisplayName(current, tr)}</b> — {hintOf(current)}</p>
        <PrintDeviceTools profile={current} name={profileDisplayName(current, tr)} company={company} renderSheet={renderSheet} choice={choice} onChoice={onChoice} />
        <p className="text-[11px] text-[#9A8F7E] mt-3">{tr('يحفظ اختيارك على هذا الجهاز وحده')}</p>

        <button type="button" onClick={onClose} className="mt-4 w-full bg-[#1F1A13] text-white font-semibold py-3 rounded-xl">{tr('تم')}</button>
      </div>
    </div>
  );
}
