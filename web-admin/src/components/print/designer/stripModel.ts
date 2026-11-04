/**
 * «المصمّم الحرّ» — منطق الشريط الحراري الخالص (بلا React ولا designModel) فيُختبر في node: إلى أين يقع القسم المسحوب،
 * وهل تقبله قواعد الترتيب (canMoveSection/moveSection)، وأماكن كتلة الشعار للأسهم، والمحاذاة الحالية.
 */
import {
  canMoveSection, layoutOf, moveSection, normalizeSectionOrder,
  type Align, type PrintProfile, type SectionId,
} from '../../../lib/print/printSettings';
import { indexFromY, moveIndexBefore, type StripBlock } from './designerMath';

/**
 * أماكن كتلة الشعار بالترتيب (للأسهم): أعلى الورقة، داخل الترويسة (null)، ثم بعد كل قسم — ومنها «بعد الترويسة» ('header')
 * التي يصل إليها الإفلات (logoAfterFromDrop) وقائمة الأدوات؛ لو غابت لقفز ↓ منها إلى «أعلى الورقة».
 */
export function logoPlacements(p: PrintProfile): Array<SectionId | 'top' | null> {
  const l = layoutOf(p);
  const order = normalizeSectionOrder(l.order, p.printer, l.design);
  return ['top', null, ...order];
}

/** المحاذاة الحالية لقسمٍ في الرول (المحفوظة، وإلا الوسط) */
export function rollAlignOf(p: PrintProfile, sel: string): Align {
  const l = layoutOf(p);
  if (sel === 'logo') return l.logo === 'none' ? 'center' : l.logo;
  return l.sections?.[sel as SectionId]?.align ?? 'center';
}

/** نقل قسمٍ ليقع قبل beforeId — القالب كما هو إن منعت القاعدة */
export function withSectionBefore(p: PrintProfile, id: SectionId, beforeId: SectionId | null): PrintProfile {
  const l = layoutOf(p);
  const order = normalizeSectionOrder(l.order, p.printer, l.design);
  const to = moveIndexBefore(order, id, beforeId);
  if (to === null || !canMoveSection(p, id, to)) return p;
  return moveSection(p, id, to);
}

/** نقطة الإفلات لقسم: قبل أيّ قسمٍ مرسوم (أو آخراً)، وهل تقبلها القواعد */
export function sectionDrop(p: PrintProfile, blocks: readonly StripBlock[], id: SectionId, y: number): { beforeId: SectionId | null; ok: boolean; changed: boolean } {
  const others = blocks.filter((b) => b.sel !== 'logo' && b.sel !== id);
  const i = indexFromY(others.map((b) => b.top + b.height / 2), y);
  const beforeId = (others[i]?.sel ?? null) as SectionId | null;
  const next = withSectionBefore(p, id, beforeId);
  const l = layoutOf(p);
  const order = normalizeSectionOrder(l.order, p.printer, l.design);
  // الإفلات في موضعه نفسه ليس مخالفة (لا تغيير)، وما سواه مقبولٌ إن غيّرته القاعدة فعلاً
  const noop = moveIndexBefore(order, id, beforeId) === order.indexOf(id);
  return { beforeId, ok: noop || next !== p, changed: next !== p };
}
