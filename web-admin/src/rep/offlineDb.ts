/**
 * طبقة تخزين محلي لتطبيق المندوب (IndexedDB) — أساس العمل دون اتصال (M2).
 *
 * مخزنان:
 *  - ref:  بيانات مرجعية (عملاء/أصناف/إعدادات الشركة) بمفتاح اسمي، تُحدَّث عند الاتصال
 *          وتُقرأ أوف‑لاين. أساس إنشاء الفواتير/السندات بلا شبكة.
 *  - outbox: (M4+) صفّ المستندات المُنشأة أوف‑لاين بانتظار الرفع.
 *
 * بلا تبعيات خارجية (لا idb) — غلاف Promise رفيع فوق IndexedDB الأصلي.
 * IndexedDB قد يُطرد (iOS Safari بعد خمول/ضغط)؛ لذا نطلب التثبيت الدائم (persist)،
 * والمصدر النهائي للحقيقة يبقى الخادم عند الاتصال.
 */

const DB_NAME = 'fieldsa-rep';
const DB_VERSION = 1;
const STORE_REF = 'ref';
const STORE_OUTBOX = 'outbox';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB غير متاح')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_REF)) db.createObjectStore(STORE_REF, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const os = db.createObjectStore(STORE_OUTBOX, { keyPath: 'clientRef' });
        os.createIndex('byStatus', 'status', { unique: false });
        os.createIndex('byCreated', 'clientCreatedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  }));
}

// ------------------------------- البيانات المرجعية ------------------------------- //

export interface RefEntry<T = unknown> { key: string; data: T; updatedAt: number }

// يخزّن (يستبدل) قيمة مرجعية بمفتاحها مع ختم زمني
export async function cacheSet<T>(key: string, data: T): Promise<void> {
  await tx(STORE_REF, 'readwrite', (s) => s.put({ key, data, updatedAt: Date.now() } as RefEntry<T>));
}

// يقرأ قيمة مرجعية (أو null إن غابت)
export async function cacheGet<T>(key: string): Promise<{ data: T; updatedAt: number } | null> {
  try {
    const row = await tx<RefEntry<T> | undefined>(STORE_REF, 'readonly', (s) => s.get(key));
    return row ? { data: row.data, updatedAt: row.updatedAt } : null;
  } catch {
    return null;
  }
}

/**
 * نمط مشترك: جلب من الشبكة ثم التخزين، ومع الانقطاع القراءة من الكاش.
 * يُرجع {data, offline} — offline=true حين تعذّرت الشبكة وجاءت البيانات من الكاش.
 */
export async function fetchThenCache<T>(
  key: string,
  networkFetch: () => Promise<T>,
): Promise<{ data: T | null; offline: boolean; updatedAt: number | null }> {
  try {
    const fresh = await networkFetch();
    await cacheSet(key, fresh);
    return { data: fresh, offline: false, updatedAt: Date.now() };
  } catch {
    const cached = await cacheGet<T>(key);
    if (cached) return { data: cached.data, offline: true, updatedAt: cached.updatedAt };
    return { data: null, offline: true, updatedAt: null };
  }
}

// ------------------------------- الصفّ الصادر (يُستخدم في M4+) ------------------------------- //

export interface OutboxDoc {
  clientRef: string;              // UUID = مفتاح idempotency
  kind: 'customer' | 'invoice' | 'receipt' | 'visit';
  payload: unknown;               // حمولة POST كما تُرسل للخادم
  status: 'queued' | 'sent' | 'rejected';
  clientCreatedAt: string;        // ISO
  localNumber?: string;           // رقم مؤقّت للعرض/الطباعة
  error?: string;                 // سبب الرفض إن وُجد
  serverNumber?: string;          // الرقم النهائي بعد الرفع
  serverId?: string;
}

export async function outboxAdd(doc: OutboxDoc): Promise<void> {
  await tx(STORE_OUTBOX, 'readwrite', (s) => s.put(doc));
}

export async function outboxAll(): Promise<OutboxDoc[]> {
  try { return (await tx<OutboxDoc[]>(STORE_OUTBOX, 'readonly', (s) => s.getAll())) || []; }
  catch { return []; }
}

export async function outboxUpdate(doc: OutboxDoc): Promise<void> {
  await tx(STORE_OUTBOX, 'readwrite', (s) => s.put(doc));
}

export async function outboxDelete(clientRef: string): Promise<void> {
  await tx(STORE_OUTBOX, 'readwrite', (s) => s.delete(clientRef));
}

export async function outboxPending(): Promise<number> {
  const all = await outboxAll();
  return all.filter((d) => d.status === 'queued').length;
}

// ------------------------------- أدوات ------------------------------- //

// UUID v4 (crypto.randomUUID مدعوم في المتصفّحات الحديثة؛ احتياط يدوي)
export function newClientRef(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// يطلب تخزيناً دائماً (يقلّل طرد iOS/Safari للبيانات) — أفضل جهد لا ضمان
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* غير مدعوم */ }
  return false;
}
