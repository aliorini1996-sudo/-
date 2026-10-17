import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useTr } from '../../i18n/strings';

/**
 * حاجز أخطاء تبويب «فرق العمل» الكسول في إعدادات الشركة: فشل تحميل حزمته (نُشر تحديثٌ والصفحة مفتوحة، أو انقطاع) لا
 * يُسقط الصفحة كلها فيضيع ما لم يُحفظ في الإعدادات العامة — بل لافتةٌ وإعادة محاولة (onRetry يعيد تركيب المكوّن الكسول).
 */
export default class TeamsTabBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  retry = () => { this.setState({ failed: false }); this.props.onRetry(); };
  render(): ReactNode {
    return this.state.failed ? <TeamsTabLoadError onRetry={this.retry} /> : this.props.children;
  }
}

function TeamsTabLoadError({ onRetry }: { onRetry: () => void }) {
  const tr = useTr();
  return (
    <div className="card" role="alert">
      <div className="flex items-start gap-2.5 border rounded-xl px-4 py-3 text-sm bg-[#FBE3DF] border-[#F2C4BC] text-[#8E2A1F]">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <p className="font-semibold">{tr('تعذر تحميل تبويب فرق العمل')}</p>
      </div>
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <button type="button" className="btn-secondary" onClick={onRetry}><RefreshCw size={14} /> {tr('إعادة المحاولة')}</button>
        <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>{tr('تحديث الصفحة')}</button>
      </div>
    </div>
  );
}
