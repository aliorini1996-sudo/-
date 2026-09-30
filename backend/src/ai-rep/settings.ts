/**
 * المندوب الذكي — إعدادات كل شركة (قيم افتراضية، وتحقّق، وقراءة آمنة).
 * العلم نفسه (Tenant.aiRepEnabled) بيد المالك؛ هذه الإعدادات بيد إدارة الشركة.
 */
import { z } from 'zod';
import { OUTLET_TYPE_CODES } from './taxonomy';

export interface AiRepSettingsView {
  targetOutletTypes: string[];
  searchRadiusM: number;
  priorityProductIds: string[];
  estimateWindowMonths: number;
  minPeers: number;
  showMoney: boolean;
  repScope: 'ALL' | 'SELECTED';
  repIds: string[];
  dailySearchesPerRep: number;
  playbook: string | null;
  advisorEnabled: boolean;
  dailyChatTurnsPerRep: number;
  /** حلقة التعلّم: AUTO | REVIEW (دروس المراجعة الذاتية بانتظار الإدارة) | OFF (سلوك ما قبل التعلّم؛ الإشارات تُسجَّل) */
  learningMode: 'AUTO' | 'REVIEW' | 'OFF';
  /** نسبة المجموعة الضابطة (ترتيب الفرص والدروس فقط): 0 | 10 | 20 | 30 */
  holdoutPct: number;
}

export const DEFAULT_AI_REP_SETTINGS: AiRepSettingsView = Object.freeze({
  targetOutletTypes: ['GROCERY', 'MINIMARKET', 'SUPERMARKET'],
  searchRadiusM: 2000,
  priorityProductIds: [],
  estimateWindowMonths: 6,
  minPeers: 5,
  showMoney: true,
  repScope: 'ALL',
  repIds: [],
  dailySearchesPerRep: 30,
  playbook: null,
  advisorEnabled: true,
  dailyChatTurnsPerRep: 40,
  learningMode: 'AUTO',
  holdoutPct: 20,
}) as AiRepSettingsView;

const outletCode = z.enum(OUTLET_TYPE_CODES as unknown as [string, ...string[]]);

export const NO_SELECTED_REPS = 'اختر مندوباً واحداً على الأقل';

export const aiRepSettingsSchema = z.object({
  targetOutletTypes: z.array(outletCode).min(1, 'اختر نوع محل واحداً على الأقل').max(11).optional(),
  searchRadiusM: z.number().int().min(300).max(10000).optional(),
  priorityProductIds: z.array(z.string().min(1)).max(20).optional(),
  estimateWindowMonths: z.number().int().min(3).max(12).optional(),
  // حدّ خصوصية: لا يُسمح بأقل من ٥ محلات مشابهة لعرض رقم
  minPeers: z.number().int().min(5).max(20).optional(),
  showMoney: z.boolean().optional(),
  repScope: z.enum(['ALL', 'SELECTED']).optional(),
  repIds: z.array(z.string().min(1)).max(5000).optional(),
  dailySearchesPerRep: z.number().int().min(5).max(100).optional(),
  playbook: z.string().max(4000).nullish(),
  advisorEnabled: z.boolean().optional(),
  dailyChatTurnsPerRep: z.number().int().min(5).max(150).optional(),
  learningMode: z.enum(['AUTO', 'REVIEW', 'OFF']).optional(),
  holdoutPct: z.union([z.literal(0), z.literal(10), z.literal(20), z.literal(30)]).optional(),
}).superRefine((s, ctx) => {
  // «مناديب محدّدون» بلا أحد ⇒ الزرّ يختفي عن كل المناديب بلا تفسير
  if (s.repScope === 'SELECTED' && s.repIds && !s.repIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repIds'], message: NO_SELECTED_REPS });
  }
});
export type AiRepSettingsInput = z.infer<typeof aiRepSettingsSchema>;

/** صفّ القاعدة (أو غيابه) ← عرضٌ مكتمل بالقيم الافتراضية. */
export function settingsView(row: Partial<AiRepSettingsView> | null | undefined): AiRepSettingsView {
  const d = DEFAULT_AI_REP_SETTINGS;
  if (!row) return { ...d, targetOutletTypes: [...d.targetOutletTypes] };
  const types = (row.targetOutletTypes ?? []).filter(t => (OUTLET_TYPE_CODES as readonly string[]).includes(t));
  return {
    targetOutletTypes: types.length ? types : [...d.targetOutletTypes],
    searchRadiusM: row.searchRadiusM ?? d.searchRadiusM,
    priorityProductIds: row.priorityProductIds ?? [],
    estimateWindowMonths: row.estimateWindowMonths ?? d.estimateWindowMonths,
    minPeers: Math.max(5, row.minPeers ?? d.minPeers),
    showMoney: row.showMoney ?? d.showMoney,
    repScope: row.repScope === 'SELECTED' ? 'SELECTED' : 'ALL',
    repIds: row.repIds ?? [],
    dailySearchesPerRep: row.dailySearchesPerRep ?? d.dailySearchesPerRep,
    playbook: row.playbook ?? null,
    advisorEnabled: row.advisorEnabled ?? d.advisorEnabled,
    dailyChatTurnsPerRep: row.dailyChatTurnsPerRep ?? d.dailyChatTurnsPerRep,
    learningMode: row.learningMode === 'REVIEW' || row.learningMode === 'OFF' ? row.learningMode : 'AUTO',
    holdoutPct: [0, 10, 20, 30].includes(row.holdoutPct as number) ? (row.holdoutPct as number) : d.holdoutPct,
  };
}

/** هل هذا المندوب ضمن من فُعّلت لهم الميزة؟ */
export function repInScope(s: Pick<AiRepSettingsView, 'repScope' | 'repIds'>, salesRepId: string): boolean {
  return s.repScope === 'ALL' || s.repIds.includes(salesRepId);
}
