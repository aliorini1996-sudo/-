import { Router, Request, Response, NextFunction } from 'express';
import http from 'http';
import crypto from 'crypto';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import { resolveAttribution, contentTypeOf, makeWaCode } from '../services/attribution';
import { computeLiveCounts, LIVE_WINDOW_MIN } from '../services/presence';

// تحليلات زيارات الموقع التعريفي — تسجيل عام + إحصاءات لمالك المنصّة
const router = Router();

const BOT_RE = /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|preview|monitor|headless|lighthouse|pingdom|curl|wget|python-requests|axios\//i;

function clientIp(req: Request): string {
  const xff = (req.headers['x-forwarded-for'] as string) || '';
  const ip = (xff.split(',')[0].trim()) || req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}

// تحديد الدولة/المدينة من IP عبر خدمة مجانية (best-effort مع مهلة قصيرة)
function geoLookup(ip: string): Promise<{ country?: string; countryCode?: string; region?: string; city?: string }> {
  return new Promise((resolve) => {
    if (!ip || ip.startsWith('127.') || ip === '::1' || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return resolve({});
    const r = http.get(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city`, (resp) => {
      let d = '';
      resp.on('data', (c) => (d += c));
      resp.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve(j.status === 'success' ? { country: j.country, countryCode: j.countryCode, region: j.regionName, city: j.city } : {});
        } catch { resolve({}); }
      });
    });
    r.on('error', () => resolve({}));
    r.setTimeout(2500, () => { r.destroy(); resolve({}); });
  });
}

// تسجيل زيارة — عام (يُستدعى من الواجهة عند تحميل صفحة عامّة)
router.post('/track', async (req: Request, res: Response) => {
  try {
    const { path, referrer, lang, utm, anonId, sessionId, first } = req.body || {};
    if (!path || typeof path !== 'string') { res.status(204).end(); return; }
    const ua = String(req.headers['user-agent'] || '');
    const isBot = BOT_RE.test(ua);
    const ip = clientIp(req);
    const ipHash = ip ? crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'fieldsa-visits')).digest('hex').slice(0, 16) : null;
    let referrerHost: string | null = null;
    if (referrer && typeof referrer === 'string') {
      try { const h = new URL(referrer).hostname; if (h && !/(^|\.)fieldsa\.net$/.test(h)) referrerHost = h; } catch { /* تجاهل */ }
    }
    const geo = isBot ? {} : await geoLookup(ip);
    // الإسناد: يُشتقّ على الخادم من وسوم مُطبَّعة + نطاق المُحيل (لا يُوثق بقيم العميل خاماً)
    const attr = resolveAttribution({ utm, referrerHost, path });
    const s40 = (v: unknown, n = 40) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
    await prisma.visit.create({
      data: {
        path: String(path).slice(0, 300),
        lang: typeof lang === 'string' ? lang.slice(0, 8) : null,
        referrer: typeof referrer === 'string' ? referrer.slice(0, 500) : null,
        referrerHost,
        userAgent: ua.slice(0, 300),
        ipHash,
        isBot,
        ...geo,
        anonId: s40(anonId),
        sessionId: s40(sessionId),
        utmSource: attr.utmSource,
        utmMedium: attr.utmMedium,
        utmCampaign: attr.utmCampaign,
        utmContent: attr.utmContent,
        utmTerm: attr.utmTerm,
        channel: attr.channel,
        aiEngine: attr.aiEngine,
        contentType: attr.contentType,
        // أول لمسة تُرسل من كوكي العميل وتُخزَّن كما هي (تُثبَّت مرّة ولا تُدهس)
        firstSource: s40(first?.source, 64),
        firstMedium: s40(first?.medium, 64),
        firstLanding: s40(first?.landing, 180),
      },
    });
    res.status(204).end();
  } catch { res.status(204).end(); }
});

/**
 * محوّل واتساب — الحلقة التي تُغلق الإسناد.
 *
 * المشكلة: `wa.me` لا يمرّر referrer ولا وسوم UTM، فالمحادثة تصل بلا مصدر.
 * الحل: كل أزرار واتساب تمرّ من هنا، فنسجّل النقرة بمرجع الصفحة ونولّد رمزاً
 * قصيراً يُلصق في نصّ الرسالة — فحين تصل المحادثة يحمل أول سطرٍ منها الرمز،
 * فتُوصل المحادثة بالصفحة التي أطلقتها وبأول لمسة عضوية.
 *
 * 🔴 هذا يقيس نقرة المستخدم فقط — لا يُبيح مراسلة أحد. لا رسائل مبتدأة إطلاقاً.
 */
router.get('/go/wa', async (req: Request, res: Response) => {
  const number = String(req.query.n || process.env.WHATSAPP_NUMBER || '966581835269').replace(/[^0-9]/g, '');
  const ref = String(req.query.ref || 'home').slice(0, 48);
  const fallback = `https://wa.me/${number}`;
  try {
    const anonId = String(req.query.a || '').slice(0, 40) || null;
    const code = makeWaCode(anonId || ref);
    const ua = String(req.headers['user-agent'] || '');
    const isBot = BOT_RE.test(ua);

    // نسجّل النقرة كصفّ زيارة موسوم (waClicked) — لا جدول جديد (قرار المالك)
    if (!isBot) {
      const ip = clientIp(req);
      const ipHash = ip ? crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'fieldsa-visits')).digest('hex').slice(0, 16) : null;
      prisma.visit.create({
        data: {
          path: `/go/wa/${ref}`.slice(0, 300),
          lang: String(req.query.l || '').slice(0, 8) || null,
          userAgent: ua.slice(0, 300),
          ipHash, isBot: false,
          anonId,
          waRef: ref, waCode: code, waClicked: true,
          channel: 'whatsapp_click',
          contentType: contentTypeOf(String(req.query.p || '')),
        },
      }).catch(() => { /* القياس لا يعطّل التحويل أبداً */ });
    }

    const text = `مرحباً، أتواصل بخصوص FieldSales.\nالمرجع: [FS-${code}]`;
    res.redirect(302, `https://wa.me/${number}?text=${encodeURIComponent(text)}`);
  } catch {
    res.redirect(302, fallback); // أي خطأ ⇒ يصل المستخدم لواتساب رغم فقد القياس
  }
});

interface V {
  createdAt: Date; path: string; referrerHost: string | null;
  country: string | null; city: string | null; countryCode: string | null;
  ipHash: string | null; lang: string | null;
  // طبقة الإسناد التسويقي (كلها اختيارية — الزيارات التاريخية بلا هذه القيم)
  channel: string | null; aiEngine: string | null; contentType: string | null;
  utmSource: string | null; utmMedium: string | null; utmCampaign: string | null;
  firstSource: string | null; firstMedium: string | null;
  waRef: string | null; waClicked: boolean | null; anonId: string | null;
}

function topCounts(items: V[], key: (v: V) => string | null, limit = 8) {
  const m = new Map<string, number>();
  for (const it of items) { const k = key(it); if (!k) continue; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([label, count]) => ({ label, count }));
}

// محركات الإجابة بالذكاء الاصطناعي — زيارة من أحد هذه المصادر = اقتباس/توصية من AI (مؤشّر GEO)
const AI_ENGINES: { label: string; re: RegExp }[] = [
  { label: 'ChatGPT', re: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i },
  { label: 'Perplexity', re: /(^|\.)perplexity\.ai$/i },
  { label: 'Gemini', re: /(^|\.)gemini\.google\.com$|(^|\.)bard\.google\.com$/i },
  { label: 'Claude', re: /(^|\.)claude\.ai$/i },
  { label: 'Copilot', re: /(^|\.)copilot\.microsoft\.com$/i },
  { label: 'Grok', re: /(^|\.)grok\.com$|(^|\.)x\.ai$/i },
  { label: 'DeepSeek', re: /(^|\.)deepseek\.com$/i },
  { label: 'Meta AI', re: /(^|\.)meta\.ai$/i },
  { label: 'أخرى (AI)', re: /(^|\.)you\.com$|(^|\.)poe\.com$|(^|\.)phind\.com$|(^|\.)mistral\.ai$|(^|\.)kagi\.com$/i },
];
const aiEngineOf = (host: string | null) => (host ? AI_ENGINES.find((e) => e.re.test(host))?.label || null : null);

// «الزيارات الحية» — عدد المستخدمين المتصلين بالمنصّة الآن عبر كل الشركات (للمالك فقط).
// «متصل الآن» = آخر ظهور خلال آخر ٥ دقائق. المندوب يُحدَّث lastSeenAt بنبض الحضور
// (كل ≤٣ دقائق)، ومستخدم الشركة يُلمَس في وسيط المصادقة (مخنوقاً لمرة/دقيقة).
// العدّ نفسه في services/presence.ts كي يتطابق الرقم اللحظيّ مع نقاط المنحنى.
router.get('/live-users', authenticate, requireSuperAdmin, async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = await computeLiveCounts();
    const ids = c.companies.map(x => x.tenantId);
    const tenants = ids.length
      ? await prisma.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, vertical: true } })
      : [];
    const metaBy = new Map(tenants.map(t => [t.id, t]));

    const companies = c.companies
      .map(x => {
        const t = metaBy.get(x.tenantId);
        return { ...x, name: t?.name || '—', vertical: t?.vertical || 'distribution' };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ar'));

    res.json({
      success: true,
      data: {
        windowMinutes: LIVE_WINDOW_MIN,
        total: c.total,
        totalReps: c.totalReps,
        totalAdmins: c.totalAdmins,
        activeCompanies: companies.length,
        companies,
        serverTime: new Date().toISOString(),
      },
    });
  } catch (err) { next(err); }
});

// المؤشّر الزمنيّ لـ«الزيارات الحية» — سلسلة لقطات الحضور عبر الوقت (للمالك فقط).
// النطاق: 24h (نقاط خام كل ٥د) · 7d (تجميع بالساعة) · 30d (تجميع باليوم).
// في الفترات المُجمَّعة نأخذ لقطة الذروة (أعلى total) كي يبقى reps+admins=total.
router.get('/live-history', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const range = String(req.query.range || '24h');
    const now = Date.now();
    let sinceMs: number;
    let bucket: 'raw' | 'hour' | 'day';
    if (range === '30d') { sinceMs = now - 30 * 86400000; bucket = 'day'; }
    else if (range === '7d') { sinceMs = now - 7 * 86400000; bucket = 'hour'; }
    else { sinceMs = now - 24 * 3600000; bucket = 'raw'; }

    const rows = await prisma.presenceSnapshot.findMany({
      where: { at: { gte: new Date(sinceMs) } },
      orderBy: { at: 'asc' },
      select: { at: true, reps: true, admins: true, total: true },
    });

    type Pt = { t: string; total: number; reps: number; admins: number };
    let points: Pt[];
    if (bucket === 'raw') {
      points = rows.map(r => ({ t: r.at.toISOString(), total: r.total, reps: r.reps, admins: r.admins }));
    } else {
      const size = bucket === 'hour' ? 3600000 : 86400000;
      // محاذاة حدود الدلو بتوقيت الرياض (UTC+3) لا UTC: وإلّا لَنُسِب نشاطُ ما قبل
      // الثالثة فجراً بتوقيت الرياض إلى اليوم السابق في عرض «٣٠ يوماً». (للساعة لا
      // فرق فعليّ لأن الإزاحة ساعاتٌ كاملة، لكن الصيغة موحّدة وآمنة.)
      const RIYADH_OFFSET_MS = 3 * 3600000;
      const peakBy = new Map<number, typeof rows[number]>();
      for (const r of rows) {
        const key = Math.floor((r.at.getTime() + RIYADH_OFFSET_MS) / size) * size - RIYADH_OFFSET_MS;
        const cur = peakBy.get(key);
        if (!cur || r.total > cur.total) peakBy.set(key, r); // ذروة الإشغال في الفترة
      }
      points = [...peakBy.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([key, r]) => ({ t: new Date(key).toISOString(), total: r.total, reps: r.reps, admins: r.admins }));
    }

    const peak = points.reduce((m, p) => Math.max(m, p.total), 0);
    res.json({ success: true, data: { range, bucket, points, peak, count: points.length, serverTime: new Date().toISOString() } });
  } catch (err) { next(err); }
});

// إحصاءات الزيارات — للسوبر أدمن فقط
router.get('/stats', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86400000);
    const rows = (await prisma.visit.findMany({
      where: { createdAt: { gte: since }, isBot: false },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true, path: true, referrerHost: true, country: true, city: true, countryCode: true, ipHash: true, lang: true,
        channel: true, aiEngine: true, contentType: true,
        utmSource: true, utmMedium: true, utmCampaign: true,
        firstSource: true, firstMedium: true, waRef: true, waClicked: true, anonId: true,
      },
    })) as V[];

    const total = rows.length;
    const uniques = new Set(rows.filter((r) => r.ipHash).map((r) => r.ipHash)).size;

    const nDays = Math.min(days, 14);
    const byDay: { date: string; count: number }[] = [];
    for (let i = nDays - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      byDay.push({ date: d, count: rows.filter((r) => new Date(r.createdAt).toISOString().slice(0, 10) === d).length });
    }

    // زيارات قادمة من محركات الذكاء الاصطناعي (GEO) — إجمالي + لكل محرك + سلسلة يومية
    const aiRows = rows.filter((r) => aiEngineOf(r.referrerHost));
    const aiByEngine = topCounts(aiRows, (r) => aiEngineOf(r.referrerHost), AI_ENGINES.length);
    const aiByDay = byDay.map(({ date }) => ({
      date,
      count: aiRows.filter((r) => new Date(r.createdAt).toISOString().slice(0, 10) === date).length,
    }));

    res.json({
      success: true,
      data: {
        total, uniques, days, byDay,
        byCountry: topCounts(rows, (r) => r.country),
        byCity: topCounts(rows, (r) => (r.city && r.country ? `${r.city} · ${r.country}` : r.city)),
        byReferrer: topCounts(rows, (r) => r.referrerHost || 'زيارة مباشرة'),
        byPath: topCounts(rows, (r) => r.path),
        byLang: topCounts(rows, (r) => r.lang),
        // --- طبقة الإسناد التسويقي ---
        attribution: (() => {
          // نقرات واتساب تُسجَّل كصفوف مستقلّة موسومة — تُفصل عن مشاهدات الصفحات
          const waRows = rows.filter((r) => r.waClicked === true);
          const pageRows = rows.filter((r) => r.waClicked !== true);
          const known = pageRows.filter((r) => r.channel);
          return {
            // نسبة الزيارات التي نعرف مصدرها فعلاً — مؤشّر صحّة القياس نفسه
            coverage: pageRows.length ? Math.round((known.length / pageRows.length) * 100) : 0,
            byChannel: topCounts(known, (r) => r.channel),
            byContentType: topCounts(known, (r) => r.contentType),
            byUtmSource: topCounts(pageRows.filter((r) => r.utmSource), (r) => r.utmSource),
            byCampaign: topCounts(pageRows.filter((r) => r.utmCampaign), (r) => r.utmCampaign),
            // أول لمسة: القناة التي جلبت الزائر أوّلاً لا التي أعادته
            byFirstTouch: topCounts(pageRows.filter((r) => r.firstSource), (r) => r.firstSource),
            whatsapp: {
              clicks: waRows.length,
              // أي صفحة تُنتج المحادثات فعلاً — جوهر قياس القناة
              byRef: topCounts(waRows, (r) => r.waRef, 12),
              // زوّار فريدون نقروا (لا نقرات مكرّرة من الشخص نفسه)
              uniqueClickers: new Set(waRows.filter((r) => r.anonId).map((r) => r.anonId)).size,
            },
          };
        })(),
        ai: { total: aiRows.length, byEngine: aiByEngine, byDay: aiByDay },
        recent: rows.slice(0, 60).map((r) => ({
          at: r.createdAt, path: r.path, referrer: r.referrerHost || 'مباشر',
          country: r.country, city: r.city, countryCode: r.countryCode,
        })),
      },
    });
  } catch (err) { next(err); }
});

export default router;
