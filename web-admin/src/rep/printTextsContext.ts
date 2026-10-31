/**
 * «نصوص المطبوعات» — سياقا القوالب (rep/RepDocuments.tsx):
 *
 * - PrintTextsPreviewContext: محرّر النصوص في «إعدادات الشركة» يلفّ به معاينة الفاتورة والسند — فيُرسم كل نصٍّ في القائمة
 *   قابلاً للنقر (data-pt-key) والمخفيُّ باهتاً مشطوباً لا غائباً. خارجه (كل طباعة حقيقية) null فلا يتغيّر شيء.
 * - DocTextsContext: محلِّل نصوص المستند الذي تبنيه الفاتورة/السند لنفسها، فتقرأ منه الترويسة وصندوق فواتير السند —
 *   وبقية المستندات (الكشف والإشعارات) لا توفّره فتطبع ترويستها كاليوم.
 */
import { createContext, useContext } from 'react';
import type { PrintTexts, PrintTextsPreview } from '../lib/print/printTexts';

export const PrintTextsPreviewContext = createContext<PrintTextsPreview | null>(null);
export const usePrintTextsPreview = (): PrintTextsPreview | null => useContext(PrintTextsPreviewContext);

export const DocTextsContext = createContext<PrintTexts | null>(null);
export const useDocTexts = (): PrintTexts | null => useContext(DocTextsContext);
