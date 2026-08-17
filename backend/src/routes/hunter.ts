/**
 * منصّة صيد العملاء المحتملين (Hunter) — **معزولة تماماً داخل فيلد سيلز**.
 *
 * ثلاث طبقات عزل مقصودة:
 *  1) **مصادقة منفصلة**: التوكن يُوقَّع بسرّ مشتقّ (`JWT_SECRET::hunter`)، فتوكن
 *     لوحة فيلد سيلز لا يفكّ هنا، وتوكن الصيد لا يفكّ هناك — عزل تشفيريّ لا
 *     مجرّد فحص دور. لا حاجة لتعديل أي كود قائم.
 *  2) **جداول منفصلة** (hunter_*) بلا أي علاقة بجداول المنصّة.
 *  3) **عزل بين الحسابات**: كل استعلام عملاء مُقيَّد بـuserId من التوكن — لا
 *     يُقرأ معرّف المستخدم من الجسم أو المسار أبداً (درس ثغرة IDOR في المراجعة).
 */
import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../config/database';
import { authLimiter, signupLimiter } from '../middleware/rateLimits';
import { providersReady, runSearch, sourceLabel, RawLead, SourceId } from '../services/hunter/sources';
import { dedupKeysOf } from '../services/hunter/normalize';
import { qualifyBatch, qualifyReady, QualifyItem } from '../services/hunter/qualify';
import { enrichFromWebsite } from '../services/hunter/enrich';

const router = Router();

// ----------------------------- المصادقة ----------------------------- //

function hunterSecret(): string {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET غير مضبوط');
  // سرّ مشتقّ: يمنع تبادل التوكنات بين المنصّة ومنصّة الصيد
  return process.env.HUNTER_JWT_SECRET || `${base}::hunter`;
}

interface HunterPayload {
  hid: string;
  kind: 'hunter';
  isOwner: boolean;
}

interface HunterRequest extends Request {
  hunter?: HunterPayload;
}

/** scrypt: `salt:hash` — بلا تبعيات خارجية. */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

async function hunterAuth(req: HunterRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) { res.status(401).json({ success: false, message: 'غير مصرّح' }); return; }
  let payload: HunterPayload;
  try {
    payload = jwt.verify(token, hunterSecret()) as HunterPayload;
  } catch {
    res.status(401).json({ success: false, message: 'جلسة منتهية — سجّل الدخول مجدداً' }); return;
  }
  if (payload?.kind !== 'hunter' || !payload.hid) {
    res.status(401).json({ success: false, message: 'توكن غير صالح' }); return;
  }
  // الحساب قد يُعطَّل بعد إصدار التوكن — نفحصه في كل طلب (الحسابات قليلة)
  const user = await prisma.hunterUser.findUnique({
    where: { id: payload.hid },
    select: { id: true, isActive: true, isOwner: true },
  });
  if (!user?.isActive) {
    res.status(401).json({ success: false, message: 'الحساب معطّل' }); return;
  }
  req.hunter = { hid: user.id, kind: 'hunter', isOwner: user.isOwner };
  next();
}

function requireOwner(req: HunterRequest, res: Response, next: NextFunction): void {
  if (!req.hunter?.isOwner) { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
  next();
}

/** معرّف الحساب من التوكن — المصدر الوحيد المسموح لتحديد الملكية. */
function uid(req: HunterRequest): string {
  if (!req.hunter?.hid) throw new Error('لا حساب في الجلسة');
  return req.hunter.hid;
}

// -------------------- تهيئة حساب المالك من البيئة -------------------- //
// يُنشأ مرّة واحدة فقط وحين تكون الجداول فارغة تماماً.
let bootstrapped = false;
async function ensureOwner(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  const email = (process.env.HUNTER_OWNER_EMAIL || '').trim().toLowerCase();
  const password = process.env.HUNTER_OWNER_PASSWORD || '';
  if (!email || password.length < 8) return;
  try {
    const count = await prisma.hunterUser.count();
    if (count > 0) return;
    await prisma.hunterUser.create({
      data: {
        email, passwordHash: hashPassword(password), name: 'المالك',
        isOwner: true, monthlyQuota: 100000,
      },
    });
  } catch { /* لا نُفشل الإقلاع بسبب التهيئة */ }
}

// ------------------------------ الحصّة ------------------------------ //
interface QuotaState { quota: number; used: number; remaining: number }

async function readQuota(userId: string): Promise<QuotaState> {
  const u = await prisma.hunterUser.findUnique({
    where: { id: userId },
    select: { monthlyQuota: true, usedThisMonth: true, quotaResetAt: true },
  });
  if (!u) return { quota: 0, used: 0, remaining: 0 };
  // إعادة ضبط شهرية كسولة
  const now = new Date();
  const reset = new Date(u.quotaResetAt);
  if (now.getUTCFullYear() > reset.getUTCFullYear() || now.getUTCMonth() !== reset.getUTCMonth()) {
    await prisma.hunterUser.update({
      where: { id: userId },
      data: { usedThisMonth: 0, quotaResetAt: now },
    });
    return { quota: u.monthlyQuota, used: 0, remaining: u.monthlyQuota };
  }
  return { quota: u.monthlyQuota, used: u.usedThisMonth, remaining: Math.max(0, u.monthlyQuota - u.usedThisMonth) };
}

// ------------------------------ المسارات ------------------------------ //

router.post('/login', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureOwner();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) {
      res.status(400).json({ success: false, message: 'البريد وكلمة المرور مطلوبان' }); return;
    }
    const user = await prisma.hunterUser.findUnique({ where: { email } });
    // رسالة واحدة للحالتين حتى لا نكشف وجود الحساب
    if (!user || !user.isActive || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' }); return;
    }
    const token = jwt.sign(
      { hid: user.id, kind: 'hunter', isOwner: user.isOwner } as HunterPayload,
      hunterSecret(),
      { expiresIn: '12h' },
    );
    await prisma.hunterUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const q = await readQuota(user.id);
    res.json({
      success: true, token,
      user: { id: user.id, name: user.name, email: user.email, isOwner: user.isOwner, ...q },
    });
  } catch (err) { next(err); }
});

// هل يُسمح بالتسجيل الذاتي؟ (المالك يعطّله بضبط HUNTER_ALLOW_SIGNUP=false)
function signupAllowed(): boolean {
  return (process.env.HUNTER_ALLOW_SIGNUP || 'true').toLowerCase() !== 'false';
}
// حصّة الخطة المجانية للتسجيل الذاتي — محدودة لتفادي استنزاف مفاتيح المصادر المشتركة
function freeQuota(): number {
  const n = Number(process.env.HUNTER_FREE_QUOTA);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 100;
}

// تسجيل ذاتيّ (خطة مجانية) — محدود بمعدّل وبحصّة صغيرة.
router.post('/register', signupLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!signupAllowed()) {
      res.status(403).json({ success: false, message: 'التسجيل الذاتي متوقّف حالياً — تواصل مع المالك للحصول على حساب' });
      return;
    }
    await ensureOwner();
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (name.length < 2) { res.status(400).json({ success: false, message: 'أدخل اسمك (حرفان على الأقل)' }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { res.status(400).json({ success: false, message: 'بريد إلكتروني غير صالح' }); return; }
    if (password.length < 8) { res.status(400).json({ success: false, message: 'كلمة المرور ٨ أحرف على الأقل' }); return; }

    const exists = await prisma.hunterUser.findUnique({ where: { email }, select: { id: true } });
    if (exists) { res.status(409).json({ success: false, message: 'هذا البريد مسجّل مسبقاً — سجّل الدخول بدلاً من ذلك' }); return; }

    const user = await prisma.hunterUser.create({
      data: { email, name, passwordHash: hashPassword(password), monthlyQuota: freeQuota(), lastLoginAt: new Date() },
    });
    const token = jwt.sign(
      { hid: user.id, kind: 'hunter', isOwner: false } as HunterPayload,
      hunterSecret(),
      { expiresIn: '12h' },
    );
    const q = await readQuota(user.id);
    res.status(201).json({
      success: true, token,
      user: { id: user.id, name: user.name, email: user.email, isOwner: false, ...q },
    });
  } catch (err) { next(err); }
});

router.get('/me', hunterAuth, async (req: HunterRequest, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.hunterUser.findUnique({
      where: { id: uid(req) },
      select: { id: true, name: true, email: true, isOwner: true },
    });
    const q = await readQuota(uid(req));
    res.json({ success: true, user: { ...user, ...q } });
  } catch (err) { next(err); }
});

router.get('/config', hunterAuth, (_req: HunterRequest, res: Response) => {
  const ready = providersReady();
  const labels: Record<string, string> = {};
  (Object.keys(ready) as SourceId[]).forEach((k) => { labels[k] = sourceLabel(k); });
  res.json({ success: true, sources: ready, labels, qualify: qualifyReady(), signup: signupAllowed() });
});

/** عملاء الحساب وحده — لا معرّف مستخدم يُقرأ من الطلب. */
router.get('/leads', hunterAuth, async (req: HunterRequest, res: Response, next: NextFunction) => {
  try {
    const leads = await prisma.hunterLead.findMany({
      where: { userId: uid(req) },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      take: 2000,
    });
    res.json({ success: true, leads });
  } catch (err) { next(err); }
});

router.patch('/leads/:id', hunterAuth, async (req: HunterRequest, res: Response, next: NextFunction) => {
  try {
    const data: Record<string, unknown> = {};
    if (typeof req.body?.status === 'string') data.status = req.body.status;
    if (typeof req.body?.notes === 'string') data.notes = req.body.notes;
    // updateMany بقيد userId: يمنع تعديل عميل حساب آخر حتى بمعرّف صحيح
    const r = await prisma.hunterLead.updateMany({
      where: { id: String(req.params.id), userId: uid(req) }, data,
    });
    if (!r.count) { res.status(404).json({ success: false, message: 'غير موجود' }); return; }
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/leads/:id', hunterAuth, async (req: HunterRequest, res: Response, next: NextFunction) => {
  try {
    const r = await prisma.hunterLead.deleteMany({
      where: { id: String(req.params.id), userId: uid(req) },
    });
    if (!r.count) { res.status(404).json({ success: false, message: 'غير موجود' }); return; }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ------------------------------ الصيد ------------------------------ //

interface HuntBody {
  description?: string;
  keywords?: string[];
  countries?: string[];
  cities?: string[];
  sources?: string[];
  perQuery?: number;
  maxLeads?: number;
  qualify?: boolean;
  enrich?: boolean;
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
};

router.post('/hunt', hunterAuth, async (req: HunterRequest, res: Response, next: NextFunction) => {
  try {
    const userId = uid(req);
    const body = (req.body || {}) as HuntBody;

    const keywords = (Array.isArray(body.keywords) ? body.keywords : [])
      .map((k) => String(k).trim()).filter(Boolean).slice(0, 12);
    const countries = (Array.isArray(body.countries) ? body.countries : [])
      .map((k) => String(k).trim()).filter(Boolean).slice(0, 10);
    const cities = (Array.isArray(body.cities) ? body.cities : [])
      .map((k) => String(k).trim()).filter(Boolean).slice(0, 20);
    if (!keywords.length) {
      res.status(400).json({ success: false, message: 'أضِف كلمة بحث واحدة على الأقل' }); return;
    }
    if (!countries.length && !cities.length) {
      res.status(400).json({ success: false, message: 'حدّد دولة أو مدينة' }); return;
    }

    const ready = providersReady();
    const sources = (Array.isArray(body.sources) ? body.sources : [])
      .filter((s): s is SourceId => (s as SourceId) in ready && ready[s as SourceId]);
    if (!sources.length) {
      res.status(400).json({ success: false, message: 'لا مصدر بحث جاهز — راجع الإعدادات' }); return;
    }

    const perQuery = clamp(body.perQuery, 1, 50, 20);
    const quota = await readQuota(userId);
    if (quota.remaining <= 0) {
      res.status(429).json({ success: false, message: 'انتهت حصّتك الشهرية' }); return;
    }
    const maxLeads = Math.min(clamp(body.maxLeads, 1, 1000, 200), quota.remaining);

    // مناطق البحث: المدن إن وُجدت (أدقّ)، وإلا مستوى الدولة
    const areas = cities.length
      ? cities.map((city) => ({ city, country: countries[0] || null }))
      : countries.map((country) => ({ country, city: null as string | null }));

    // مفاتيح ما لدى الحساب مسبقاً — الفحص في الذاكرة أسرع من استعلام لكل نتيجة
    const existing = await prisma.hunterLead.findMany({
      where: { userId },
      select: { sourceId: true, domainKey: true, phoneKey: true, nameCityKey: true },
    });
    const seen = new Set<string>();
    for (const e of existing) {
      if (e.sourceId) seen.add(`s:${e.sourceId}`);
      if (e.domainKey) seen.add(`d:${e.domainKey}`);
      if (e.phoneKey) seen.add(`p:${e.phoneKey}`);
      if (e.nameCityKey) seen.add(`n:${e.nameCityKey}`);
    }

    const errors: string[] = [];
    const fresh: RawLead[] = [];
    let found = 0;
    let merged = 0;

    outer:
    for (const src of sources) {
      for (const area of areas) {
        for (const kw of keywords) {
          if (fresh.length >= maxLeads) break outer;
          try {
            const raw = await runSearch(src, kw, { country: area.country, city: area.city, limit: perQuery });
            found += raw.length;
            for (const r of raw) {
              if (fresh.length >= maxLeads) break;
              const keys = dedupKeysOf(r);
              const candidate = [
                r.sourceId ? `s:${r.sourceId}` : '',
                keys.domainKey ? `d:${keys.domainKey}` : '',
                keys.phoneKey ? `p:${keys.phoneKey}` : '',
                keys.nameCityKey ? `n:${keys.nameCityKey}` : '',
              ].filter(Boolean);
              if (candidate.some((k) => seen.has(k))) { merged++; continue; }
              candidate.forEach((k) => seen.add(k));
              fresh.push(r);
            }
          } catch (e) {
            errors.push(`${sourceLabel(src)} · «${kw}»: ${e instanceof Error ? e.message : 'خطأ'}`);
          }
        }
      }
    }

    // الإدراج — كل صفّ مربوط بالحساب من التوكن
    const created = [];
    for (const r of fresh) {
      const keys = dedupKeysOf(r);
      try {
        const lead = await prisma.hunterLead.create({
          data: {
            userId,
            name: r.name, phone: r.phone ?? null, email: r.email ?? null,
            website: r.website ?? null, address: r.address ?? null,
            city: r.city ?? null, country: r.country ?? null, countryCode: r.countryCode ?? null,
            category: r.category ?? null, lat: r.lat ?? null, lng: r.lng ?? null,
            mapsUrl: r.mapsUrl ?? null, source: r.source, sourcesCsv: r.source,
            sourceId: r.sourceId ?? null, ...keys,
          },
        });
        created.push(lead);
      } catch { /* تصادم نادر — نتخطّاه */ }
    }

    await prisma.hunterUser.update({
      where: { id: userId },
      data: { usedThisMonth: { increment: created.length } },
    });

    await prisma.hunterSearch.create({
      data: {
        userId, providers: sources.join('+'), keywords: keywords.join('، '),
        country: countries[0] || null, city: cities[0] || null,
        found, added: created.length, merged,
        errors: errors.length ? errors.join(' | ') : null,
      },
    });

    // التأهيل الذكي عبر ملي — بمفتاح ثابت لكل عميل (لا فهرس موضعي)
    let qualified = 0;
    let qualifyNote: string | null = null;
    if (body.qualify !== false && created.length && String(body.description || '').trim()) {
      const desc = String(body.description).trim().slice(0, 600);
      const BATCH = 10;
      try {
        for (let i = 0; i < created.length; i += BATCH) {
          const chunk = created.slice(i, i + BATCH);
          const items: QualifyItem[] = chunk.map((l) => ({
            key: l.id.slice(0, 8), name: l.name,
            category: l.category, city: l.city, country: l.country, website: l.website,
          }));
          const { scores } = await qualifyBatch(desc, items);
          for (const l of chunk) {
            const s = scores.get(l.id.slice(0, 8));
            if (!s) continue; // بلا درجة ⇒ يبقى مرشّحاً لإعادة التأهيل
            await prisma.hunterLead.updateMany({
              where: { id: l.id, userId },
              data: { score: s.score, scoreNote: s.note },
            });
            qualified++;
          }
        }
      } catch (e) {
        qualifyNote = e instanceof Error ? e.message : 'تعذّر التأهيل';
      }
    }

    // الإثراء (بريد/هاتف من موقع الشركة) — محميّ ضد SSRF داخل الخدمة
    let enrichedEmail = 0;
    if (body.enrich !== false) {
      const targets = created.filter((l) => l.website && (!l.email || !l.phone)).slice(0, 25);
      for (const l of targets) {
        try {
          const got = await enrichFromWebsite(l.website as string, { respectRobots: true });
          const data: Record<string, string> = {};
          if (got.email && !l.email) { data.email = got.email; enrichedEmail++; }
          if (got.phone && !l.phone) data.phone = got.phone;
          if (Object.keys(data).length) {
            await prisma.hunterLead.updateMany({ where: { id: l.id, userId }, data });
          }
        } catch { /* عميل واحد لا يوقف الدفعة */ }
      }
    }

    const leads = await prisma.hunterLead.findMany({
      where: { userId }, orderBy: [{ score: 'desc' }, { createdAt: 'desc' }], take: 2000,
    });
    const q = await readQuota(userId);
    res.json({
      success: true,
      stats: { found, added: created.length, merged, qualified, enrichedEmail, errors, qualifyNote },
      quota: q,
      leads,
    });
  } catch (err) { next(err); }
});

// --------------------- إدارة الحسابات (المالك فقط) --------------------- //

router.get('/admin/users', hunterAuth, requireOwner, async (_req: HunterRequest, res: Response, next: NextFunction) => {
  try {
    const users = await prisma.hunterUser.findMany({
      select: {
        id: true, email: true, name: true, isActive: true, isOwner: true,
        monthlyQuota: true, usedThisMonth: true, lastLoginAt: true, createdAt: true,
        _count: { select: { leads: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, users });
  } catch (err) { next(err); }
});

router.post('/admin/users', hunterAuth, requireOwner, async (req: HunterRequest, res: Response, next: NextFunction) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim() || null;
    const quota = clamp(req.body?.monthlyQuota, 10, 100000, 500);
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
      res.status(400).json({ success: false, message: 'بريد غير صالح' }); return;
    }
    const exists = await prisma.hunterUser.findUnique({ where: { email }, select: { id: true } });
    if (exists) { res.status(409).json({ success: false, message: 'البريد مستخدم مسبقاً' }); return; }

    // كلمة مرور مولّدة — تُعرض مرّة واحدة للمالك ليسلّمها
    const password = crypto.randomBytes(9).toString('base64url');
    const user = await prisma.hunterUser.create({
      data: { email, name, passwordHash: hashPassword(password), monthlyQuota: quota },
      select: { id: true, email: true, name: true, monthlyQuota: true },
    });
    res.status(201).json({ success: true, user, password });
  } catch (err) { next(err); }
});

router.patch('/admin/users/:id', hunterAuth, requireOwner, async (req: HunterRequest, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const data: Record<string, unknown> = {};
    if (typeof req.body?.isActive === 'boolean') data.isActive = req.body.isActive;
    if (req.body?.monthlyQuota !== undefined) data.monthlyQuota = clamp(req.body.monthlyQuota, 10, 100000, 500);
    if (typeof req.body?.name === 'string') data.name = req.body.name.trim() || null;

    let newPassword: string | undefined;
    if (req.body?.resetPassword === true) {
      newPassword = crypto.randomBytes(9).toString('base64url');
      data.passwordHash = hashPassword(newPassword);
    }
    if (!Object.keys(data).length) { res.status(400).json({ success: false, message: 'لا تغيير' }); return; }

    // المالك لا يعطّل نفسه
    if (id === uid(req) && data.isActive === false) {
      res.status(400).json({ success: false, message: 'لا يمكنك تعطيل حسابك' }); return;
    }
    await prisma.hunterUser.update({ where: { id }, data });
    res.json({ success: true, password: newPassword });
  } catch (err) { next(err); }
});

export default router;
