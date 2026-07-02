import { Router, Request, Response, NextFunction } from 'express';
import http from 'http';
import crypto from 'crypto';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';

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
    const { path, referrer, lang } = req.body || {};
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
      },
    });
    res.status(204).end();
  } catch { res.status(204).end(); }
});

interface V {
  createdAt: Date; path: string; referrerHost: string | null;
  country: string | null; city: string | null; countryCode: string | null;
  ipHash: string | null; lang: string | null;
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

// إحصاءات الزيارات — للسوبر أدمن فقط
router.get('/stats', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86400000);
    const rows = (await prisma.visit.findMany({
      where: { createdAt: { gte: since }, isBot: false },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, path: true, referrerHost: true, country: true, city: true, countryCode: true, ipHash: true, lang: true },
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
