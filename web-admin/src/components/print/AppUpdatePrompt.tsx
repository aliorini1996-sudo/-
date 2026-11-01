import { Download } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { PLAY_STORE_URL } from '../../lib/print/transport/bridgeContract';

/**
 * دعوة تحديث تطبيق فيلد سيلز من Google Play — الرسالة الوحيدة على أندرويد حين لا تصل الطباعة المباشرة، بلا أيّ سببٍ تقنيّ.
 * الزرّ رابطٌ في نافذةٍ جديدة: Chrome يسلّم play.google.com لتطبيق المتجر، وإلا فتبويبٌ آخر — والصفحة لا تُغادَر أبداً.
 */
export function AppUpdateButton() {
  const tr = useTr();
  return (
    <a href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer"
      className="mt-2 w-full bg-white border border-[#DED5C4] text-[#1F1A13] font-semibold py-2 rounded-lg flex items-center justify-center gap-2">
      <Download size={15} className="shrink-0" /> {tr('تحديث التطبيق')}
    </a>
  );
}

/** تلميحٌ هادئ بعد تسليمٍ بلا مفتاح ثقة: لا علامة نجاح — إن لم تخرج الورقة فالتحديث */
export function AppUpdateHint() {
  const tr = useTr();
  return (
    <div className="bg-amber-50 border border-amber-200 text-amber-900 text-xs leading-relaxed rounded-xl p-3 text-center" role="status">
      <p>{tr('إن لم تطبع الورقة فحدث تطبيق فيلد سيلز من Google Play')}</p>
      <AppUpdateButton />
    </div>
  );
}
