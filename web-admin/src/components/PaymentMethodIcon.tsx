import {
  Banknote, Coins, CreditCard, FileCheck, Gift, Globe, Handshake, Landmark, QrCode, Receipt, Smartphone, Store, Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { MethodIcon } from '../lib/paymentMethodsConfig';

/**
 * أيقونات «إدارة طرق الدفع» — القائمة المغلقة في النواة (METHOD_ICONS) مربوطةً بمكوّنات lucide هنا وحدها: النواة تبقى صرفة
 * (تُنسخ للخادم وتُختبر في node)، والإعداد يحمل اسماً لا صورةً ولا رابطاً. المدمجة بأيقوناتها في صفحة «طرق الدفع» منذ إطلاقها،
 * والمخصّصة بما اختارته الشركة — وإلا أيقونة أساسها.
 */
export const METHOD_ICON_COMPONENTS: Record<MethodIcon, LucideIcon> = {
  wallet: Wallet, smartphone: Smartphone, 'credit-card': CreditCard, banknote: Banknote, landmark: Landmark, 'qr-code': QrCode,
  coins: Coins, gift: Gift, receipt: Receipt, handshake: Handshake, store: Store, globe: Globe,
};

export const BUILTIN_METHOD_ICONS: Record<string, LucideIcon> = {
  CASH: Banknote, POS: CreditCard, BANK_TRANSFER: Landmark, CHEQUE: FileCheck, ONLINE: Globe,
};

/** أيقونة طريقة: المختارة للمخصّصة، وإلا أيقونة الأساس، وإلا محفظة لقيمةٍ قديمة مجهولة */
export function methodIconComponent(icon: string | null | undefined, base: string): LucideIcon {
  if (icon && icon in METHOD_ICON_COMPONENTS) return METHOD_ICON_COMPONENTS[icon as MethodIcon];
  return BUILTIN_METHOD_ICONS[base] ?? Wallet;
}

export default function PaymentMethodIcon({ icon, base, size = 14, className }: { icon?: string | null; base: string; size?: number; className?: string }) {
  const Icon = methodIconComponent(icon, base);
  return <Icon size={size} className={className} />;
}
