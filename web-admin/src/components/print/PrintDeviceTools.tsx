import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { AlertTriangle, Bluetooth, Check, FlaskConical, Info, Link2, Printer, Ruler } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import {
  PRINT_NOTES, PRINT_SAMPLE_WATERMARK, geometry, isQrRemoved, layoutOf, type DevicePrintChoice, type PrintProfile,
} from '../../lib/print/printSettings';
import { DIRECT_PRINT_FALLBACK, DirectPrintError, PrintRefusedError } from '../../lib/print/printErrors';
import { buildCalibrationDocument as buildCalibrationPage, sampleBannerHtml, sampleInvoiceDoc, type CalibrationOptions } from '../../lib/print/calibration';
import { directPath, isIosLink, linkPrinter, linkedPrinter, onLateHandoff, printerForJob, type DirectLink } from '../../lib/print/transport/direct';
import {
  directAvailableFor, directHintFor, printHtmlDirect, printNodeDirect, supportsDirect, transportFor, type DirectOutcome, type PrintTransport,
} from '../../rep/printDirect';
import { printHtmlDocument, printPageNode } from '../../rep/printPage';
import { printThermalInvoice } from '../../rep/thermal';
import { PrintLookContext, lookFor } from '../../rep/printLook';
import { PrintDesignPreviewContext } from '../../rep/printDesignContext';
import { PrintTextsPreviewContext } from '../../rep/printTextsContext';
import { directOpts, withConnection } from '../../rep/printDevice';
import type { Company, InvoiceDoc } from '../../rep/RepDocuments';
import { DirectPrintOverlay, useDirectPrint } from './DirectPrintUi';
import { AppUpdateButton, AppUpdateHint } from './AppUpdatePrompt';
import { isTaxOff } from '../../lib/taxMode';
import { TAX_OFF_DEVICE_SAMPLE_NOTE, sampleWatermark, useTaxOffPrint } from './taxOffPrint';

/**
 * أدوات الطباعة على هذا الجهاز — «إعدادات الطباعة» M3 (التصميم §5.1 E و§5.2): طريقة الاتصال، و«ربط الطابعة»، وصفحة المعايرة،
 * والطباعة التجريبية. في تبويب الإعدادات (للقالب المفتوح ولو لم يُحفظ — فتُعاير القيم قبل حفظها) وفي «إعداد الطباعة على هذا
 * الجهاز» من شاشة المستند.
 *
 * تحلّ صفحة المعايرة محلّ اختبار الميدان M0: المالك يطبعها على MIP480 وPRO-V الحقيقيتين ويقرأ منها الإزاحة وعرض النقاط ومقاس
 * الرمز. والطباعة التجريبية تمرّ بالقوالب الحقيقية بمستندٍ نموذجيّ: قراره بيئة محاكاة ورمزه تجريبيّ (لا buildZatcaQr) وعليه
 * «نموذج اختبار — ليس مستندا ضريبيا» (§4.14).
 *
 * الطريقة لكل جهاز (localStorage): نظام الطباعة افتراضاً كما اليوم، والبلوتوث المباشر إن اختاره وكان Chrome يحمل Web Serial —
 * أو على أندرويد بلا Web Serial عبر تطبيق فيلد سيلز (جسر الطباعة: «ربط الطابعة» شاشة اختيارٍ في التطبيق نفسه)، أو في تطبيق
 * فيلد سيلز على الآيفون (الطابعة تُختار من شاشة التطبيق بلا إقرانٍ من الإعدادات وتُحفظ فيه، والصفحة تعرض اسمها).
 */
export default function PrintDeviceTools({ profile, systemProfile, name, company, renderSheet, choice, onChoice }: {
  profile: PrintProfile;
  /** ما يطبعه «نظام الطباعة» إن خالف profile (قالب الجهاز للبلوتوث والشريط الكلاسيكي بنظام الطباعة) — فتطابق التجربةُ الطباعة */
  systemProfile?: PrintProfile;
  name: string;
  company: Company | null | undefined;
  /** القالب الحقيقيّ للمستند النموذجيّ (PrintableInvoice) — يُمرَّر كي لا تتشابك الوحدات */
  renderSheet: (doc: InvoiceDoc, ref: Ref<HTMLDivElement>) => ReactNode;
  choice: DevicePrintChoice | null;
  onChoice: (c: DevicePrintChoice | null) => void;
}) {
  const tr = useTr();
  const direct = useDirectPrint();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string; fallback?: boolean; app?: 'hard' | 'soft' } | null>(null);
  const [linked, setLinked] = useState<boolean | null>(null);
  // اسم الطابعة المحفوظة في تطبيق الآيفون — Web Serial بلا اسم
  const [linkedName, setLinkedName] = useState<string | null>(null);

  const available = directAvailableFor(profile);
  // أندرويد بلا Web Serial: الطابعة تُختار وتُحفظ في التطبيق — الصفحة لا تعرف أهي مربوطة
  const appPath = directPath() === 'app';
  // تطبيق الآيفون: الطابعة تُختار في شاشته وتُحفظ فيه — والصفحة تعرف أهي مربوطة واسمها (كـWeb Serial)
  const iosPath = directPath() === 'ios-app';
  const hint = directHintFor(profile);
  const capable = supportsDirect(profile);
  const transport: PrintTransport = transportFor(profile, choice, available);
  const sample = useMemo(() => sampleInvoiceDoc(company, tr), [company, tr]);
  /* «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦): الشركة بلا ضريبة (علمها في ردّ /company، أو سياق تبويب «إعدادات الطباعة») — المستند
   * التجريبيّ بلا ضريبة (sampleInvoiceDoc يقرأ العلم نفسه)، وشريطه «نموذج اختبار» وحده، وصفحة المعايرة بلا عبارة ضريبية ولا رمز.
   * الاسمان أدناه يحجبان المستوردين في هذا النطاق — والشركة بضريبتها: القيمتان نفساهما حرفاً (sampleWatermark(false) هو الثابت) */
  const taxOff = useTaxOffPrint() || isTaxOff(company);
  const PRINT_SAMPLE_WATERMARK = sampleWatermark(taxOff);
  const buildCalibrationDocument = (p: PrintProfile, t: typeof tr, o: CalibrationOptions): string => buildCalibrationPage(p, t, taxOff ? { ...o, taxOff } : o);
  const look = useMemo(() => lookFor(profile), [profile]);
  const sysProfile = systemProfile ?? profile;
  const profileVia = (via: PrintTransport): PrintProfile => (via === 'bt-serial' ? profile : sysProfile);
  const classic = profileVia(transport).template === 'roll_classic';
  const sysClassic = sysProfile.template === 'roll_classic';

  const refreshLinked = () => linkedPrinter().then((p) => { setLinked(!!p); setLinkedName(p && isIosLink(p) ? p.name : null); });
  useEffect(() => {
    let alive = true;
    if (available && capable) linkedPrinter().then((p) => { if (alive) { setLinked(!!p); setLinkedName(p && isIosLink(p) ? p.name : null); } });
    return () => { alive = false; };
  }, [available, capable]);

  // فُتح التطبيق بعد المهلة والدعوة معروضة: الطباعة ⇒ حصيلة التسليم، و«ربط الطابعة» ⇒ لا رسالة
  const appHard = msg?.app === 'hard';
  useEffect(() => {
    if (!appHard) return undefined;
    return onLateHandoff((outcome) => setMsg((m) => {
      if (m?.app !== 'hard') return m;
      if (!m.fallback) return null;
      return outcome === 'done' ? { tone: 'ok', text: tr('✓ تم الإرسال إلى الطابعة') } : { tone: 'ok', text: '', app: 'soft' };
    }));
  }, [appHard, tr]);

  const setTransport = (t: PrintTransport) => { setMsg(null); onChoice(withConnection(choice, { transport: t })); };
  const link = async () => {
    setMsg(null);
    try {
      const r = await linkPrinter();
      if (r === 'linked') {
        setLinked(true);
        setMsg({ tone: 'ok', text: tr('تم ربط الطابعة') });
        if (iosPath) void refreshLinked();
      }
    } catch (e) {
      // أُغلقت شاشة الاختيار في تطبيق الآيفون بلا طابعة: اختيار المندوب نفسه — لا رسالة
      if (iosPath && e instanceof DirectPrintError && e.kind === 'pickPrinter') return;
      setMsg({
        tone: 'error', text: tr(e instanceof DirectPrintError ? e.message : 'تعذرت الطباعة المباشرة'),
        app: e instanceof DirectPrintError && (e.kind === 'appUpdate' || e.kind === 'appUpdateIos') ? 'hard' : undefined,
      });
    }
  };

  /** المهمة بطريقتها: المنفذ يُطلب أوّل الضغطة (الإيماءة صالحة) ثم الرسم والإرسال — وأخطاؤها رسائل بديلُها نظام الطباعة */
  const guarded = async (via: PrintTransport, job: (port: DirectLink | null) => Promise<DirectOutcome | void>) => {
    setBusy(true); setMsg(null);
    try {
      const port = via === 'bt-serial' ? await printerForJob() : null;
      if (port) setLinked(true);
      if (port && isIosLink(port) && port.name) setLinkedName(port.name);
      const r = await job(port);
      // سُلّمت للتطبيق بلا مفتاح ثقة: لا علامة نجاح — تلميح التحديث الهادئ
      if (port && r === 'handed') setMsg({ tone: 'ok', text: '', app: 'soft' });
      else if (port) setMsg({ tone: 'ok', text: tr(r === 'cancelled' ? 'ألغيت الطباعة' : '✓ تم الإرسال إلى الطابعة') });
    } catch (e) {
      if (e instanceof DirectPrintError) setMsg({ tone: 'error', text: tr(e.message), fallback: true, app: e.kind === 'appUpdate' || e.kind === 'appUpdateIos' ? 'hard' : undefined });
      else setMsg({ tone: 'error', text: tr(e instanceof PrintRefusedError ? e.message : 'تعذرت الطباعة تأكد من إعداد الطابعة') });
    }
    setBusy(false);
  };

  const calibrate = (via: PrintTransport) => guarded(via, async (port) => {
    if (port) return direct.run((ui) => printHtmlDirect(port, buildCalibrationDocument(profile, tr, { mode: 'raster', name }), profile, 'pages', ui), { ...directOpts(choice), label: tr('طباعة صفحة معايرة') });
    await printHtmlDocument(buildCalibrationDocument(sysProfile, tr, { mode: 'system', name }), sysProfile.paper.widthMm);
  });

  const testPrint = (via: PrintTransport) => guarded(via, async (port) => {
    // شريط «نموذج اختبار» على الورق دائماً ولو حذفت الشركة أختام الحالة (قرار المالك ٤ نوفمبر ٢٠٢٦): الورقة تحمل اسم الشركة ورقمها الضريبيّ
    const banner = sampleBannerHtml(tr(PRINT_SAMPLE_WATERMARK));
    if (profile.printer === 'thermal') {
      let outcome: DirectOutcome = 'done';
      await printThermalInvoice(sample, {
        profile: port ? profile : sysProfile, tr, sampleBanner: banner,
        raster: port ? async (html) => { outcome = await direct.run((ui) => printHtmlDirect(port, html, profile, 'copies', ui), { ...directOpts(choice), label: tr('طباعة تجريبية') }); } : null,
      });
      return outcome;
    }
    const node = sheetRef.current;
    if (!node) throw new Error('sample sheet');
    if (port) return direct.run((ui) => printNodeDirect(port, node, profile, [tr('الأصل'), tr('نسخة')], ui, banner), { ...directOpts(choice), label: tr('طباعة تجريبية') });
    await printPageNode(node, profile, [tr('الأصل'), tr('نسخة')], banner);
  });

  /** تلميح «بلوتوث مباشر» — بلا سببٍ تقنيّ على الجوال؛ نصّ المتصفح لسطح المكتب وحده (platform.ts directHint) */
  const directHintText = (): string => {
    switch (hint) {
      case 'ready': return tr('يرسل للطابعة مباشرة بلا تطبيق وسيط');
      case 'soon': return tr('تصل مع التحديث القادم لتطبيق فيلد سيلز');
      case 'updateIos': return tr('حدث تطبيق فيلد سيلز من App Store لتفعيلها');
      case 'iosApp': return tr('متاحة في تطبيق فيلد سيلز على الآيفون');
      case 'impactIos': return tr('الطابعة النقطية لا تطبع من الآيفون — اطبعها من جوال أندرويد أو شارك ملف PDF');
      default: return tr('الطباعة المباشرة تتطلب Chrome 138 أو أحدث');
    }
  };

  const radio = (t: PrintTransport, title: string, hint: string, disabled?: boolean) => {
    const on = transport === t;
    return (
      <button type="button" disabled={disabled} onClick={() => setTransport(t)}
        className={`w-full text-right rounded-xl border-2 px-3 py-2 flex items-center gap-3 transition-colors disabled:opacity-50 ${on ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#E9E1D3] bg-white'}`}>
        <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${on ? 'border-[#E15A30] bg-[#E15A30] text-white' : 'border-[#D8CDB9]'}`}>{on && <Check size={12} />}</span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-[#1F1A13]">{title}</span>
          <span className="block text-[11px] text-[#6E6557]">{hint}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] p-3 space-y-2">
        <p className="text-xs font-bold text-[#44403a]">{tr('طريقة الاتصال')}</p>
        {capable ? (
          <>
            {radio('bt-serial', tr('بلوتوث مباشر (موصى به)'), available ? tr('يرسل للطابعة مباشرة بلا تطبيق وسيط') : directHintText(), !available)}
            {!available && hint === 'updateIos' && <AppUpdateButton />}
            {radio('system', tr('نظام الطباعة في الجهاز'), profile.printer === 'impact' ? tr(PRINT_NOTES.impactDesktop) : sysClassic ? tr('الشريط الكلاسيكي يطبع كما اليوم بلا بلوتوث مباشر') : tr('خدمة الطباعة المثبتة في الجوال أو الكمبيوتر'))}
            {transport === 'bt-serial' && (
              <div className="pt-1 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {appPath ? (
                    <button type="button" onClick={link} className="btn-secondary !py-1 !px-3 text-xs"><Link2 size={13} /> {tr('ربط الطابعة')}</button>
                  ) : (
                    <>
                      <span className={`text-xs font-semibold flex items-center gap-1 ${linked ? 'text-[#1E7A52]' : 'text-[#9A8F7E]'}`}>
                        <Bluetooth size={13} /> {linked ? (linkedName ? `${tr('الطابعة مربوطة')}: ${linkedName}` : tr('الطابعة مربوطة')) : tr('لم تربط طابعة بعد')}
                      </span>
                      <button type="button" onClick={link} className="btn-secondary !py-1 !px-3 text-xs"><Link2 size={13} /> {linked ? tr('ربط طابعة أخرى') : tr('ربط الطابعة')}</button>
                    </>
                  )}
                </div>
                <p className="text-[11px] text-[#6E6557] flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" />{iosPath ? tr('شغل الطابعة وقربها من الجوال ثم اضغط ربط الطابعة — لا تقرنها من إعدادات البلوتوث في الآيفون') : tr('اقرن الطابعة أولا من إعدادات البلوتوث في الجوال')}</p>
                {/* لغة أوامر الطابعة الحرارية — صفة الطابعة المربوطة: ورقة الفحص الذاتي تقولها («Instruction Set») */}
                {profile.printer === 'thermal' && geometry(profile).feed === 'roll' && (
                  <div className="space-y-1.5" data-printer-lang="">
                    <p className="text-xs font-semibold text-[#44403a]">{tr('لغة أوامر الطابعة')}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {([['escpos', tr('إيصالات ESC/POS (الأغلب)')], ['tspl', tr('ملصقات TSPL')]] as const).map(([v, label]) => {
                        const on = (choice?.lang ?? 'escpos') === v;
                        return (
                          <button key={v} type="button" aria-pressed={on} onClick={() => { setMsg(null); onChoice(withConnection(choice, { lang: v })); }}
                            className={`rounded-lg border-2 px-2 py-1.5 text-xs font-semibold ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#44403a]'}`}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-[#6E6557]">{tr('من ورقة الفحص الذاتي للطابعة سطر Instruction Set')}</p>
                    {choice?.lang === 'tspl' && (
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#E15A30]" checked={!!choice?.tsplFlip} onChange={(e) => onChoice(withConnection(choice, { tsplFlip: e.target.checked }))} />
                        <span className="text-xs text-[#44403a]">{tr('اقلب اتجاه الطباعة — إن خرجت الورقة مقلوبة')}</span>
                      </label>
                    )}
                  </div>
                )}
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#E15A30]" checked={!!choice?.slow} onChange={(e) => onChoice(withConnection(choice, { slow: e.target.checked }))} />
                  <span className="text-xs text-[#44403a]">{tr('رابط بطيء — لطابعة تفقد أجزاء من الورقة')}</span>
                </label>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-[#6E6557]">
            {tr('نظام الطباعة في الجهاز')}
            {classic && <> — {tr('الشريط الكلاسيكي يطبع كما اليوم بلا بلوتوث مباشر')}</>}
          </p>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <button type="button" disabled={busy} onClick={() => calibrate(transport)} className="btn-secondary disabled:opacity-60"><Ruler size={15} /> {tr('طباعة صفحة معايرة')}</button>
        {!classic && (
          <button type="button" disabled={busy} onClick={() => testPrint(transport)} className="btn-secondary disabled:opacity-60"><FlaskConical size={15} /> {tr('طباعة تجريبية')}</button>
        )}
      </div>
      {!isQrRemoved(layoutOf(profile)) && (
        <p className="text-[11px] text-[#9A8F7E]">{taxOff ? tr(TAX_OFF_DEVICE_SAMPLE_NOTE) : tr('المعاينة والاختبار يحملان «نموذج اختبار — ليس مستندا ضريبيا» ورمزا تجريبيا')}</p>
      )}

      {msg && msg.app === 'soft' && <AppUpdateHint />}
      {msg && msg.app !== 'soft' && (
        <div className={`rounded-xl border px-3 py-2 text-xs leading-relaxed ${msg.tone === 'ok' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`} role={msg.tone === 'error' ? 'alert' : 'status'}>
          <p className="flex items-start gap-1.5">{msg.tone === 'error' && <AlertTriangle size={13} className="mt-0.5 shrink-0" />}{msg.text}</p>
          {msg.app === 'hard' && !msg.fallback && <AppUpdateButton />}
          {msg.fallback && (
            <>
              {msg.app === 'hard' ? <AppUpdateButton /> : <p className="mt-1 text-[#6E6557]">{tr(DIRECT_PRINT_FALLBACK)}</p>}
              <div className="flex gap-2 flex-wrap mt-2">
                <button type="button" disabled={busy} onClick={() => calibrate('system')} className="btn-secondary !py-1 !px-3 text-xs"><Printer size={13} /> {tr('معايرة بنظام الطباعة')}</button>
                {!sysClassic && <button type="button" disabled={busy} onClick={() => testPrint('system')} className="btn-secondary !py-1 !px-3 text-xs"><Printer size={13} /> {tr('تجربة بنظام الطباعة')}</button>}
              </div>
            </>
          )}
        </div>
      )}

      {/* المستند النموذجيّ للقوالب الصفحية والنقطية — خارج الشاشة بمظهر هذا القالب (وتخطيطه الحرّ: الشعار والأقسام واللوحتان)،
          يُستنسخ للطباعة أو يُرسم للبلوتوث. طباعةٌ حقيقية: لا وسوم مصمّم (data-pd) ولا معاينة نصوص ولو فُتحت الأدوات داخل محرّر */}
      {profile.printer !== 'thermal' && (
        <div style={{ position: 'fixed', top: 0, left: '-10000px', zIndex: -1 }} aria-hidden>
          <PrintDesignPreviewContext.Provider value={null}>
            <PrintTextsPreviewContext.Provider value={null}>
              <PrintLookContext.Provider value={look}>{renderSheet(sample, sheetRef)}</PrintLookContext.Provider>
            </PrintTextsPreviewContext.Provider>
          </PrintDesignPreviewContext.Provider>
        </div>
      )}
      <DirectPrintOverlay job={direct.job} onCancel={direct.cancel} />
    </div>
  );
}
