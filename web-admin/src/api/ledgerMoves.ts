import api from './client';
import type { LedgerEnvelope, LocalDate, AccountType, ControlKind, JournalType, SequenceReset, GlJournal, GlTax } from './ledgerConfig';

/**
 * عميل القيود — `/api/ledger/*` (ملحق أ، M2): القيود وإجراءاتها الفردية والجماعية، بنود اليومية،
 * الملاحظات، المرفقات، المفضلات المحفوظة، وتصدير القوائم.
 *
 * مُوفَّق مع backend/src/routes/ledger/{moves,savedFilters,lists}.ts الفعلية:
 * - القوائم `{success, data: {rows, total, offset, limit}}` (و`totals` لبنود اليومية).
 * - المبالغ أرقام (fromMilli)، والتواريخ `YYYY-MM-DD`.
 * - الترحيل قبل `activatedAt` يرد 409 `LEDGER_NOT_SETUP` (§6.1)، وpost-drafts يعيده في rejected.
 * - المرفقات تحت `/moves/:id/attachments` (entityType=MOVE وحده في M2).
 */

type QValue = string | number | boolean | undefined | null | string[];
type Q = Record<string, QValue>;
const clean = (q?: Q) => (q
  ? Object.fromEntries(Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]))
  : undefined);

// ═══ الأنواع (§3.3) ═══

export type MoveState = 'DRAFT' | 'POSTED';
export type MoveOrigin = 'MANUAL' | 'AUTO';
export type ReviewState = 'NONE' | 'REVIEWED' | 'FLAGGED';
export type TaxRole = 'BASE' | 'TAX' | 'MARKER';

export const REVIEW_STATES: readonly ReviewState[] = ['NONE', 'REVIEWED', 'FLAGGED'];

/** صف قائمة القيود (serializeMoveRow). */
export interface GlMoveRow {
  id: string;
  number: string | null;
  state: MoveState;
  date: LocalDate;
  journal: { id: string; code: string; name: string };
  ref: string | null;
  narration: string | null;
  partnerName: string | null;
  total: number;
  currencyCode: string;
  currencyDecimals: number;
  origin: MoveOrigin;
  moveType: string;
  reviewState: ReviewState;
  needsAttention: boolean;
  attentionReason: string | null;
  lateArrival: boolean;
  originalDate: LocalDate | null;
  autoPostOn: LocalDate | null;
  sourceType: string | null;
  sourceId: string | null;
  customerId: string | null;
  vendorId: string | null;
  salesRepId: string | null;
  reversedMoveId: string | null;
  reversal: { id: string; number: string | null } | null;
  draftOfMoveId: string | null;
  createdAt: string;
  postedAt: string | null;
}

/** سطر في تفصيل القيد (GET /moves/:id). */
export interface GlMoveLine {
  id: string;
  seq: number;
  accountId: string;
  account: { code: string; name: string; type: AccountType; controlKind: ControlKind | null };
  label: string | null;
  debit: number;
  credit: number;
  customerId: string | null;
  vendorId: string | null;
  salesRepId: string | null;
  partnerName: string | null;
  analyticAccountId: string | null;
  productId: string | null;
  quantity: number | null;
  taxId: string | null;
  taxName: string | null;
  taxRole: TaxRole | null;
  taxBase: number | null;
  vatBox: string | null;
  vatAdjustment: boolean;
  dueDate: LocalDate | null;
  posted: boolean;
  /**
   * مولَّد آلياً من سطر وعاء (generatedLineFlags في الخادم) — للقراءة، ويُحذف من جسم إعادة الحفظ ليُعاد توليده.
   * غيره (ومنه سطر الضريبة اليدوي على حساب VAT) يُرسَل كما هو.
   */
  generated: boolean;
  /**
   * سطر وعاء بضريبة شاملة (priceInclude): المبلغ الشامل (الوعاء المخزَّن صافٍ). يُرسَل بدل debit/credit عند إعادة
   * الحفظ أو التكرار ما دام المبلغ والجانب والضريبة كما حُمِّلت، لأن الخادم يقرأ مبلغ هذا السطر شاملاً. null لغيره.
   */
  gross: number | null;
}

/** مخالفة I1–I5/I8 (ValidationIssue في services/gl/validate.ts). */
export interface MoveIssue {
  code: string;
  invariant: string;
  reason: string;
  /** فهرس السطر في lines (بترتيب الحفظ)، وnull لمخالفة على مستوى القيد */
  lineIndex: number | null;
  accountCode?: string;
  debitMilli?: string;
  creditMilli?: string;
}

export interface MoveLock { lockDate: LocalDate | null; fields: string[]; locked: boolean }

/** I7: null ⇒ قيد يدوي حرّ؛ وإلا المصدر ومسار إلغائه. */
export interface MoveOwnership {
  reasons: string[];
  sourceType: string | null;
  sourceId: string | null;
  ownerAction: string | null;
}

export interface GlMoveDetail {
  id: string;
  number: string | null;
  state: MoveState;
  moveType: string;
  origin: MoveOrigin;
  journal: { id: string; code: string; name: string; systemKey: string | null; type: JournalType; sequenceReset: SequenceReset; isActive: boolean };
  date: LocalDate;
  originalDate: LocalDate | null;
  lateArrival: boolean;
  ref: string | null;
  narration: string | null;
  currencyCode: string;
  currencyDecimals: number;
  total: number;
  customerId: string | null;
  vendorId: string | null;
  salesRepId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  sources?: { sourceKey?: string; sourceType?: string; sourceId?: string }[];
  reversedMove: { id: string; number: string | null } | null;
  reversalReason: string | null;
  reversal: { id: string; number: string | null } | null;
  draftOfMoveId: string | null;
  draftCopies: { id: string; state: MoveState; number: string | null }[];
  autoPostOn: LocalDate | null;
  reviewState: ReviewState;
  reviewedBy: string | null;
  reviewedAt: string | null;
  needsAttention: boolean;
  attentionReason: string | null;
  createdBy: string | null;
  createdByImpersonated: boolean;
  createdAt: string;
  updatedAt: string;
  postedAt: string | null;
  postedBy: string | null;
  postedByImpersonated: boolean;
  secured: boolean;
  ownership: MoveOwnership | null;
  ledgerActivated: boolean;
  noteCount: number;
  attachmentCount: number;
  /** للمسودة وحدها */
  issues: MoveIssue[];
  lock: MoveLock | null;
  lines: GlMoveLine[];
}

/** سطر في مدخل الإنشاء/التعديل — المبالغ نصوص أو أرقام تمر عبر toMilli في الخادم. */
export interface MoveLineInput {
  accountId: string;
  label?: string | null;
  debit?: number | string;
  credit?: number | string;
  customerId?: string | null;
  vendorId?: string | null;
  salesRepId?: string | null;
  partnerName?: string | null;
  analyticAccountId?: string | null;
  productId?: string | null;
  quantity?: number | null;
  /** ضريبة على السطر ⇒ الخادم يولّد سطر الضريبة ووعاءه */
  taxId?: string | null;
  vatBox?: string | null;
  dueDate?: LocalDate | null;
  /**
   * دور الضريبة: سطر على حساب VAT_OUT/VAT_IN بـtaxId يُعدّ سطر ضريبة يدوياً أياً كان الدور (MARKER يُبقيه علامة)،
   * وTAX/MARKER على غير حساب VAT يُسقطه الخادم — فلا يُرسَل إلا MARKER لسطر علامة يدوي لم يتغير حسابه.
   */
  taxRole?: TaxRole | null;
  /** true ⇒ الخادم يُهمل السطر ويعيد توليده (الواجهة تحذف المولَّد من الجسم بدلاً من إرساله) */
  generated?: boolean | null;
  /** وعاء سطر الضريبة اليدوي بوحدة العملة (نص عشري) رغم اسمه؛ يُهمل لغير سطور الضريبة اليدوية */
  taxBaseMilli?: number | string | null;
}

export interface MoveInput {
  journalId: string;
  date: LocalDate;
  ref?: string | null;
  narration?: string | null;
  autoPostOn?: LocalDate | null;
  lines: MoveLineInput[];
}

/** GET /moves/options: دفاتر وضرائب نموذج القيد بصلاحية القراءة (بلا حقول البنك). */
export type MoveOptionJournal = Pick<GlJournal,
  'id' | 'code' | 'name' | 'nameEn' | 'nameI18n' | 'type' | 'systemKey' | 'sequenceReset' | 'defaultAccountId'
  | 'useOutstandingAccounts' | 'isActive' | 'isSystem'>;
export type MoveOptionTax = Omit<GlTax, 'groupId'>;
export interface MoveFormOptions { journals: MoveOptionJournal[]; taxes: MoveOptionTax[] }

export interface MoveSaveResult {
  id: string;
  created: boolean;
  issues: MoveIssue[];
  generatedLineIndexes: number[];
  totals: { debit: number; credit: number };
  lock: MoveLock;
}

export interface MoveListParams extends Q {
  search?: string;
  /** DRAFT,POSTED (مفصولة بفواصل) */
  state?: string | string[];
  journalId?: string | string[];
  origin?: string | string[];
  moveType?: string | string[];
  reviewState?: string | string[];
  needsAttention?: boolean;
  lateArrival?: boolean;
  autoPost?: boolean;
  dateFrom?: LocalDate;
  dateTo?: LocalDate;
  customerId?: string;
  vendorId?: string;
  salesRepId?: string;
  accountId?: string | string[];
  ids?: string | string[];
  sort?: 'date' | 'number' | 'totalMilli' | 'createdAt';
  dir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

export interface MoveLineListParams extends Q {
  search?: string;
  state?: string | string[];
  accountId?: string | string[];
  journalId?: string | string[];
  dateFrom?: LocalDate;
  dateTo?: LocalDate;
  customerId?: string;
  vendorId?: string;
  salesRepId?: string;
  analyticAccountId?: string;
  productId?: string;
  moveId?: string;
  taxId?: string | string[];
  vatBox?: string | string[];
  taxRole?: string | string[];
  ids?: string | string[];
  dir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

/** صف بنود اليومية (serializeItemRow). */
export interface MoveLineRow {
  id: string;
  moveId: string;
  moveNumber: string | null;
  moveState: MoveState;
  moveRef: string | null;
  origin: MoveOrigin;
  journal: { id: string; code: string; name: string };
  seq: number;
  date: LocalDate;
  posted: boolean;
  account: { id: string; code: string; name: string; type: AccountType };
  label: string | null;
  partnerName: string | null;
  debit: number;
  credit: number;
  balance: number;
  currencyCode: string;
  customerId: string | null;
  vendorId: string | null;
  salesRepId: string | null;
  analyticAccountId: string | null;
  productId: string | null;
  quantity: number | null;
  taxId: string | null;
  taxName: string | null;
  taxRole: TaxRole | null;
  taxBase: number | null;
  vatBox: string | null;
  vatAdjustment: boolean;
  dueDate: LocalDate | null;
}

export interface ListPage<T> { rows: T[]; total: number; offset: number; limit: number }
export interface ItemTotals { debit: number; credit: number; balance: number }

export interface BulkRejection { id: string; code: string; details?: Record<string, unknown> }
export interface BulkPostResult { posted: { id: string; number: string; date: LocalDate }[]; rejected: BulkRejection[] }
export interface BulkDeleteResult { deleted: string[]; rejected: BulkRejection[] }
export interface BulkReviewResult { updated: string[]; rejected: { id: string; code: string }[] }

export interface PostedMoveResult {
  id: string; number: string; journalId: string; date: LocalDate; originalDate: LocalDate | null; lateArrival: boolean; total: number;
}

export interface ReverseInput { reason: string; date?: LocalDate | null }
export interface ReverseResult {
  alreadyReversed: boolean;
  original: { id: string; number: string | null };
  reversal: { id: string; number: string | null; date: LocalDate };
}
export interface ResetDraftResult {
  reversal: { id: string; number: string | null; date: LocalDate };
  draft: { id: string };
}

export interface GlMoveNote {
  id: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}

/** سجل التتبّع (من GlAuditLog، JE‑10). */
export interface MoveTrackingEntry {
  seq?: number | string;
  at: string;
  action: string;
  actorType?: string;
  actorId?: string | null;
  actorName: string | null;
  impersonated?: boolean;
  summary: string;
}

export type AttachmentEntityType = 'MOVE' | string;

export interface GlAttachment {
  id: string;
  entityType: AttachmentEntityType;
  entityId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: string | null;
  createdAt: string;
}

/** الرفع JSON بمحتوى base64 (الخادم يقرأ contentBase64 ويخزّن بايتات خاماً، §3.9). */
export interface AttachmentUpload {
  entityType: AttachmentEntityType;
  entityId: string;
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

export interface GlSavedFilter {
  id: string;
  userId: string;
  screen: string;
  name: string;
  domainJson: SavedFilterDomain;
  isDefault: boolean;
  isShared: boolean;
  createdAt: string;
  /** مفضلة المستخدم الحالي (الحذف له وحده) */
  mine?: boolean;
}

/** محتوى المفضلة: الفلاتر والتجميع والبحث بصيغة القائمة نفسها. */
export interface SavedFilterDomain {
  filters?: Record<string, string | number | boolean | null>;
  groupBy?: string[];
  search?: string;
  columns?: string[];
}

export type LedgerListKey = 'moves' | 'items' | 'accounts';

export interface ListExportInput {
  /** فلاتر القائمة الحالية (بأسماء معاملات GET نفسها)، أو ids[] للمحدد */
  filters?: Record<string, unknown>;
  ids?: string[];
  /** مُهمل: الخادم يعيد كل الصفوف دفعة واحدة (سقف 50,000) */
  cursor?: string | null;
}

export interface ListExportResult<T = Record<string, unknown>> {
  list: LedgerListKey;
  format: 'xlsx';
  rows: T[];
  lineCount: number;
  cap: number;
}

/** شكل متوافق للمستهلكين الأقدم (fetchListExport). */
export interface ListExportPage {
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  total?: number;
}

// ═══ النقاط ═══

const L = '/ledger';

/** معرّف المرفق ⇒ قيده (المحتوى تحت /moves/:id/attachments/:attachmentId) — يُملأ من القائمة والرفع. */
const attachmentOwner = new Map<string, string>();
const rememberAttachments = (rows: readonly GlAttachment[]) => { for (const a of rows) attachmentOwner.set(a.id, a.entityId); };

export const ledgerMovesApi = {
  moves: {
    list: (params?: MoveListParams) => api.get<LedgerEnvelope<ListPage<GlMoveRow>>>(`${L}/moves`, { params: clean(params) }),
    get: (id: string) => api.get<LedgerEnvelope<GlMoveDetail>>(`${L}/moves/${id}`),
    /** دفاتر وضرائب النموذج بـcanViewLedger (لا يحتاج canConfigureLedger) */
    options: () => api.get<LedgerEnvelope<MoveFormOptions>>(`${L}/moves/options`),
    create: (data: MoveInput) => api.post<LedgerEnvelope<MoveSaveResult>>(`${L}/moves`, data),
    update: (id: string, data: MoveInput) => api.put<LedgerEnvelope<MoveSaveResult>>(`${L}/moves/${id}`, data),
    /** حذف مسودة يدوية غير مملوكة لمستند (JE‑05b) */
    remove: (id: string) => api.delete<LedgerEnvelope<{ id: string }>>(`${L}/moves/${id}`),
    post: (id: string) => api.post<LedgerEnvelope<PostedMoveResult>>(`${L}/moves/${id}/post`),
    review: (id: string, reviewState: ReviewState) => api.post<LedgerEnvelope<{ id: string; reviewState: ReviewState }>>(`${L}/moves/${id}/review`, { reviewState }),
    /** اليدوية وحدها (I7)؛ السبب إلزامي (G5) */
    reverse: (id: string, data: ReverseInput) => api.post<LedgerEnvelope<ReverseResult>>(`${L}/moves/${id}/reverse`, data),
    resetDraft: (id: string, data: ReverseInput) => api.post<LedgerEnvelope<ResetDraftResult>>(`${L}/moves/${id}/reset-draft`, data),
    // الإجراءات الجماعية (§8.3) — بحد 100 معرّف
    postDrafts: (ids: string[]) => api.post<LedgerEnvelope<BulkPostResult>>(`${L}/moves/post-drafts`, { ids }),
    deleteDrafts: (ids: string[]) => api.post<LedgerEnvelope<BulkDeleteResult>>(`${L}/moves/delete-drafts`, { ids }),
    reviewMany: (ids: string[], reviewState: ReviewState) => api.post<LedgerEnvelope<BulkReviewResult>>(`${L}/moves/review`, { ids, reviewState }),
  },

  items: {
    list: (params?: MoveLineListParams) =>
      api.get<LedgerEnvelope<ListPage<MoveLineRow> & { totals: ItemTotals }>>(`${L}/items`, { params: clean(params) }),
  },

  notes: {
    /** الخادم يرد {notes, tracking}؛ يُعاد تشكيله {data: notes, tracking} كما يقرؤه LedgerForm. */
    list: async (moveId: string) => {
      const r = await api.get<LedgerEnvelope<{ notes: GlMoveNote[]; tracking: MoveTrackingEntry[] }>>(`${L}/moves/${moveId}/notes`);
      const body = r.data;
      return { ...r, data: { success: body.success, data: body.data?.notes ?? [], tracking: body.data?.tracking ?? [] } };
    },
    create: (moveId: string, body: string) => api.post<LedgerEnvelope<GlMoveNote>>(`${L}/moves/${moveId}/notes`, { body }),
  },

  attachments: {
    /** entityType=MOVE وحده في M2 */
    list: async (_entityType: AttachmentEntityType, entityId: string) => {
      const r = await api.get<LedgerEnvelope<GlAttachment[]>>(`${L}/moves/${entityId}/attachments`);
      rememberAttachments(r.data.data ?? []);
      return r;
    },
    upload: async (data: AttachmentUpload) => {
      const r = await api.post<LedgerEnvelope<GlAttachment>>(`${L}/moves/${data.entityId}/attachments`, {
        fileName: data.fileName, mimeType: data.mimeType, contentBase64: data.dataBase64,
      });
      if (r.data.data) rememberAttachments([r.data.data]);
      return r;
    },
    /** المحتوى blob للمعاينة؛ entityId اختياري إن سبق جلب القائمة أو الرفع */
    content: (id: string, entityId?: string) => {
      const moveId = entityId ?? attachmentOwner.get(id);
      if (!moveId) return Promise.reject(new Error('attachment owner unknown'));
      return api.get<Blob>(`${L}/moves/${moveId}/attachments/${id}`, { responseType: 'blob' });
    },
  },

  savedFilters: {
    list: (screen: string) => api.get<LedgerEnvelope<GlSavedFilter[]>>(`${L}/saved-filters`, { params: { screen } }),
    create: (data: { screen: string; name: string; domainJson: SavedFilterDomain; isDefault?: boolean; isShared?: boolean }) =>
      api.post<LedgerEnvelope<GlSavedFilter>>(`${L}/saved-filters`, data),
    remove: (id: string) => api.delete<LedgerEnvelope<{ id: string }>>(`${L}/saved-filters/${id}`),
  },

  lists: {
    /** كل الصفوف بشكل صفوف القائمة (سقف 50,000 وإلا 422 LEDGER_EXPORT_TOO_LARGE؛ 429 RATE_LIMITED) */
    export: <T = Record<string, unknown>>(list: LedgerListKey, data: ListExportInput) =>
      api.post<LedgerEnvelope<ListExportResult<T>>>(`${L}/lists/${list}/export`, {
        format: 'xlsx', ...(data.filters ? { filters: clean(data.filters as Q) ?? {} } : {}), ...(data.ids ? { ids: data.ids } : {}),
      }),
  },
};

/** يجلب صفوف التصدير (المتصفح يبني XLSX بـutils/excel). */
export async function fetchListExport(list: LedgerListKey, input: Omit<ListExportInput, 'cursor'>): Promise<ListExportPage> {
  const res = await ledgerMovesApi.lists.export(list, input);
  const rows = (res.data.data?.rows ?? []) as Record<string, unknown>[];
  const columns = rows[0] ? Object.keys(rows[0]).map(k => ({ key: k, label: k })) : [];
  return { columns, rows, nextCursor: null, total: rows.length };
}

/** ملف ⇒ base64 (بلا بادئة data:) للرفع. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const ledgerMoveKeys = {
  moves: (params?: unknown) => ['ledger', 'moves', params ?? {}] as const,
  move: (id: string) => ['ledger', 'move', id] as const,
  options: ['ledger', 'move-options'] as const,
  items: (params?: unknown) => ['ledger', 'items', params ?? {}] as const,
  notes: (moveId: string) => ['ledger', 'move-notes', moveId] as const,
  attachments: (entityType: string, entityId: string) => ['ledger', 'attachments', entityType, entityId] as const,
  savedFilters: (screen: string) => ['ledger', 'saved-filters', screen] as const,
};
