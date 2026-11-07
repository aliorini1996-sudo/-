/**
 * «أدوات التصميم» في محرّر القالب (طلب المالك ٣ نوفمبر ٢٠٢٦: «تطبيق التحرير نفسه على الطباعة الحرارية، وتغيير حجم الشعار وتحديد
 * مكانه حسب الرغبة، والتغيير الحرّ بفاتورة حرارية وA4») — pd_spec §C.(iv) P7:
 * - الشعار: حجمٌ بمنزلقة مستمرة بالمم (0.5) وخانة رقم، ومحاذاة يمين/وسط/يسار/بلا شعار (الرول أيضاً)، ومكانه قسماً مستقلاً: داخل
 *   الترويسة كاليوم، أو أعلى الورقة، أو بعد أي قسم.
 * - لكل قسم: الظهور والمحاذاة وحجم الخط والمسافة قبله وبعده (SectionStyleFields من المصمّم — نموذج بيانات واحد).
 * - شكل الجدول على الرول (الصفحة والنقطية في «التخطيط» كاليوم)، و«العودة» الجزئية.
 * بلا عميل الـAPI (يُختبر في node). كل كتابةٍ تمرّ بمساعدات designModel/withLayout، فقالبٌ لم يُلمس يطبع اليوم حرفياً.
 */
import { AlertTriangle, Info, RotateCcw } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import {
  LEGACY_THERMAL_ID, LOGO_POSITIONS, LOGO_POSITION_LABELS, QR_ORPHAN_NOTE, SECTION_LABELS, TABLE_STYLES, TABLE_STYLE_LABELS, isQrRemoved, layoutOf,
  sectionsFor, withLayout, withProfile,
  type PrintProfile, type PrintSettingsV1, type SectionId,
} from '../../lib/print/printSettings';
import {
  editableClassicCopy, freeIssues, logoMmOf, logoMmRange, resetCanvas, resetLogo, resetSections, withLogo, type DesignSel,
} from '../../lib/print/designModel';
import { qrHost, qrOrphan, resolveLayout } from '../../lib/print/layout';
import { NumInput, QrRemoveField, SectionStyleFields, StampsField, chipCls } from './designer/SectionStyleFields';
import { layoutEditable, logoChoices } from './PrintPreview';
import { useTaxOffPrint } from './taxOffPrint';

export interface PrintDesignToolsProps {
  p: PrintProfile;
  update(next: PrintProfile): void;
  phase2: boolean;
  selected?: DesignSel | null;
  onSelect?(s: DesignSel): void;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** اسم نسخة الكلاسيكي القابلة للتحرير (يُترجم في الواجهة) */
export const CLASSIC_COPY_NAME = 'شريط 58 مم قابل للتحرير';

/** الرول الكلاسيكي (الافتراضي legacy-58 أو نسخته roll_classic) — مجمّدٌ حرفياً، ويُحرَّر بنسخةٍ منه */
export function isClassicRoll(p: PrintProfile): boolean {
  return p.printer === 'thermal' && (p.id === LEGACY_THERMAL_ID || p.template === 'roll_classic');
}

/**
 * «تحرير الشريط الكلاسيكي» (B.3): القالب المفتوح يُكتب في الإعدادات (index null = يُضاف) ثم editableClassicCopy — نسخةٌ roll_compact
 * على ورقه يُوجَّه إليها ما كان يطبع به. الكلاسيكي نفسه لا يُمسّ، والتراجع إعادة التوجيه. null إن لم يكن كلاسيكياً أو بلغت القوالب حدّها.
 */
export function classicCopyFor(s: PrintSettingsV1, p: PrintProfile, index: number | null, name: string):
  { settings: PrintSettingsV1; index: number; profile: PrintProfile } | null {
  if (!isClassicRoll(p)) return null;
  const base = withProfile(s, p, index);
  const r = editableClassicCopy(base, p.id, name);
  if (!r.newId) return null;
  const i = r.settings.profiles.findIndex((x) => x.id === r.newId);
  return i < 0 ? null : { settings: r.settings, index: i, profile: r.settings.profiles[i] };
}

/** منزلقة حجم الشعار: حدود الورق (الرول حتى عرض حزمته المطبوعة)، والحجم الفعّال، ومطفأة حيث لا شعار */
export function logoSlider(p: PrintProfile): { min: number; max: number; step: number; value: number; disabled: boolean } {
  const [min, max] = logoMmRange(p);
  const l = layoutOf(p);
  const disabled = !layoutEditable(p) || !p.options.showLogo || p.template === 'impact_preprinted' || l.logo === 'none';
  return { min, max, step: 0.5, value: Math.min(max, Math.max(min, logoMmOf(p))), disabled };
}

export interface ToolRow { id: SectionId; hidden: boolean; styled: boolean }

/**
 * صفوف الأقسام بترتيب التصميم: المخفي، وما له تنسيق. لا قسم مقفل الظهور منذ قرار المالك ٤ نوفمبر ٢٠٢٦ («اجعل يمكن حذف كل شي حتى
 * كيو ار»): الأصناف ورمز QR الرول يُخفيان بتنبيهٍ قويّ وتأكيدٍ واحد (SectionStyleFields).
 */
export function toolRows(p: PrintProfile): ToolRow[] {
  const l = layoutOf(p);
  return sectionsFor(p.printer, l.design).map((id) => {
    const st = l.sections?.[id];
    return { id, hidden: st?.visible === false, styled: !!st && Object.keys(st).length > 0 };
  });
}

/** كتلة «رمز QR» في الأدوات: الصفحة والنقطية (القياسي وثنائي اللغة) — رمزها بلا قسمٍ في الترتيب، والرول يحذفه من صفّ قسمه */
export const qrToolBlock = (p: PrintProfile): boolean => layoutEditable(p) && p.printer !== 'thermal';

/** تنبيه «يطبع الرمز وحده»: القسم الحامل للرمز مخفيّ والرمز لم يُحذف صراحةً */
export function qrOrphanNote(p: PrintProfile): boolean {
  const l = layoutOf(p);
  const r = resolveLayout(p);
  return r !== null && !isQrRemoved(l) && qrOrphan(r, p.printer, l.design);
}

export default function PrintDesignTools({ p, update, phase2, selected = null, onSelect }: PrintDesignToolsProps) {
  const tr = useTr();
  // «إزالة الضريبة» (سياق تبويب «إعدادات الطباعة»): لا رمز QR ولا أختام حالةٍ للهيئة في أيّ مستندٍ لشركةٍ بلا ضريبة — فلا صفّ للرمز
  // ولا كتلة حذفه ولا تنبيه «يطبع الرمز وحده» ولا «أختام الحالة». بلا العلم: الأدوات كما كانت حرفاً
  const taxOff = useTaxOffPrint();
  if (!layoutEditable(p)) {
    return (
      <p className="text-xs text-[#6E6557] flex items-start gap-1.5" data-tools-locked="">
        <Info size={12} className="mt-0.5 shrink-0" />
        {isClassicRoll(p)
          ? tr('الرول الكلاسيكي يطبع كما هو حرفيا — «تحرير الشريط الكلاسيكي» ينشئ نسخة قابلة للتحرير ويوجه إليها مستنداته')
          : tr('هذا القالب الافتراضي لا يعدل مباشرة: انسخه أولا')}
      </p>
    );
  }
  const l = layoutOf(p);
  const thermal = p.printer === 'thermal';
  const preprinted = p.template === 'impact_preprinted';
  const slider = logoSlider(p);
  const logoOff = !p.options.showLogo || preprinted;
  const free = l.logoMm !== undefined || l.logoAfter !== undefined || l.sections !== undefined || l.canvas !== undefined || l.stamps !== undefined;
  const issues = freeIssues(p);
  const orphan = !taxOff && qrOrphanNote(p);
  const rows = taxOff ? toolRows(p).filter((r) => r.id !== 'qr') : toolRows(p);
  // «إزالة الضريبة»: لا «بعد: رمز QR» في موضع الشعار لشركةٍ بلا ضريبة (إلا موضعاً محفوظاً من قبل فيبقى ظاهراً كما هو)
  const sections = taxOff ? sectionsFor(p.printer, l.design).filter((s) => s !== 'qr' || l.logoAfter === 'qr') : sectionsFor(p.printer, l.design);
  const logoInCanvas = !!l.canvas?.boxes.some((b) => b.id === 'logo');
  const setLogoMm = (v: number) => update(withLogo(p, { logoMm: v }));
  const label = 'text-[11px] text-[#6E6557] min-w-[84px]';

  return (
    <div className="space-y-3" data-design-tools="">
      {!free && (
        <p className="text-[11px] text-[#6E6557] flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" />{tr('بلا تغيير هنا تبقى المطبوعة كما هي اليوم حرفيا')}</p>
      )}

      {/* الشعار: الحجم بالمم، والمحاذاة، والمكان */}
      {!preprinted && (
        <div className="rounded-xl border border-[#F1EBDF] px-2.5 py-2 space-y-1.5" data-tool-logo="">
          <span className="block text-xs font-bold text-[#1F1A13]">{tr('الشعار')}</span>
          {logoOff && <p className="text-[11px] text-[#9A8F7E]">{tr('شعار الشركة مطفأ في «المحتوى»')}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <span className={label}>{tr('حجم الشعار')}</span>
            <input type="range" min={slider.min} max={slider.max} step={slider.step} value={slider.value} disabled={slider.disabled}
              aria-label={tr('حجم الشعار')} className="w-36 accent-[#E15A30] disabled:opacity-40" style={{ touchAction: 'pan-y' }}
              onChange={(e) => setLogoMm(Number(e.target.value))} />
            <NumInput value={slider.value} label={tr('حجم الشعار')} suffix="mm" disabled={slider.disabled}
              clampFn={(v) => Math.round(Math.min(slider.max, Math.max(slider.min, v)) * 2) / 2} onCommit={setLogoMm} />
            {fin(l.logoMm) && (
              <button type="button" onClick={() => update(withLogo(p, { logoMm: null }))} className="text-[11px] text-[#6E6557] hover:text-[#C94E28]">
                {tr('الحجم التلقائي')}
              </button>
            )}
          </div>
          <p className="text-[11px] text-[#9A8F7E]">{tr('أقصى عرض وارتفاع للشعار')} · <span dir="ltr">{slider.min}–{slider.max} mm</span></p>
          <div role="group" aria-label={tr('مكان الشعار')} className="flex flex-wrap items-center gap-2">
            <span className={label}>{tr('المحاذاة')}</span>
            <div className="flex flex-wrap gap-1">
              {logoChoices(p).map((v) => (
                <button key={v} type="button" aria-pressed={l.logo === v} disabled={logoOff} onClick={() => update(withLogo(p, { logo: v }))} className={chipCls(l.logo === v)}>
                  {tr(LOGO_POSITION_LABELS[v])}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-wrap items-center gap-2">
            <span className={label}>{tr('موضع الشعار')}</span>
            <select className="input !py-1 text-xs w-auto max-w-full" data-logo-placement="" value={l.logoAfter ?? ''} disabled={logoOff || l.logo === 'none'}
              onChange={(e) => update(withLogo(p, { logoAfter: e.target.value === '' ? null : (e.target.value as SectionId | 'top') }))}>
              <option value="">{tr('داخل الترويسة كاليوم')}</option>
              <option value="top">{tr('أعلى الورقة')}</option>
              {sections.map((s) => <option key={s} value={s}>{tr('بعد')}: {tr(SECTION_LABELS[s])}</option>)}
            </select>
          </label>
          {logoInCanvas && <p className="text-[11px] text-[#9A8F7E]">{tr('مربع الشعار في لوحة الرأس أو التذييل يتقدم على هذا الموضع')}</p>}
          {thermal && <p className="text-[11px] text-[#9A8F7E]">{tr('الطباعة بالأبيض والأسود: الشعار الملون أو الفاتح قد يختفي')}</p>}
        </div>
      )}

      {/* شكل الجدول على الرول (B.3) — خطوطٌ أو شبكة أو فواصل منقّطة، بلا تظليل */}
      {thermal && (
        <div role="group" aria-label={tr('شكل الجدول')}>
          <span className="label">{tr('شكل الجدول')}</span>
          <div className="flex gap-1.5 flex-wrap">
            {TABLE_STYLES.map((t) => (
              <button key={t} type="button" aria-pressed={l.tableStyle === t} onClick={() => update(withLayout(p, { tableStyle: t }))} className={chipCls(l.tableStyle === t)}>
                {tr(TABLE_STYLE_LABELS[t])}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* أدوات كل قسم */}
      <div>
        <span className="label">{tr('تنسيق الأقسام')}</span>
        <div className="border border-[#E9E1D3] rounded-xl divide-y divide-[#F1EBDF]">
          {rows.map((row) => {
            const on = selected === row.id;
            return (
              <details key={row.id} data-tool-row={row.id} open={on} className={`px-2.5 py-1.5 ${on ? 'bg-[#FBEBE2]/50' : ''}`}>
                <summary className="text-sm cursor-pointer flex items-center gap-2 flex-wrap" aria-current={on ? 'true' : undefined}
                  onClick={() => onSelect?.(row.id)}>
                  <span className="text-[#1F1A13]">{tr(SECTION_LABELS[row.id])}</span>
                  {row.hidden && <span className="text-[10px] text-[#8E2A1F] bg-[#FBE3DF] rounded-full px-2 py-0.5">{tr('مخفي')}</span>}
                  {row.styled && !row.hidden && <span className="text-[10px] text-[#C94E28] bg-[#FBEBE2] rounded-full px-2 py-0.5">{tr('معدل')}</span>}
                </summary>
                <div className="pt-1.5">
                  <SectionStyleFields p={p} update={update} id={row.id} phase2={phase2} />
                </div>
              </details>
            );
          })}
        </div>
        {orphan && (
          <p className="text-[11px] text-[#6E6557] mt-1.5 flex items-start gap-1.5" data-qr-orphan="">
            <Info size={12} className="mt-0.5 shrink-0" />
            {tr(QR_ORPHAN_NOTE)} ({tr(SECTION_LABELS[qrHost(p.printer, l.design)])})
          </p>
        )}
      </div>

      {/* رمز QR في الصفحة والنقطية: ليس قسماً في الترتيب (يحمله قسم الإجماليات أو البيانات) — فحذفه هنا صراحةً بتنبيهٍ وتأكيد */}
      {!taxOff && qrToolBlock(p) && (
        <div className="rounded-xl border border-[#F1EBDF] px-2.5 py-2 space-y-1.5" data-tool-qr="">
          <span className="block text-xs font-bold text-[#1F1A13]">{tr(SECTION_LABELS.qr)}</span>
          <QrRemoveField p={p} update={update} />
        </div>
      )}

      {/* أختام الحالة (وسم المحاكاة وإشعار سند التسليم وختم الإلغاء) — لكل طابعة قابلة للتحرير */}
      {!taxOff && (
        <div className="rounded-xl border border-[#F1EBDF] px-2.5 py-2" data-tool-stamps="">
          <StampsField p={p} update={update} />
        </div>
      )}

      {issues.length > 0 && (
        <div className="space-y-1" role="alert">
          {issues.map((m) => <p key={m} className="text-xs text-red-600 flex items-start gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{tr(m)}</p>)}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <button type="button" className="btn-secondary !py-1 !px-3 text-xs" disabled={l.logoMm === undefined && l.logoAfter === undefined}
          onClick={() => update(resetLogo(p))}>
          <RotateCcw size={13} /> {tr('إعادة الشعار كاليوم')}
        </button>
        <button type="button" className="btn-secondary !py-1 !px-3 text-xs" disabled={l.sections === undefined} onClick={() => update(resetSections(p))}>
          <RotateCcw size={13} /> {tr('إعادة تنسيق الأقسام')}
        </button>
        {!thermal && l.canvas !== undefined && (
          <button type="button" className="btn-secondary !py-1 !px-3 text-xs" onClick={() => update(resetCanvas(p))}>
            <RotateCcw size={13} /> {tr('إلغاء التصميم بالسحب')}
          </button>
        )}
      </div>
    </div>
  );
}
