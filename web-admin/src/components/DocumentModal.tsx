import { DocumentResult, AnyDoc } from '../rep/RepDocuments';

// يعرض مستند PDF (فاتورة/سند/كشف حساب) بنفس شكل المندوب داخل نافذة في لوحة التحكم
export default function DocumentModal({ doc, onClose }: { doc: AnyDoc; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-3xl overflow-hidden shadow-2xl" style={{ width: 400, height: '88vh', maxHeight: 840 }}>
        <DocumentResult doc={doc} onClose={onClose} />
      </div>
    </div>
  );
}
