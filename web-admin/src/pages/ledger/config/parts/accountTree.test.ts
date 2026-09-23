import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountDescriptionText, treeNodeLabel, treeNodeName } from './accountTree';

test('م‑7: اسم عقدة الشجرة بلغة الواجهة ثم العربية ثم أول لغة فيها نص', () => {
  const names = { ar: 'مصروفات التوزيع والنقل', en: 'Distribution Expenses' };
  assert.equal(treeNodeName(names, 'ar'), 'مصروفات التوزيع والنقل');
  assert.equal(treeNodeName(names, 'en'), 'Distribution Expenses');
  // لغة بلا ترجمة ترتدّ إلى العربية لا إلى الفراغ
  assert.equal(treeNodeName(names, 'zh'), 'مصروفات التوزيع والنقل');
  assert.equal(treeNodeName({ fr: 'Charges de distribution' }, 'tr'), 'Charges de distribution');
  assert.equal(treeNodeName({ ar: '  مبعثر  ' }, 'ar'), 'مبعثر');
});

test('م‑7: الارتداد إلى الرمز وحده حين لا اسم', () => {
  assert.equal(treeNodeName(undefined, 'ar'), '');
  assert.equal(treeNodeName(null, 'ar'), '');
  assert.equal(treeNodeName({}, 'ar'), '');
  assert.equal(treeNodeName({ ar: '   ' }, 'ar'), '');
  // نصّ فارغ في لغة الواجهة لا يحجب العربية
  assert.equal(treeNodeName({ ar: 'الأصول', en: '' }, 'en'), 'الأصول');
  assert.equal(treeNodeLabel('611', treeNodeName(undefined, 'ar')), '611');
  assert.equal(treeNodeLabel('611', 'مصروفات التوزيع'), '611 مصروفات التوزيع');
  assert.equal(treeNodeLabel('61', '  '), '61');
});

test('م‑5: وصف الحساب يُطوى سطراً واحداً للخلية والتلميح', () => {
  assert.equal(accountDescriptionText('بنزين وسولار\nوزيوت سيارات  التوزيع'), 'بنزين وسولار وزيوت سيارات التوزيع');
  assert.equal(accountDescriptionText('   '), '');
  assert.equal(accountDescriptionText(null), '');
  assert.equal(accountDescriptionText(undefined), '');
});
