/**
 * حاجز أخطاء تبويب ربط الفوترة الكسول (في حزمة صفحة الإعدادات — صغير، بلا منطق التبويب ولا عباراته).
 *
 * بلا حاجز: فشل تحميل حزمة التبويب (نشرٌ على Render استبدل الملف المجزّأ والصفحة مفتوحة، أو انقطاع الشبكة) أو خطأ تشغيل
 * داخله يصعد إلى جذر React فتصير لوحة الإدارة كلها صفحة بيضاء وتضيع تعديلات «الإعدادات العامة» غير المحفوظة — وReact.lazy
 * يحفظ الوعد المرفوض فلا يُصلحه النقر على التبويب ثانيةً. هنا: لافتة بـ«إعادة المحاولة» (onRetry يُنشئ مكوّناً كسولاً جديداً
 * فيُعاد طلب الحزمة) و«تحديث الصفحة»، والنموذج العام يبقى مركّباً كما هو.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useTr } from '../../i18n/strings';

export interface ZatcaTabBoundaryProps {
  children: ReactNode;
  /** يُنشئ مكوّن التبويب الكسول من جديد (المحاولة السابقة محفوظة مرفوضة داخل React.lazy). */
  onRetry: () => void;
}

interface ZatcaTabBoundaryState {
  failed: boolean;
}

export default class ZatcaTabBoundary extends Component<ZatcaTabBoundaryProps, ZatcaTabBoundaryState> {
  state: ZatcaTabBoundaryState = { failed: false };

  static getDerivedStateFromError(): ZatcaTabBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    // الاسم وحده: رسالة خطأ داخل التبويب قد تحمل نصّاً من حالته (بيانات المنشأة أو رمز التحقق)
    console.warn('zatca.tab.error', error instanceof Error ? error.name : typeof error);
  }

  retry = (): void => {
    this.props.onRetry();
    this.setState({ failed: false });
  };

  render(): ReactNode {
    return this.state.failed ? <ZatcaTabLoadError onRetry={this.retry} /> : this.props.children;
  }
}

export function ZatcaTabLoadError({ onRetry }: { onRetry: () => void }) {
  const tr = useTr();
  return (
    <div className="card" role="alert">
      <div className="flex items-start gap-2.5 border rounded-xl px-4 py-3 text-sm leading-relaxed bg-[#FBE3DF] border-[#F2C4BC] text-[#8E2A1F]">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold">{tr('تعذر تحميل تبويب الفوترة الإلكترونية')}</p>
          <p className="mt-0.5 text-[13px]">{tr('ربما نشر تحديث جديد للمنصة أو انقطع الاتصال — تعديلات الإعدادات العامة غير المحفوظة باقية في تبويبها')}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <button type="button" className="btn-secondary" onClick={onRetry}><RefreshCw size={14} /> {tr('إعادة المحاولة')}</button>
        <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>{tr('تحديث الصفحة')}</button>
        <span className="text-xs text-[#6E6557]">{tr('تحديث الصفحة يمحو ما لم يحفظ — احفظ الإعدادات العامة أولا')}</span>
      </div>
    </div>
  );
}
