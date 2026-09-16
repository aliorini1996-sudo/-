// مثبّتات Z3: أجسام ردود/طلبات واجهة «فاتورة» في __fixtures__/z3 — كل ملف يحمل مصدره (source) ودرجة دليله (evidence).
// OFFICIAL = أمثلة Swagger الرسمية [S1] كما اقتبسها report_apis-onboarding؛ STAFF/COMMUNITY = منتدى الهيئة؛ 3P = مرآة OpenAPI.
// حيث قصّ التقرير قيمة (الرمز، المستند) يشرح notes ما استُبدل بها. لا شيء هنا يتصل بشبكة.
import fs from 'fs';
import path from 'path';

export const Z3_DIR = path.join(__dirname, 'z3');

export type Evidence = 'OFFICIAL' | 'STAFF' | 'COMMUNITY' | '3P';

export interface Z3Fixture {
  name: string;
  source: string;
  evidence: Evidence;
  endpoint: string;
  kind: 'response' | 'request';
  httpStatus?: number;
  contentType?: string;
  notes?: string;
  csrPem?: string;
  bodyFile?: string;
  body?: unknown;
  /** نصّ الجسم كما يُرسَل على السلك: JSON.stringify(body) أو محتوى bodyFile. */
  raw: string;
}

export function z3FixtureNames(): string[] {
  return fs.readdirSync(Z3_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -'.json'.length)).sort();
}

export function z3Fixture(name: string): Z3Fixture {
  const env = JSON.parse(fs.readFileSync(path.join(Z3_DIR, `${name}.json`), 'utf8')) as Omit<Z3Fixture, 'raw'>;
  const raw = env.bodyFile ? fs.readFileSync(path.join(Z3_DIR, env.bodyFile), 'utf8') : JSON.stringify(env.body);
  return { ...env, raw };
}

/** جسم الرد كائناً (نسخة جديدة لكل استدعاء كي يُعدَّل في الاختبار بأمان). */
export function z3Body<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(z3Fixture(name).raw) as T;
}
