/**
 * «الفرق» داخل الشركة (طلب المالك ١٧ أكتوبر ٢٠٢٦) — مطفأة افتراضياً لكل الشركات، ويفعّلها مدير الشركة من «إعدادات
 * الشركة» (CompanySettings.teamsEnabled).
 *
 * نشاطٌ أو فريق مناديب بمشرفين وأصناف خاصة. المندوب في فريقٍ أو أكثر، ويختار في تطبيقه الفريق الذي يعمل له الآن، فتُوسم
 * به فواتيره ومرتجعاته وسنداته وزياراته (`teamId`) — والتقارير تُفصل وتُجمَّع بالوسم لا بعضوية المندوب الحالية، فمجموع
 * أقسام الفرق يساوي إجمالي الشركة بلا ازدواج، ويبقى تاريخ الفريق ثابتاً إن انتقل المندوب.
 *
 * قرارات المالك: الفريق يختاره المندوب؛ أصناف الفريق تقيّد البيع (صنفٌ بلا فرق عامٌّ للجميع)؛ العملاء مشتركون (المشرف
 * يراهم كلهم)؛ والمستندات القديمة تبقى «بلا فريق».
 *
 * دوالٌ صافية بلا قاعدة بيانات — تُغذّى من قراءات المسارات القائمة (`include` على قراءة المندوب والأصناف) فلا يضيف
 * الوسم استعلاماً إلى مسار الإصدار.
 */

/** عضويات المندوب كما تُقرأ مع صفّه: `teamMemberships: { select: TEAM_MEMBERSHIP_SELECT }` */
export const TEAM_MEMBERSHIP_SELECT = { teamId: true, team: { select: { isActive: true } } } as const;

export interface RepTeams {
  tenant?: { settings?: { teamsEnabled?: boolean | null } | null } | null;
  teamMemberships?: { teamId: string; team?: { isActive?: boolean | null } | null }[] | null;
}

/** فرق المندوب الفعّالة — والميزة المطفأة للشركة لا فرق لها (لا وسم ولا تقييد) */
export function activeTeamIdsOf(rep: RepTeams | null | undefined): string[] {
  if (!rep || rep.tenant?.settings?.teamsEnabled !== true) return [];
  return (rep.teamMemberships ?? []).filter((m) => m.team?.isActive !== false).map((m) => m.teamId);
}

/**
 * فريق المستند الجديد: ما اختاره المندوب إن كان من فرقه الفعّالة، وإلا فريقه الوحيد، وإلا null («بلا فريق»).
 *
 * لا رفض هنا أبداً: مستندٌ أوف-لاين يُعاد رفعه بفريقٍ تغيّرت عضويته بعد إنشائه يصير «مرفوضاً» نهائياً في صندوق الإرسال
 * لو رُدّ بـ4xx — فالاختيار غير الصالح يرجع إلى الافتراضي بصمت.
 */
export function resolveDocTeam(rep: RepTeams | null | undefined, requested?: string | null): string | null {
  const ids = activeTeamIdsOf(rep);
  if (requested && ids.includes(requested)) return requested;
  return ids.length === 1 ? ids[0] : null;
}

/** فرق الصنف كما تُقرأ معه: `teams: { select: { teamId: true } }` — بلا صفوف = صنفٌ عامّ لكل الفرق */
export interface ProductTeams { id?: string; name?: string; teams?: { teamId: string }[] | null }

export const isGeneralProduct = (p: ProductTeams) => !(p.teams && p.teams.length);

/** هل يبيع من يعمل لهذا الفريق هذا الصنف؟ مستندٌ بلا فريق لا يُقيَّد */
export function productAllowedInTeam(p: ProductTeams, teamId: string | null | undefined): boolean {
  if (!teamId || isGeneralProduct(p)) return true;
  return p.teams!.some((t) => t.teamId === teamId);
}

/**
 * الفرق التي يُفحص بها كتالوج بيع المندوب الحيّ — null = بلا تقييد (الميزة مطفأة).
 *
 * فريق المستند إن حُسم ⇒ أصنافه + العامة. بلا فريقٍ محسوم (مندوبٌ في فريقين لم يختر، أو أرسل فريقاً ليس له) ⇒ أصناف
 * كل فرقه + العامة — فلا يتجاوز القيدَ بحذف الفريق من طلبه. ومندوبٌ بلا فرق في شركةٍ فعّلتها ⇒ العامة وحدها («الصنف
 * المسند لا يبيعه إلا من يعمل لأحد فرقه»).
 */
export function catalogTeamsFor(rep: RepTeams | null | undefined, docTeamId: string | null): string[] | null {
  if (!rep || rep.tenant?.settings?.teamsEnabled !== true) return null;
  return docTeamId ? [docTeamId] : activeTeamIdsOf(rep);
}

/** أول صنفٍ لا تبيعه هذه الفرق — رسالة الرفض عربية باسمه، أو null. allowed=null بلا تقييد، و[] للعامة وحدها */
export function teamCatalogProblem(products: ProductTeams[], allowed: string[] | null): string | null {
  if (!allowed) return null;
  const bad = products.find((p) => !isGeneralProduct(p) && !p.teams!.some((t) => allowed.includes(t.teamId)));
  if (!bad) return null;
  return allowed.length
    ? `الصنف «${bad.name ?? ''}» ليس من أصناف فريقك الحالي — بدّل الفريق أو احذف الصنف`
    : `الصنف «${bad.name ?? ''}» خاص بفريقٍ لست من أعضائه — احذفه من الفاتورة`;
}

/** اسم فريقٍ صالح: يُشذَّب ويُطوى فراغه، ولا يتجاوز ٦٠ حرفاً */
export const teamName = (s: string) => s.trim().replace(/\s+/g, ' ').slice(0, 60);

/**
 * فلتر التقارير بالفريق من `?teamId=` — نصاً وحده (كائن qs مثل teamId[not]=x يُهمل فلا يصير شرط Prisma):
 * غائب/فارغ ⇒ undefined (كل الفرق)، `none` ⇒ null («بلا فريق»)، وإلا معرّف الفريق.
 */
export function reportTeamOf(raw: unknown): string | null | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  return raw === 'none' ? null : raw;
}

/** المستندات الموسومة (فاتورة، سند، زيارة): بوسمها — فمجموع أقسام الفرق إجمالي الشركة بلا ازدواج */
export const teamDocWhere = (team: string | null | undefined) => (team === undefined ? {} : { teamId: team });

/** التقارير القائمة على المندوب (ساعات، حضور، مسافة، مديونيات): بعضويته الحالية — ومندوبٌ في فريقين يظهر تحت كليهما */
export const teamRepWhere = (team: string | null | undefined) =>
  team === undefined ? {} : team === null ? { teamMemberships: { none: {} } } : { teamMemberships: { some: { teamId: team } } };

/** اسم الفريق مع الصفّ (للعرض والتصدير ورقةً لكل فريق) */
export const TEAM_NAME_SELECT = { select: { id: true, name: true } } as const;
