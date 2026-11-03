/**
 * BASELINE GOLDEN (3 Nov 2026, before the print-layouts / print-texts "delete line" work): pins TODAY's exact printer bytes.
 *
 * The browser half of the Bluetooth path (html2canvas capture, canvas page-number strip) cannot run in node, so this file pins
 * everything after it, end to end and per paper profile, from a deterministic sheet:
 *   monoFromRgba (fixed threshold) -> applyQrSlots (QR redrawn from QRCode.create at whole dots, phase-1 'M' and stamped 'L') ->
 *   paginate (12 mm blank-row search, QR rows kept whole, page-label strip) -> encodeForProfile ->
 *   ESC/POS (GS v 0, thermal rolls and roll_a4 sheets), TSPL (label printers) or ESC/P 24-pin (MIP480 impact, cut and
 *   continuous forms, quality/draft, offsets) -> bytes, safe cancel marks, cancel command and encoder kind.
 * Each case stores sha256 + length of the byte stream, sha256 of the marks, the cancel bytes, the page count and a sha256 per
 * page bitmap. The page-number strip is a deterministic stand-in for textStrip (canvas), same height as pageLabelRows.
 *
 * Calibration pages (lib/print/calibration.ts buildCalibrationDocument, system + raster mode) are pinned here too for every
 * thermal and impact preset, because they are the HTML that the raster path captures for test prints.
 *
 * Fixture: ./__baseline__/raster-bytes.json. Regenerate ONLY with BASELINE_WRITE=1 and only by the author of this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {
  PAGE_CUT_SEARCH_MM, applyQrSlots, createBitmap, fillRect, monoFromRgba, pageLabelRows, paginate, stackRows,
  type Bitmap, type QrSlotRef,
} from './raster';
import {
  defaultPrintOptions, dotsPerMm, geometry, presetPaper, qrDotsPerCell,
  type PaperPresetId, type PrintOptions, type PrintProfile, type PrinterDpi, type PrinterType, type TemplateId,
} from './printSettings';
import { buildCalibrationDocument } from './calibration';
import { encodeForProfile } from '../../rep/printDirect';

const WRITE = process.env.BASELINE_WRITE === '1';
const DIR = fileURLToPath(new URL('./__baseline__/', import.meta.url));
const FIXTURE = path.join(DIR, 'raster-bytes.json');

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const hex = (a: readonly number[]): string => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const bmSha = (b: Bitmap): string => sha(Buffer.concat([Buffer.from(`${b.width}x${b.height}:`), Buffer.from(b.data)]));

/** fixed-seed LCG — same numbers on every run */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

/** a document-like sheet: text lines of ink, short and long blank gaps, a dotted rule — via RGBA so the threshold is pinned too */
function sheet(width: number, height: number, seed: number): Bitmap {
  const r = rng(seed);
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x0: number, y0: number, w: number, h: number, v: number) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) {
        const i = (y * width + x) * 4;
        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v;
      }
    }
  };
  let y = 8 + Math.floor(r() * 24);
  while (y < height) {
    const lineH = 4 + Math.floor(r() * 26);
    // grey levels on both sides of the 160 threshold (light greys vanish, dark greys print)
    for (let k = 0; k < 7; k++) paint(Math.floor(r() * width), y, 2 + Math.floor(r() * (width / 4)), lineH, Math.floor(r() * 220));
    if (r() < 0.15) for (let x = 0; x < width; x += 6) paint(x, y + lineH + 2, 3, 1, 0);
    y += lineH + (r() < 0.25 ? 30 + Math.floor(r() * 200) : 3 + Math.floor(r() * 14));
  }
  return monoFromRgba(rgba, width, height);
}

/** stand-in for raster.textStrip (canvas): deterministic marks that encode n and m, same geometry as the real label rows */
function labelStrip(width: number, dpi: PrinterDpi, n: number, m: number): Bitmap {
  const rows = pageLabelRows(dpi);
  const strip = createBitmap(width, rows.text);
  const cx = Math.floor(width / 2);
  for (let k = 0; k < n; k++) fillRect(strip, cx - 40 + k * 6, 2, 4, Math.max(1, rows.text - 4), true);
  for (let k = 0; k < m; k++) fillRect(strip, cx + 10 + k * 6, 2, 4, Math.max(1, rows.text - 4), true);
  return stackRows(createBitmap(width, rows.gap), strip);
}

/** phase-1 style TLV payload (ec M) and a stamped-length payload (ec L) — values pinned as they would arrive in data-qr-value */
const PHASE1_VALUE = 'AQ7YtNix2YPYqSDYp9mE2KfYrtiq2KjYp9ixAg8zMDAwMDAwMDAwMDAwMDMDEzIwMjYtMTAtMjNUMTA6MzA6MDBaBAYxMzcuMDUFBTE3Ljg3';
const STAMPED_VALUE = 'AQ' + 'Zm'.repeat(150) + 'x'.repeat(398);

interface Case { profile: PrintProfile; copies: 1 | 2; device?: { lang?: 'tspl'; tsplFlip?: boolean }; pagesWanted: number }

function prof(printer: PrinterType, template: TemplateId, preset: PaperPresetId, o?: Partial<PrintOptions>, paper?: Partial<PrintProfile['paper']>): PrintProfile {
  return {
    id: 'p-1', name: 'p', printer, template,
    paper: { ...(presetPaper(preset) as PrintProfile['paper']), ...paper },
    options: { ...defaultPrintOptions(printer), ...o },
  };
}

const CASES: Record<string, Case> = {
  // thermal rolls: ESC/POS GS v 0 (roll_compact and roll_detailed share the encoder — the bitmap is what differs)
  'escpos.roll58': { profile: prof('thermal', 'roll_compact', 'roll58'), copies: 1, pagesWanted: 1 },
  'escpos.roll80': { profile: prof('thermal', 'roll_compact', 'roll80'), copies: 1, pagesWanted: 1 },
  'escpos.roll82': { profile: prof('thermal', 'roll_detailed', 'roll82'), copies: 1, pagesWanted: 1 },
  'escpos.roll85': { profile: prof('thermal', 'roll_detailed', 'roll85'), copies: 1, pagesWanted: 1 },
  'escpos.roll112': { profile: prof('thermal', 'roll_detailed', 'roll112'), copies: 1, pagesWanted: 1 },
  'escpos.roll80.cut.copies2': { profile: prof('thermal', 'roll_compact', 'roll80', { cutAfter: true, copies: 2, copyLabels: true }), copies: 2, pagesWanted: 1 },
  'escpos.roll80.offset.large': { profile: prof('thermal', 'roll_compact', 'roll80', { qrSize: 'large' }, { offsetXmm: 2 }), copies: 1, pagesWanted: 1 },
  'escpos.roll58.large': { profile: prof('thermal', 'roll_compact', 'roll58', { qrSize: 'large' }), copies: 1, pagesWanted: 1 },
  'escpos.roll_a4.sheet': { profile: prof('thermal', 'roll_detailed', 'roll_a4'), copies: 1, pagesWanted: 3 },
  'escpos.roll_a4.sheet.cut': { profile: prof('thermal', 'roll_detailed', 'roll_a4', { cutAfter: true }), copies: 2, pagesWanted: 2 },
  // label printers (TSPL), roll only
  'tspl.roll58': { profile: prof('thermal', 'roll_compact', 'roll58'), copies: 1, device: { lang: 'tspl' }, pagesWanted: 1 },
  'tspl.roll80': { profile: prof('thermal', 'roll_compact', 'roll80'), copies: 1, device: { lang: 'tspl' }, pagesWanted: 1 },
  'tspl.roll80.flip.copies2': { profile: prof('thermal', 'roll_compact', 'roll80', {}, { offsetXmm: 1 }), copies: 2, device: { lang: 'tspl', tsplFlip: true }, pagesWanted: 1 },
  // TSPL asked on a sheet stays on ESC/POS (pinned as today)
  'tspl.roll_a4.fallsBackToEscpos': { profile: prof('thermal', 'roll_compact', 'roll_a4'), copies: 1, device: { lang: 'tspl' }, pagesWanted: 2 },
  // MIP480 impact: ESC/P 24-pin, cut sheets and continuous forms
  'escp24.cut_a4': { profile: prof('impact', 'impact_plain', 'cut_a4'), copies: 1, pagesWanted: 2 },
  'escp24.cut_a4.draft.copies2': { profile: prof('impact', 'impact_plain', 'cut_a4', { graphicsQuality: 'draft' }), copies: 2, pagesWanted: 2 },
  'escp24.ff_a4': { profile: prof('impact', 'impact_preprinted', 'ff_a4'), copies: 1, pagesWanted: 3 },
  'escp24.ff_95x11': { profile: prof('impact', 'impact_plain', 'ff_95x11'), copies: 1, pagesWanted: 2 },
  'escp24.ff_95x11.offset.draft': { profile: prof('impact', 'impact_plain', 'ff_95x11', { graphicsQuality: 'draft' }, { offsetXmm: 5 }), copies: 1, pagesWanted: 2 },
  'escp24.ff_95x12.large': { profile: prof('impact', 'impact_plain', 'ff_95x12', { qrSize: 'large' }), copies: 1, pagesWanted: 2 },
  'escp24.ff_85x11': { profile: prof('impact', 'impact_preprinted', 'ff_85x11'), copies: 1, pagesWanted: 2 },
  'escp24.ff_95x55': { profile: prof('impact', 'impact_plain', 'ff_95x55'), copies: 1, pagesWanted: 3 },
  'escp24.cut_a4.margins': { profile: prof('impact', 'impact_plain', 'cut_a4', {}, { marginTopMm: 12, marginBottomMm: 8, offsetXmm: 3 }), copies: 1, pagesWanted: 2 },
};

/** one pipeline run, as rasterPages + send would do after the browser capture */
function runCase(name: string, c: Case): Record<string, unknown> {
  const p = c.profile;
  const dpi = p.paper.dpi as PrinterDpi;
  const width = p.paper.printableDots as number;
  const g = geometry(p);
  const height = g.rowsPerPage === null ? 1400 : Math.round(g.rowsPerPage * (c.pagesWanted - 0.4));
  const bm = sheet(width, height, 0x5eed + width);
  const want = qrDotsPerCell(dpi, p.options.qrSize);
  const slot = (value: string, ec: 'L' | 'M', top: number): QrSlotRef => {
    const cells = QRCode.create(value, { errorCorrectionLevel: ec }).modules.size;
    const side = Math.min(width, (cells + 4) * want);
    return { value, ec, rect: { x: Math.floor((width - side) / 2), y: Math.min(Math.max(0, height - side - 1), top), w: side, h: side } };
  };
  let qrRows: Array<[number, number]>;
  try {
    qrRows = applyQrSlots(bm, [slot(PHASE1_VALUE, 'M', Math.round(height * 0.12)), slot(STAMPED_VALUE, 'L', Math.round(height * 0.55))], { dpi, size: p.options.qrSize });
  } catch (e) {
    return { error: `${(e as Error).name}: ${(e as Error).message}` };
  }
  const rows = g.feed === 'roll' ? null : g.rowsPerPage;
  const pages = paginate(bm, qrRows, rows, Math.round(PAGE_CUT_SEARCH_MM * dotsPerMm(dpi)), (n, m) => labelStrip(width, dpi, n, m));
  const copies = Array.from({ length: c.copies }, () => pages);
  const { job, cancel, kind } = encodeForProfile(p, copies, c.device ?? {});
  assert.ok(job.marks.every((m, i) => m > 0 && m <= job.bytes.length && (i === 0 || m > job.marks[i - 1])), `${name}: marks ascending inside the stream`);
  return {
    kind,
    bytes: { sha: sha(job.bytes), len: job.bytes.length },
    marks: { sha: sha(JSON.stringify(job.marks)), count: job.marks.length },
    cancel: hex([...cancel]),
    source: bmSha(bm),
    qrRows,
    pages: pages.map((pg) => ({ bitmap: bmSha(pg.bitmap), h: pg.bitmap.height, qrRows: pg.qrRows })),
  };
}

const tr = (s: string) => s;
const CAL_PRESETS: Array<[PrinterType, TemplateId, PaperPresetId]> = [
  ['thermal', 'roll_compact', 'roll58'], ['thermal', 'roll_compact', 'roll80'], ['thermal', 'roll_detailed', 'roll82'],
  ['thermal', 'roll_detailed', 'roll85'], ['thermal', 'roll_detailed', 'roll112'], ['thermal', 'roll_detailed', 'roll_a4'],
  ['impact', 'impact_plain', 'cut_a4'], ['impact', 'impact_plain', 'ff_a4'], ['impact', 'impact_plain', 'ff_95x11'],
  ['impact', 'impact_preprinted', 'ff_95x12'], ['impact', 'impact_plain', 'ff_85x11'], ['impact', 'impact_plain', 'ff_95x55'],
];

function computeAll(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(CASES)) out[`bytes|${name}`] = runCase(name, c);
  for (const [printer, template, preset] of CAL_PRESETS) {
    for (const qrSize of ['auto', 'large'] as const) {
      const p = prof(printer, template, preset, { qrSize });
      for (const mode of ['system', 'raster'] as const) {
        const html = buildCalibrationDocument(p, tr, { mode, name: 'قالب السيارة' });
        out[`calibration|${preset}|${template}|${qrSize}|${mode}`] = { sha: sha(html), len: html.length };
      }
    }
  }
  // the fixed threshold itself: a 256-level ramp
  const ramp = new Uint8ClampedArray(256 * 2 * 4);
  for (let i = 0; i < 512; i++) { const v = i % 256; ramp[i * 4] = v; ramp[i * 4 + 1] = (v * 7) % 256; ramp[i * 4 + 2] = 255 - v; ramp[i * 4 + 3] = 255; }
  out['mono|ramp'] = bmSha(monoFromRgba(ramp, 256, 2));
  return out;
}

test('BASELINE bytes: ESC/POS, TSPL and ESC/P 24-pin streams, pagination, QR redraw and calibration pages are exactly as today', () => {
  const got = computeAll();
  const errors = Object.entries(got).filter(([, v]) => typeof v === 'object' && v !== null && 'error' in v).map(([k]) => k);
  assert.deepEqual(errors, [], 'every pinned pipeline case prints today');
  if (WRITE) {
    fs.mkdirSync(DIR, { recursive: true });
    const lines = Object.entries(got).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    fs.writeFileSync(FIXTURE, `{\n${lines.join(',\n')}\n}\n`);
    console.log(`BASELINE_WRITE: wrote ${lines.length} byte/calibration cases`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(got).sort(), Object.keys(expected).sort(), 'case set changed');
  const bad = Object.keys(got).filter((k) => JSON.stringify(got[k]) !== JSON.stringify(expected[k]));
  for (const k of bad.slice(0, 3)) console.error(`changed ${k}\n expected ${JSON.stringify(expected[k])}\n got      ${JSON.stringify(got[k])}`);
  assert.deepEqual(bad, [], `${bad.length} byte baseline case(s) changed`);
  // the matrix really spans the three encoders and multi-page sheets
  const kinds = new Set(Object.values(expected).map((v) => (v as { kind?: string }).kind).filter(Boolean));
  assert.deepEqual([...kinds].sort(), ['escp24', 'escpos', 'tspl']);
  assert.ok(Object.values(expected).some((v) => ((v as { pages?: unknown[] }).pages?.length ?? 0) >= 3), 'a 3-page sheet is pinned');
});
