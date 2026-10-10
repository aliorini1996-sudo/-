/**
 * مفاتيح تكامل ERP مشفّرة في القاعدة (AES-GCM بمفتاح ZATCA_SECRETS_KEY نفسه، غرضٌ مستقلّ مربوطٌ بالشركة) — كانت
 * نصاً صريحاً. القيمة القديمة غير المشفّرة تُقرأ كما هي وتُشفَّر عند أول حفظ. وبيئةٌ بلا مفتاح (تطوير) تحفظ صريحاً.
 */
import { SECRET_FORMAT_VERSION, SecretsError, decryptSecret, encryptSecret, keyringFromEnv } from '../compliance/zatca/secrets';

const PURPOSE = 'erp-credential' as const;

function keyring() {
  try {
    return keyringFromEnv(process.env);
  } catch (e) {
    if (e instanceof SecretsError && e.code === 'KEY_MISSING') return null;
    throw e;
  }
}

/** للحفظ: مشفّراً إن وُجد مفتاح البيئة */
export function sealErpSecret(tenantId: string, plain: string): string {
  const kr = keyring();
  return kr ? encryptSecret(plain, { purpose: PURPOSE, ownerId: tenantId }, kr) : plain;
}

/** للاستعمال: يفكّ المشفّر، ويعيد القديم الصريح كما هو */
export function openErpSecret(tenantId: string, stored: string | null | undefined): string {
  if (!stored) return '';
  if (!stored.startsWith(`${SECRET_FORMAT_VERSION}:`)) return stored;
  const kr = keyring();
  if (!kr) throw new Error('مفتاح فكّ أسرار ERP غير مضبوط على الخادم');
  return decryptSecret(stored, { purpose: PURPOSE, ownerId: tenantId }, kr);
}
