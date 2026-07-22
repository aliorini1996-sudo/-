// تصدير بيانات إلى ملف Excel (.xlsx) — تحميل ديناميكي لمكتبة xlsx لتقليل حجم الحزمة

export interface ExcelSheet {
  name: string;                       // اسم الورقة (حد 31 حرفاً)
  rows: Record<string, unknown>[];    // الصفوف ككائنات (المفاتيح = عناوين الأعمدة)
  colWidths?: number[];               // عرض الأعمدة (اختياري)
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function buildBlob(sheets: ExcelSheet[]): Promise<Blob> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ ' ': 'لا توجد بيانات' }]);
    if (s.colWidths) ws['!cols'] = s.colWidths.map(w => ({ wch: w }));
    // اتجاه الورقة من اليمين لليسار (مناسب للعربية)
    (ws as unknown as { '!views'?: unknown[] })['!views'] = [{ RTL: true }];
    // اجعل خلايا الروابط (http…) قابلة للنقر داخل Excel
    const ref = (ws as Record<string, unknown>)['!ref'] as string | undefined;
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      for (let R = range.s.r; R <= range.e.r; R++) {
        for (let C = range.s.c; C <= range.e.c; C++) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          const cell = (ws as Record<string, { v?: unknown; l?: unknown }>)[addr];
          if (cell && typeof cell.v === 'string' && /^https?:\/\/\S+$/.test(cell.v)) {
            cell.l = { Target: cell.v, Tooltip: 'فتح الموقع' };
          }
        }
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: XLSX_MIME });
}

const withExt = (name: string) => (name.endsWith('.xlsx') ? name : `${name}.xlsx`);

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = withExt(filename);
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// تنزيل مباشر
export async function exportExcel(sheets: ExcelSheet[], filename: string): Promise<void> {
  downloadBlob(await buildBlob(sheets), filename);
}

// مشاركة الملف (عبر زر مشاركة الجوال) أو تنزيله إن لم تتوفّر المشاركة
export async function shareOrDownloadExcel(sheets: ExcelSheet[], filename: string): Promise<'shared' | 'downloaded'> {
  const blob = await buildBlob(sheets);
  const file = new File([blob], withExt(filename), { type: XLSX_MIME });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename } as ShareData); return 'shared'; }
    catch { /* ألغى المستخدم */ }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

// تنسيق رقم لخليّة Excel (رقم فعلي وليس نصاً)
export function num(n: number | string | null | undefined): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}
