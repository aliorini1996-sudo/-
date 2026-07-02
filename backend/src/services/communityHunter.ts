/**
 * محرّك بحث المجتمعات المستمر — يبحث عن قروبات/مجتمعات المهتمين بالتوزيع وإدارة المناديب
 * على المنصّات العامة (فيسبوك/لينكدإن/تليجرام/واتساب/ريديت/ديسكورد) بلا توقّف.
 * يُخزّن النتائج كـ leads بمصدر source='community' (قابلة للفلترة والتصدير).
 * الإعداد في SiteContent id="community_hunt" — بلا تغيير مخطّط.
 */
import prisma from '../config/database';
import { searchCommunities, providersReady, RawLead } from './leadSources';

export interface CommunityConfig {
  enabled: boolean;
  countries: string[];
  keywordsPerRun: number;
  limit: number;
  countryIndex: number;
  lastRunAt: string | null;
  totalRuns: number;
  totalImported: number;
}

const DEFAULT_CONFIG: CommunityConfig = {
  enabled: false,
  countries: ['السعودية', 'مصر', 'الإمارات', 'الأردن', 'المغرب', 'الجزائر', 'العراق', 'الكويت', 'عالمي'],
  keywordsPerRun: 3,
  limit: 20,
  countryIndex: 0,
  lastRunAt: null,
  totalRuns: 0,
  totalImported: 0,
};

const CONFIG_ID = 'community_hunt';

export async function getCommunityConfig(): Promise<CommunityConfig> {
  const row = await prisma.siteContent.findUnique({ where: { id: CONFIG_ID } });
  if (!row?.data) return { ...DEFAULT_CONFIG };
  try { return { ...DEFAULT_CONFIG, ...(JSON.parse(row.data) as Partial<CommunityConfig>) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}

export async function saveCommunityConfig(cfg: CommunityConfig): Promise<void> {
  await prisma.siteContent.upsert({
    where: { id: CONFIG_ID },
    create: { id: CONFIG_ID, data: JSON.stringify(cfg) },
    update: { data: JSON.stringify(cfg) },
  });
}

// بنك كلمات احتياطي موجّه للمجتمعات (عربي + إنجليزي)
const KEYWORD_BANK = [
  'مجموعة موزعين', 'قروب تجار جملة', 'مجموعة إدارة مبيعات', 'منتدى التوزيع', 'مجموعة مناديب مبيعات',
  'مجموعة تجارة الجملة', 'قروب موزعي المواد الغذائية', 'مجتمع ريادة الأعمال التجارية', 'مجموعة سوبر ماركت وبقالات',
  'wholesale distributors group', 'distribution managers community', 'FMCG sales professionals',
  'field sales network', 'route sales group', 'sales reps community', 'retail distribution forum',
  'small business owners group', 'B2B sales group', 'supply chain professionals',
];

export async function generateCommunityKeywords(country: string, count: number, used: string[]): Promise<string[]> {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  const usedSet = new Set(used.map((u) => u.trim().toLowerCase()));
  if (key) {
    try {
      const system =
        'أنت خبير تسويق B2B لمنصّة Field Sales. ولّد مصطلحات بحث للعثور على **مجموعات/مجتمعات/قروبات** ' +
        `(فيسبوك/لينكدإن/تليجرام/واتساب/ريديت) للمهتمين بالتوزيع وإدارة المناديب والجملة والتجزئة في «${country}». ` +
        'استخدم لغة البلد + بعضها إنجليزي. تجنّب: ' + (used.slice(-40).join('، ') || 'لا شيء') + '. أعِد JSON مصفوفة نصوص فقط.';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 500, system, messages: [{ role: 'user', content: `ولّد ${count} مصطلحاً لـ${country}.` }] }),
      });
      if (r.ok) {
        const j = (await r.json()) as { content?: Array<{ text?: string }> };
        const m = (j.content?.[0]?.text || '').match(/\[[\s\S]*\]/);
        if (m) {
          const arr = (JSON.parse(m[0]) as string[]).map((s) => String(s).trim()).filter((s) => s && !usedSet.has(s.toLowerCase()));
          if (arr.length) return arr.slice(0, count);
        }
      }
    } catch { /* fallback */ }
  }
  const fresh = KEYWORD_BANK.filter((k) => !usedSet.has(k.toLowerCase()));
  const pool = fresh.length ? fresh : KEYWORD_BANK;
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(pool[Math.floor(Math.random() * pool.length)]);
  return [...new Set(out)];
}

export async function runCommunityHuntBatch(): Promise<{ country: string; keywords: string[]; found: number; imported: number }> {
  const cfg = await getCommunityConfig();
  if (!providersReady().community) {
    return { country: '', keywords: [], found: 0, imported: 0 };
  }
  const country = cfg.countries[cfg.countryIndex % Math.max(1, cfg.countries.length)] || 'السعودية';

  const recent = await prisma.leadSearch.findMany({ where: { provider: 'community' }, orderBy: { createdAt: 'desc' }, take: 60, select: { query: true } });
  const used = recent.flatMap((r) => r.query.split(/[،,+]/).map((s) => s.trim())).filter(Boolean);
  const keywords = await generateCommunityKeywords(country, cfg.keywordsPerRun, used);

  const search = await prisma.leadSearch.create({ data: { provider: 'community', query: keywords.join('، '), country, status: 'running', createdBy: 'community-hunt' } });

  const rawAll: RawLead[] = [];
  for (const q of keywords) {
    try { rawAll.push(...(await searchCommunities(q, country === 'عالمي' ? undefined : country, undefined, cfg.limit))); }
    catch { /* تجاهل خطأ نشاط */ }
  }
  const seen = new Set<string>();
  const raw = rawAll.filter((r) => (seen.has(r.sourceId) ? false : (seen.add(r.sourceId), true)));
  const existing = await prisma.lead.findMany({ where: { sourceId: { in: raw.map((r) => r.sourceId) } }, select: { sourceId: true } });
  const have = new Set(existing.map((e) => e.sourceId));
  const fresh = raw.filter((r) => !have.has(r.sourceId));

  let imported = 0;
  for (const f of fresh) {
    try {
      const lead = await prisma.lead.create({
        data: {
          name: f.name, website: f.website, mapsUrl: f.mapsUrl, city: f.city, country: f.country,
          countryCode: f.countryCode, category: f.category, source: 'community', sourceId: f.sourceId,
        },
      });
      await prisma.leadActivity.create({ data: { leadId: lead.id, type: 'IMPORT', content: `اكتشاف مجتمع (${f.category})`, createdBy: 'community-hunt' } });
      imported++;
    } catch { /* تصادم */ }
  }

  await prisma.leadSearch.update({ where: { id: search.id }, data: { status: 'done', found: raw.length, imported } });
  cfg.countryIndex = (cfg.countryIndex + 1) % Math.max(1, cfg.countries.length);
  cfg.totalRuns += 1;
  cfg.totalImported += imported;
  cfg.lastRunAt = new Date().toISOString();
  await saveCommunityConfig(cfg);

  return { country, keywords, found: raw.length, imported };
}
