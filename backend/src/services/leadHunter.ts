/**
 * محرّك الصيد المستمر (Auto-Hunt) — يولّد كلمات بحث جديدة ويبحث بها تلقائياً
 * عبر المصادر المجانية ودول متعدّدة، ليستمرّ جمع العملاء المحتملين بلا توقّف.
 *
 * الإعداد يُخزَّن في SiteContent (id="lead_autohunt") — بلا تغيير مخطّط.
 * التشغيل الدوري عبر GitHub Actions (يستدعي /api/leads-cron/run) أو يدوياً من اللوحة.
 */
import prisma from '../config/database';
import { runSearch, qualifyLeads, providersReady, LeadProvider, RawLead } from './leadSources';
import { enrichFromWebsite, hunterDomainSearch } from './enrich';
import { geminiGenerate, geminiReady } from './gemini';

export interface HuntConfig {
  enabled: boolean;
  providers: LeadProvider[];
  countries: string[];
  city: string | null;
  keywordsPerRun: number;
  qualify: boolean;
  enrich: boolean;
  enrichHunter: boolean;
  limit: number;
  countryIndex: number;
  cityIndex?: number;
  lastRunAt: string | null;
  totalRuns: number;
  totalImported: number;
}

// كل الدول العربية القابلة للصيد — تُستخدم افتراضياً وكزرّ «كل الدول» في اللوحة
export const ARAB_COUNTRIES = [
  'السعودية', 'مصر', 'الإمارات', 'الكويت', 'قطر', 'البحرين', 'عُمان',
  'الأردن', 'المغرب', 'الجزائر', 'تونس', 'العراق', 'لبنان', 'ليبيا',
  'فلسطين', 'السودان', 'اليمن', 'سوريا', 'موريتانيا',
];

const DEFAULT_CONFIG: HuntConfig = {
  enabled: false,
  providers: ['osm', 'geoapify', 'tomtom', 'serper'],
  countries: [...ARAB_COUNTRIES],
  city: null,
  keywordsPerRun: 2,
  qualify: true,
  enrich: true,
  enrichHunter: false,
  limit: 40,
  countryIndex: 0,
  lastRunAt: null,
  totalRuns: 0,
  totalImported: 0,
};

const CONFIG_ID = 'lead_autohunt';

// بنك مدن رئيسية لكل دولة — تدوير مناطق البحث يضاعف مساحة الصيد الطازجة (كل مدينة شركات محلية جديدة)
const CITY_BANK: Record<string, string[]> = {
  'السعودية': ['الرياض', 'جدة', 'مكة', 'المدينة المنورة', 'الدمام', 'الخبر', 'الطائف', 'بريدة', 'تبوك', 'خميس مشيط', 'حائل', 'نجران', 'الأحساء', 'القطيف', 'ينبع', 'أبها', 'الجبيل', 'عرعر'],
  'مصر': ['القاهرة', 'الجيزة', 'الإسكندرية', 'شبرا الخيمة', 'بورسعيد', 'السويس', 'المنصورة', 'طنطا', 'أسيوط', 'الفيوم', 'الزقازيق', 'الإسماعيلية', 'أسوان', 'دمياط', 'المنيا', 'بني سويف', 'سوهاج', 'المحلة الكبرى'],
  'الإمارات': ['دبي', 'أبوظبي', 'الشارقة', 'العين', 'عجمان', 'رأس الخيمة', 'الفجيرة', 'أم القيوين'],
  'الكويت': ['مدينة الكويت', 'حولي', 'الفروانية', 'الأحمدي', 'الجهراء', 'مبارك الكبير', 'الفحيحيل', 'الصليبية'],
  'قطر': ['الدوحة', 'الريان', 'الوكرة', 'الخور', 'أم صلال', 'الشحانية', 'مسيعيد'],
  'البحرين': ['المنامة', 'المحرق', 'الرفاع', 'مدينة حمد', 'مدينة عيسى', 'سترة', 'جدحفص'],
  'عُمان': ['مسقط', 'صلالة', 'صحار', 'نزوى', 'صور', 'البريمي', 'عبري', 'بركاء', 'الرستاق', 'إبراء'],
  'الأردن': ['عمّان', 'الزرقاء', 'إربد', 'الرصيفة', 'العقبة', 'السلط', 'مادبا', 'جرش', 'المفرق', 'الكرك'],
  'المغرب': ['الدار البيضاء', 'الرباط', 'فاس', 'مراكش', 'طنجة', 'أكادير', 'مكناس', 'وجدة', 'القنيطرة', 'تطوان', 'سلا', 'الجديدة', 'بني ملال'],
  'الجزائر': ['الجزائر', 'وهران', 'قسنطينة', 'عنابة', 'باتنة', 'البليدة', 'سطيف', 'سيدي بلعباس', 'بسكرة', 'تلمسان', 'بجاية', 'تيزي وزو', 'ورقلة'],
  'تونس': ['تونس', 'صفاقس', 'سوسة', 'القيروان', 'بنزرت', 'قابس', 'أريانة', 'المنستير', 'قفصة', 'نابل'],
  'العراق': ['بغداد', 'البصرة', 'الموصل', 'أربيل', 'النجف', 'كربلاء', 'السليمانية', 'كركوك', 'الناصرية', 'الحلة', 'الرمادي', 'دهوك', 'العمارة'],
  'لبنان': ['بيروت', 'طرابلس', 'صيدا', 'صور', 'جونية', 'زحلة', 'بعلبك', 'النبطية', 'جبيل'],
  'ليبيا': ['طرابلس', 'بنغازي', 'مصراتة', 'الزاوية', 'البيضاء', 'سبها', 'طبرق', 'زليتن', 'أجدابيا', 'الخمس'],
  'فلسطين': ['غزة', 'رام الله', 'نابلس', 'الخليل', 'جنين', 'بيت لحم', 'طولكرم', 'قلقيلية', 'رفح', 'خان يونس'],
  'السودان': ['الخرطوم', 'أم درمان', 'بورتسودان', 'كسلا', 'الأبيض', 'نيالا', 'ود مدني', 'القضارف', 'الفاشر', 'كوستي'],
  'اليمن': ['صنعاء', 'عدن', 'تعز', 'الحديدة', 'المكلا', 'إب', 'ذمار', 'سيئون'],
  'سوريا': ['دمشق', 'حلب', 'حمص', 'حماة', 'اللاذقية', 'طرطوس', 'دير الزور', 'الرقة', 'الحسكة'],
  'موريتانيا': ['نواكشوط', 'نواذيبو', 'كيفة', 'روصو', 'كيهيدي', 'زويرات', 'العيون'],
};

export async function getHuntConfig(): Promise<HuntConfig> {
  const row = await prisma.siteContent.findUnique({ where: { id: CONFIG_ID } });
  if (!row?.data) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(row.data) as Partial<HuntConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveHuntConfig(cfg: HuntConfig): Promise<void> {
  await prisma.siteContent.upsert({
    where: { id: CONFIG_ID },
    create: { id: CONFIG_ID, data: JSON.stringify(cfg) },
    update: { data: JSON.stringify(cfg) },
  });
}

// بنك كلمات احتياطي (يُستخدم إن لم يتوفّر Claude) — أنشطة جملة/توزيع/توريد
const KEYWORD_BANK = [
  'تجارة جملة', 'موزّع مواد غذائية', 'مستودع توزيع', 'شركة توريدات', 'موزّع مشروبات',
  'تاجر جملة', 'موزّع مستلزمات طبية', 'موزّع منتجات تنظيف', 'موزّع مواد بناء', 'موزّع قطع غيار',
  'موزّع إلكترونيات', 'موزّع أدوات منزلية', 'موزّع مستحضرات تجميل', 'موزّع أغذية معلّبة', 'موزّع ألبان',
  'شركة لوجستية', 'مركز توزيع', 'موزّع قرطاسية', 'موزّع أدوات كهربائية', 'موزّع أدوية',
  'wholesale distributor', 'food distributor', 'beverage distributor', 'FMCG distributor',
  'building materials supplier', 'auto parts distributor', 'electronics wholesaler',
  'medical supplies distributor', 'cleaning products distributor', 'logistics company',
];

// يولّد كلمات بحث جديدة (Claude إن توفّر، وإلا من البنك) مع تجنّب المستخدمة سابقاً
export async function generateKeywords(country: string, count: number, used: string[]): Promise<string[]> {
  const usedSet = new Set(used.map((u) => u.trim().toLowerCase()));

  if (geminiReady()) {
    try {
      const system =
        'أنت خبير تنقيب مبيعات B2B لمنصّة Field Sales (إدارة مبيعات مناديب التوزيع). ' +
        `ولّد ${count} مصطلح بحث قصير ومتنوّع القطاعات للعثور على شركات جملة/توزيع/توريد في «${country}». ` +
        'استخدم لغة البلد (عربية للدول العربية) وأضِف بعضها بالإنجليزية. ' +
        'تجنّب تكرار هذه المستخدمة سابقاً: ' + (used.slice(-40).join('، ') || 'لا شيء') + '. ' +
        'أعِد JSON فقط: مصفوفة نصوص بلا أي شرح.';
      const text = await geminiGenerate(system, `ولّد ${count} مصطلحاً جديداً لـ${country}.`, { maxTokens: 500, temperature: 0.9 });
      const m = text.match(/\[[\s\S]*\]/);
      if (m) {
        const arr = (JSON.parse(m[0]) as string[])
          .map((s) => String(s).trim())
          .filter((s) => s && !usedSet.has(s.toLowerCase()));
        if (arr.length) return arr.slice(0, count);
      }
    } catch {
      // نتجاهل ونعود للبنك
    }
  }

  // احتياطي: كلمات غير مستخدمة من البنك
  const fresh = KEYWORD_BANK.filter((k) => !usedSet.has(k.toLowerCase()));
  const pool = fresh.length ? fresh : KEYWORD_BANK;
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(pool[Math.floor(Math.random() * pool.length)]);
  return [...new Set(out)];
}

// تشغيل دفعة صيد واحدة (دولة + كلمات جديدة عبر المصادر الجاهزة)
export async function runAutoHuntBatch(createdBy = 'auto-hunt'): Promise<{
  country: string; keywords: string[]; found: number; imported: number; enrichedEmail: number; errors: string[];
}> {
  const cfg = await getHuntConfig();
  const ready = providersReady();
  const providers = cfg.providers.filter((p) => ready[p]);
  const country = cfg.countries[cfg.countryIndex % Math.max(1, cfg.countries.length)] || 'السعودية';

  // تدوير المدينة تلقائياً (إن لم يحدّد المالك مدينة ثابتة) — كل دفعة تبحث منطقة جديدة
  // فتتضاعف مساحة الصيد الطازجة بدل استنزاف نتائج مستوى الدولة نفسها.
  const cities = CITY_BANK[country] || [];
  const activeCity = cfg.city || (cities.length ? cities[(cfg.cityIndex ?? 0) % cities.length] : null);

  // الكلمات المستخدمة مؤخراً (لتجنّب التكرار)
  const recent = await prisma.leadSearch.findMany({
    orderBy: { createdAt: 'desc' }, take: 80, select: { query: true },
  });
  const used = recent.flatMap((r) => r.query.split(/[،,+]/).map((s) => s.trim())).filter(Boolean);
  const keywords = await generateKeywords(country, cfg.keywordsPerRun, used);

  const search = await prisma.leadSearch.create({
    data: { provider: providers.join('+') || 'none', query: keywords.join('، '), country, city: activeCity, status: 'running', createdBy },
  });

  const rawAll: RawLead[] = [];
  const errors: string[] = [];
  for (const p of providers) {
    for (const q of keywords) {
      try { rawAll.push(...(await runSearch(p, q, country, activeCity || undefined, cfg.limit))); }
      catch (e) { errors.push(`${p} · «${q}»: ${(e as Error).message}`); }
    }
  }

  // إزالة التكرار الداخلي ثم مقابل قاعدة البيانات
  const seen = new Set<string>();
  const raw = rawAll.filter((r) => (seen.has(r.sourceId) ? false : (seen.add(r.sourceId), true)));
  const existing = await prisma.lead.findMany({ where: { sourceId: { in: raw.map((r) => r.sourceId) } }, select: { sourceId: true } });
  const have = new Set(existing.map((e) => e.sourceId));
  const fresh = raw.filter((r) => !have.has(r.sourceId));

  let scores: Map<number, { score: number; note: string }> = new Map();
  if (cfg.qualify && fresh.length) {
    scores = await qualifyLeads(fresh.map((f) => ({ name: f.name, category: f.category, city: f.city, country: f.country })));
  }

  let imported = 0;
  const created: { id: string; website: string | null }[] = [];
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i];
    const sc = scores.get(i);
    try {
      const lead = await prisma.lead.create({
        data: {
          name: f.name, phone: f.phone, email: f.email, website: f.website, address: f.address,
          city: f.city, country: f.country, countryCode: f.countryCode, category: f.category,
          lat: f.lat, lng: f.lng, mapsUrl: f.mapsUrl, source: f.source, sourceId: f.sourceId,
          score: sc?.score ?? null, scoreNote: sc?.note ?? null,
        },
      });
      await prisma.leadActivity.create({ data: { leadId: lead.id, type: 'IMPORT', content: `صيد مستمر عبر ${f.source}`, createdBy } });
      created.push({ id: lead.id, website: lead.website });
      imported++;
    } catch { /* تصادم نادر */ }
  }

  // إثراء تلقائي
  let enrichedEmail = 0;
  if (cfg.enrich) {
    for (const c of created.filter((c) => c.website).slice(0, 30)) {
      const found = await enrichFromWebsite(c.website!);
      if (cfg.enrichHunter && !found.email) {
        const h = await hunterDomainSearch(c.website!);
        found.email = found.email || h.email;
        found.phone = found.phone || h.phone;
      }
      const data: Record<string, unknown> = {};
      if (found.email) { data.email = found.email; enrichedEmail++; }
      if (found.phone) data.phone = found.phone;
      if (Object.keys(data).length) await prisma.lead.update({ where: { id: c.id }, data }).catch(() => {});
    }
  }

  await prisma.leadSearch.update({ where: { id: search.id }, data: { status: 'done', found: raw.length, imported, error: errors.length ? errors.join(' | ') : null } });

  cfg.countryIndex = (cfg.countryIndex + 1) % Math.max(1, cfg.countries.length);
  // بعد إكمال دورة كاملة على كل الدول، انتقل لمدينة تالية في كل دولة (تغطية شبكية كاملة: دول × مدن)
  if (cfg.countryIndex === 0) cfg.cityIndex = (cfg.cityIndex ?? 0) + 1;
  cfg.totalRuns += 1;
  cfg.totalImported += imported;
  cfg.lastRunAt = new Date().toISOString();
  await saveHuntConfig(cfg);

  return { country, keywords, found: raw.length, imported, enrichedEmail, errors };
}
