/**
 * «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦) — سياق معاينة المصمّم لقوالب الصفحة (A4/النقطية).
 *
 * المصمّم (components/print/designer) يلفّ معاينة الفاتورة/السند الحقيقية بـPrintDesignPreviewContext، فتحمل كل كتلةٍ
 * قابلةٍ للتحديد وسمَ data-pd="<DesignSel>" (قسمٌ، أو الشعار، أو مربعٌ box:<id>، أو لوحة band:header|band:footer).
 * خارج المصمّم — أي طباعةٍ حقيقية أو PDF أو نقطية — السياق null فلا وسم ولا معالج: الورقة كما تُطبع حرفياً.
 */
import { createContext, useContext } from 'react';
import type { DesignSel } from '../lib/print/designModel';

export interface PrintDesignPreview {
  /** المحدَّد الآن في المصمّم (يُبرَز) — null = لا شيء */
  active: DesignSel | null;
  /** نقرةٌ على كتلةٍ في المعاينة تختارها */
  onPick?(sel: DesignSel): void;
}

export const PrintDesignPreviewContext = createContext<PrintDesignPreview | null>(null);
export const usePrintDesignPreview = (): PrintDesignPreview | null => useContext(PrintDesignPreviewContext);

/** وسم الكتلة في المعاينة: {} بلا سياق (كل طباعة حقيقية)، وإلا data-pd (+ data-pd-active للمحدَّد) */
export function pdAttrs(ctx: PrintDesignPreview | null, sel: DesignSel): Record<string, string> {
  if (!ctx) return {};
  return ctx.active === sel ? { 'data-pd': sel, 'data-pd-active': '' } : { 'data-pd': sel };
}

/**
 * كـpdAttrs ومعه نقرةٌ تختار الكتلة (onPick) دون أن تصعد إلى الكتلة الأب. بلا سياق: {} — لا معالج في أي طباعة.
 * (renderToStaticMarkup لا يرسم المعالجات، فالوسم المرسوم يساوي pdAttrs.)
 */
export function pdProps(ctx: PrintDesignPreview | null, sel: DesignSel): Record<string, unknown> {
  if (!ctx) return {};
  const attrs: Record<string, unknown> = pdAttrs(ctx, sel);
  const pick = ctx.onPick;
  if (pick) attrs.onClick = (e: { stopPropagation?: () => void }) => { e.stopPropagation?.(); pick(sel); };
  return attrs;
}
