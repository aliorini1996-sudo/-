/**
 * وضع الدفاتر داخل محرّك الدفاتر («ربط الدفاتر» L0) — إعادة تصدير services/booksMode.ts (المصدر الوحيد).
 * لا مقارنة حرفية بـsetupMethod === 'CLEAN' في services/gl: استعمل isManualBooks/isLinked/bookMode.
 */
export {
  bookMode, isManualBooks, isLinked, isLinkedMode, postsFromOperations, tenantBookMode, tenantBooksLinked,
  SETUP_METHODS, LINKED_NO_DELETE_CODE, LINKED_NO_DELETE_MESSAGE,
  type BookMode, type BookModeSettings, type BookModeDb, type SetupMethodValue,
} from '../booksMode';
