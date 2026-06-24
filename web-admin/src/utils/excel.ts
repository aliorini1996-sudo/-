// تصدير بيانات إلى ملف Excel (.xlsx) — تحميل ديناميكي لمكتبة xlsx لتقليل حجم الحزمة

export interface ExcelSheet {
  name: string;                       // اسم الورقة (حد 31 حرفاً)
  rows: Record<string, unknown>[];    // الصفوف ككائنات (المفاتيح = عناوين الأعمدة)
  colWidths?: number[];               // عرض الأعمدة (اختياري)
}

export async function exportExcel(sheets: ExcelSheet[], filename: string): Promise<void> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ ' ': 'لا توجد بيانات' }]);
    if (s.colWidths) ws['!cols'] = s.colWidths.map(w => ({ wch: w }));
    // اتجاه الورقة من اليمين لليسار (مناسب للعربية)
    (ws as unknown as { '!views'?: unknown[] })['!views'] = [{ RTL: true }];
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

// تنسيق رقم لخليّة Excel (رقم فعلي وليس نصاً)
export function num(n: number | string | null | undefined): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}
