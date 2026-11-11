// ============================================================================
// «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — تصحيح منظور صورة النموذج الفارغ: الشركة تصوّر ورقتها بالجوال
// (مائلةً غالباً) وتضع أركانها الأربعة، فنحوّل الشكل الرباعي إلى مستطيل الورقة بالضبط (A4 = 1240 × 1754 بكسل عند 150 نقطة).
//
// خالصٌ بلا DOM ولا مكتبة: حلّ التحويل الإسقاطي (homography) من أربع نقاط بحذف غاوس على نظام 8×8، وأخذ العيّنات العكسي
// (لكل بكسل في المستطيل: موضعه في الصورة) بالاستيفاء الثنائي الخطي على مصفوفة RGBA — فيُختبر في node.
//
// الإحداثيات متصلة: ركن الصورة الأيسر الأعلى (0,0) وركنها الأيمن الأسفل (w,h)، ومركز البكسل (i,j) هو (i+0.5, j+0.5).
// ترتيب الأركان في كل شكل رباعي: أعلى اليسار، أعلى اليمين، أسفل اليمين، أسفل اليسار (ماديّاً، لا حسب اتجاه الواجهة).
// ============================================================================

export interface Pt { x: number; y: number }
/** شكلٌ رباعي: أعلى اليسار، أعلى اليمين، أسفل اليمين، أسفل اليسار */
export type Quad = readonly [Pt, Pt, Pt, Pt];
/** مصفوفة 3×3 صفّاً بصفّ، وعنصرها الأخير 1 */
export type Homography = readonly [number, number, number, number, number, number, number, number, number];

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const PIVOT_EPS = 1e-12;

/** أركان المستطيل 0..w × 0..h بالترتيب المعتمد */
export function rectQuad(w: number, h: number): Quad {
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
}

/**
 * حلّ A·x = b بحذف غاوس مع اختيار المحور الجزئي — لا يغيّر المدخلات. null إن كان النظام منفرداً (أو فيه ما ليس عدداً).
 */
export function solveLinear(A: readonly (readonly number[])[], b: readonly number[]): number[] | null {
  const n = b.length;
  if (A.length !== n) return null;
  const m = A.map((row, i) => {
    if (row.length !== n) return null;
    return [...row, b[i]];
  });
  if (m.some((r) => r === null || r.some((v) => !fin(v)))) return null;
  const M = m as number[][];
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < PIVOT_EPS) return null;
    if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
    const p = M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / p;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x.every(fin) ? x : null;
}

/** أكبر قيمةٍ مطلقة في إحداثيات الشكل — للتطبيع (1 إن كانت كلها أصفاراً) */
const spanOf = (q: Quad): number => Math.max(1, ...q.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));

/**
 * التحويل الإسقاطي H الذي ينقل أركان src إلى أركان dst بالترتيب: dst[i] ≃ H·src[i]. نظام 8×8 (h33 = 1) بإحداثياتٍ مطبَّعة
 * (قسمةً على أكبر قيمة) لئلّا تتضخّم الحدود (بكسلات حتى آلاف). null إن كانت ثلاث نقاطٍ على خطٍّ واحد أو القيم غير عددية.
 */
export function solveHomography(src: Quad, dst: Quad): Homography | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  if ([...src, ...dst].some((p) => !p || !fin(p.x) || !fin(p.y))) return null;
  const ss = 1 / spanOf(src);
  const sd = 1 / spanOf(dst);
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const x = src[i].x * ss; const y = src[i].y * ss;
    const u = dst[i].x * sd; const v = dst[i].y * sd;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  // تحويلٌ منحطّ (كل الأركان في نقطةٍ أو على خطّ): المحدِّد صفر في الإحداثيات المطبَّعة
  const det = h[0] * (h[4] - h[5] * h[7]) - h[1] * (h[3] - h[5] * h[6]) + h[2] * (h[3] * h[7] - h[4] * h[6]);
  if (!fin(det) || Math.abs(det) < 1e-10) return null;
  // H = diag(1/sd, 1/sd, 1) · H' · diag(ss, ss, 1)
  const raw = [
    (h[0] * ss) / sd, (h[1] * ss) / sd, h[2] / sd,
    (h[3] * ss) / sd, (h[4] * ss) / sd, h[5] / sd,
    h[6] * ss, h[7] * ss, 1,
  ];
  return raw.every(fin) ? (raw as unknown as Homography) : null;
}

/** صورة النقطة (x,y) بالتحويل H — null إن وقعت في اللانهاية (المقام صفر) */
export function applyH(H: Homography, x: number, y: number): Pt | null {
  const w = H[6] * x + H[7] * y + H[8];
  if (!fin(w) || Math.abs(w) < PIVOT_EPS) return null;
  const px = (H[0] * x + H[1] * y + H[2]) / w;
  const py = (H[3] * x + H[4] * y + H[5]) / w;
  return fin(px) && fin(py) ? { x: px, y: py } : null;
}

/** معكوس H (مطبَّعاً بحيث العنصر الأخير 1) — null إن كان منفرداً */
export function invertH(H: Homography): Homography | null {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!fin(det) || Math.abs(det) < PIVOT_EPS) return null;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ].map((v) => v / det);
  const k = inv[8];
  if (!fin(k) || Math.abs(k) < PIVOT_EPS) return null;
  const out = inv.map((v) => v / k);
  return out.every(fin) ? (out as unknown as Homography) : null;
}

const cross = (o: Pt, a: Pt, b: Pt): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/**
 * المساحة الموقّعة (صيغة شريط الحذاء) في فضاء الشاشة (y لأسفل): موجبةٌ للترتيب المعتمد أعلى اليسار ← أعلى اليمين ← أسفل اليمين ←
 * أسفل اليسار (مع عقارب الساعة على الشاشة)، وسالبةٌ للمعكوس — الذي يُخرج الصورة مقلوبةً كالمرآة.
 */
export function quadSignedArea(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) { const p = q[i]; const n = q[(i + 1) % 4]; s += p.x * n.y - n.x * p.y; }
  return s / 2;
}

/** مساحة الشكل الرباعي (صيغة شريط الحذاء، قيمةٌ مطلقة) */
export function quadArea(q: Quad): number {
  return Math.abs(quadSignedArea(q));
}

/**
 * شكلٌ رباعي محدّب غير متقاطع، بمساحةٍ لا تقلّ عن minArea — شرط التصحيح: ركنان متبادلان أو ثلاثة على خطٍّ واحد يُفسدان الصورة.
 * الاتجاه (مع عقارب الساعة أو عكسها) لا يُفحص هنا — يفحصه quadUsable (quadSignedArea > 0): المعكوس يُخرج صورةً كالمرآة.
 */
export function isConvexQuad(q: Quad, minArea = 1): boolean {
  if (!q || q.length !== 4 || q.some((p) => !p || !fin(p.x) || !fin(p.y))) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(c) < 1e-9) return false;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return quadArea(q) >= minArea;
}

/**
 * التصحيح: مصفوفة RGBA بأبعاد dw × dh، كلّ بكسلٍ فيها مأخوذٌ من الصورة (srcRGBA بأبعاد sw × sh) عند H·(مركزه) بالاستيفاء
 * الثنائي الخطي. H هنا من المستطيل إلى الصورة (العكسي) — solveHomography(rectQuad(dw, dh), أركان الورقة في الصورة).
 * الشفافية تُركَّب فوق الأبيض (الناتج معتمٌ كلّه: الورقة بيضاء، وJPEG بلا شفافية)، وما يقع خارج الصورة أبيض.
 * out اختياري (مثلاً ImageData.data بطول dw*dh*4) يُكتب فيه بدل مصفوفةٍ جديدة.
 */
export function warpToRect(
  srcRGBA: Uint8ClampedArray, sw: number, sh: number, H: Homography, dw: number, dh: number, out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const W = Math.max(0, Math.floor(dw)); const Hh = Math.max(0, Math.floor(dh));
  const dst = out && out.length >= W * Hh * 4 ? out : new Uint8ClampedArray(W * Hh * 4);
  const sW = Math.floor(sw); const sH = Math.floor(sh);
  const okSrc = sW > 0 && sH > 0 && srcRGBA.length >= sW * sH * 4 && H.every(fin);
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;
  const maxX = sW - 1; const maxY = sH - 1;
  for (let j = 0; j < Hh; j++) {
    const y = j + 0.5;
    // قيم البسط والمقام عند i = 0، ثم تزيد بثابتٍ مع كل بكسل
    let X = h0 * 0.5 + h1 * y + h2;
    let Y = h3 * 0.5 + h4 * y + h5;
    let Z = h6 * 0.5 + h7 * y + h8;
    let o = j * W * 4;
    for (let i = 0; i < W; i++, X += h0, Y += h3, Z += h6, o += 4) {
      let r = 255; let g = 255; let b = 255;
      if (okSrc && Z !== 0) {
        const sx = X / Z - 0.5;
        const sy = Y / Z - 0.5;
        if (sx > -1 && sy > -1 && sx < sW && sy < sH) {
          let x0 = Math.floor(sx); let y0 = Math.floor(sy);
          const fx = sx - x0; const fy = sy - y0;
          let x1 = x0 + 1; let y1 = y0 + 1;
          if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
          if (x1 > maxX) x1 = maxX; if (y1 > maxY) y1 = maxY;
          if (x0 > maxX) x0 = maxX; if (y0 > maxY) y0 = maxY;
          const p00 = (y0 * sW + x0) * 4; const p10 = (y0 * sW + x1) * 4;
          const p01 = (y1 * sW + x0) * 4; const p11 = (y1 * sW + x1) * 4;
          const w00 = (1 - fx) * (1 - fy); const w10 = fx * (1 - fy); const w01 = (1 - fx) * fy; const w11 = fx * fy;
          const a = srcRGBA[p00 + 3] * w00 + srcRGBA[p10 + 3] * w10 + srcRGBA[p01 + 3] * w01 + srcRGBA[p11 + 3] * w11;
          const cr = srcRGBA[p00] * w00 + srcRGBA[p10] * w10 + srcRGBA[p01] * w01 + srcRGBA[p11] * w11;
          const cg = srcRGBA[p00 + 1] * w00 + srcRGBA[p10 + 1] * w10 + srcRGBA[p01 + 1] * w01 + srcRGBA[p11 + 1] * w11;
          const cb = srcRGBA[p00 + 2] * w00 + srcRGBA[p10 + 2] * w10 + srcRGBA[p01 + 2] * w01 + srcRGBA[p11 + 2] * w11;
          if (a >= 254.5) { r = cr; g = cg; b = cb; } else {
            const k = a / 255;
            r = cr * k + 255 * (1 - k); g = cg * k + 255 * (1 - k); b = cb * k + 255 * (1 - k);
          }
        }
      }
      dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = 255;
    }
  }
  return dst;
}

/**
 * الطريق المختصر: الشكل الرباعي quad في صورةٍ sw × sh ⇒ مستطيل dw × dh. null إن كان الشكل غير صالح (غير محدّب أو منفرد).
 */
export function warpQuadToRect(
  srcRGBA: Uint8ClampedArray, sw: number, sh: number, quad: Quad, dw: number, dh: number, out?: Uint8ClampedArray,
): Uint8ClampedArray | null {
  if (!isConvexQuad(quad)) return null;
  const H = solveHomography(rectQuad(dw, dh), quad);
  return H ? warpToRect(srcRGBA, sw, sh, H, dw, dh, out) : null;
}
