// «ربط الدفاتر» L4 — A3: مصفوفة builder فواتير المبيعات (عقد L4+L5+L8 §4.2 و§7 E4.1–E4.11 و§8 A3).
//
// الأبعاد: نوع المستند (نقدي مختوم/غير مختوم، آجل، آجل بأقساط، مرتجع مرتبط، مرتجع حرّ، إشعار دائن) × وضع الضريبة
// (خاضع 15٪، «إزالة الضريبة» ومعه B6، صفري، معفى) × منازل العملة (0، 2، 3) × pricesIncludeTax × ملفّا إعدادات.
// - ذهبي: بلا linkedPosting يطابق مخرج builder ما قبل L4 **بايتاً** (بصمات sha256 لتسلسل القيد بترتيب مفاتيحه، التُقطت
//   من شجرة الأساس eea1e69 قبل أي تعديل) — والحمولة تحمل الحقول الجديدة كلها فيثبت أنّ غير المربوطة تتجاهلها.
// - المربوطة: Σمدين = Σدائن، الذمة = total (وΣ الأقساط)، Σ الإيراد = subtotal (أو الصافي بلا فصل الخصم)، الضريبة لكل
//   مربع = Σ taxAmt، لا 911001، وproductId وquantity على سطور الإيراد.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInvoiceMove, invertInvoiceDraft, invoicePayloadFromRows,
  type InvoicePayload, type InvoicePayloadItem,
} from '../services/gl/builders/invoice';
import { reversalDraftFromRecord } from '../services/gl/reverse';
import { isNoMove, type BuildContext, type BuildResult, type GlSettingsSnapshot, type LineDraft, type MoveDraft } from '../services/gl/types';
import { resolveLineAccount, validateMove } from '../services/gl/validate';
import { toMilli } from '../services/gl/money';
import { genericContext, saContext, taxIdOf } from '../services/gl/testing/fixtures';
import { computeInvoiceTotals } from '../lib/invoiceCalc';
import { postCashInvoiceEntries, postInvoiceEntries, postReturnEntries } from '../services/accounting';
import {
  contextFor, digest, matrixCases, profileOverrides, REVERSE_DATE_OTHER_PERIOD, REVERSE_DATE_SAME_PERIOD,
  type MatrixCase,
} from './l458-a03-fixtures';
import { goldenRecords } from './l458-a03-records';

// ═══ اللقطة الذهبية (مخرج ما قبل L4) ═══

/** بصمات مخرج builder ما قبل L4 لكل خانة × متغيّر (POST، REVERSE، REVERSE_KEEP_CASH للنقدية) بترتيب matrixCases() */
const GOLDEN_MATRIX: readonly string[] = `
  26bc8cc2ef44 4cb3cbffe437 216aef4523fd f693cfadc628 19c618e8b3db ce060b89c0f1 040eef5eacd1 bc1658a65c91 0bd6a8855a46 c5c1558293b4
  12eb66ce341d 6d7be413177d 3f8722f79633 252b9ae95378 353fb5d20656 d7a95fc87dd1 6adf91aa1145 04913e8e4d3f 00795f257b3d 66f63bf98e03
  5d3ed9697926 00795f257b3d 66f63bf98e03 5d3ed9697926 fd5b792fffc9 e0331f4bd70e 0ca911b95d04 fd5b792fffc9 e0331f4bd70e 0ca911b95d04
  f38684e7d215 8add64532967 9ab39507f536 f38684e7d215 8add64532967 9ab39507f536 7399e72eb33f 755e6a2b06eb 0085c4dacd22 7399e72eb33f
  755e6a2b06eb 0085c4dacd22 eb700fc10fb9 c0ee7e0c2128 c67718bd0a5b eb700fc10fb9 c0ee7e0c2128 c67718bd0a5b f2e879e9da19 671bdb6f3a64
  9c661c622a22 f2e879e9da19 671bdb6f3a64 9c661c622a22 b7b4e27a2320 e1cf7452ad8e 2b167a94197e b7b4e27a2320 e1cf7452ad8e 2b167a94197e
  cb5c3451e30a 6ccf0d882054 83f7e94ac12a cb5c3451e30a 6ccf0d882054 83f7e94ac12a 7163e6da1768 d4d0c538e015 2b8a61caa2cd 7163e6da1768
  d4d0c538e015 2b8a61caa2cd 3aa106cb8d18 70ed8f2bed14 d424f563e742 7babf396a473 e5b008f2568f c01939a82292 7acf5bb17d03 3a650b841015
  7ba86f783415 91f3c039a125 0664bca26e00 965cc3374e99 ace796646450 312035eca0c1 8d1de37ff282 76f4fe08c450 8c7b4919df97 683736e93a6b
  3b8dc1d92d39 16fc2f43211c 6aa053ecad1b 3b8dc1d92d39 16fc2f43211c 6aa053ecad1b e2f0bb5e9944 d3237996c63f b0653db50858 e2f0bb5e9944
  d3237996c63f b0653db50858 3853f7fd0287 b7464d8ccd0e 776f296f5918 3853f7fd0287 b7464d8ccd0e 776f296f5918 5a59ea47556d 5679a3f451c9
  e92783b01899 5a59ea47556d 5679a3f451c9 e92783b01899 fbf826dd7820 38fa8a1d9ab5 6ac1ac4d8716 fbf826dd7820 38fa8a1d9ab5 6ac1ac4d8716
  fa6fb8d22bee e299116f38cb 7fe334b576d8 fa6fb8d22bee e299116f38cb 7fe334b576d8 4c86c1128535 e2c749378f6b af5622742005 4c86c1128535
  e2c749378f6b af5622742005 1b36c36a4403 54fac5419ee8 36bed8d140db 1b36c36a4403 54fac5419ee8 36bed8d140db 85a8b6e6e6a2 3ee0611bffc4
  c0e601978833 85a8b6e6e6a2 3ee0611bffc4 c0e601978833 09c5ffca2111 0b2e4fc021fa 89c64a8ea858 1f0327b64b59 4e26c360d7a4 3688fcb2ce8e
  917f0400a960 e79c062acdd8 56a068558c98 12521c9bc6d4 3595fca18c11 6af978403d6f c8457b92a5f9 07c6ae7bb114 c8457b92a5f9 07c6ae7bb114
  42d2109cb3f5 db706a7d4c84 42d2109cb3f5 db706a7d4c84 be41f856dfe3 528f6f3b10ba be41f856dfe3 528f6f3b10ba 27f6e13c87fb 941d4048b03d
  27f6e13c87fb 941d4048b03d 92fc2121424e 2051bdc33e20 92fc2121424e 2051bdc33e20 d674d4016cb2 b2e7da80eb5f d674d4016cb2 b2e7da80eb5f
  c618bc82c82c d9eb82b88e96 c618bc82c82c d9eb82b88e96 5df7b219c0e7 9d0c4570ea4f 5df7b219c0e7 9d0c4570ea4f bb7c22debe71 64b27ca674ce
  bb7c22debe71 64b27ca674ce 7ed860bcaafa 4544f1c522fb 5969fc048ab6 ee99ad71b9fb 76e3f4c16e26 7d72b775964a a65ce67e0a71 ea88ac6cc3b1
  56e58a226f84 3ef6015d0a6c c879b6289e55 518f20387e73 7fe507529964 be95a573dcf4 7fe507529964 be95a573dcf4 b9ba88e61594 d1712948944b
  b9ba88e61594 d1712948944b d8dd90f3c163 01751b9e0f29 d8dd90f3c163 01751b9e0f29 69193eda8d20 98031899cb15 69193eda8d20 98031899cb15
  2bdbd82499fb 5424ad883e68 2bdbd82499fb 5424ad883e68 29df0d29d155 7f6387bf97e2 29df0d29d155 7f6387bf97e2 59aa4974ef19 f61406a9ff21
  59aa4974ef19 f61406a9ff21 b2c3c90069c5 6ac0601eab08 b2c3c90069c5 6ac0601eab08 c79e69e0af25 d42498eda1ca c79e69e0af25 d42498eda1ca
  097cfa4ae8a8 ead88a6e8c2c b9b6a8220b49 94939e0418e3 868815145a1f f18ca1e66654 f2fa432cfeca 4109ad95f8dc f7c984aba6a3 3a76cf4b736a
  1619591e92cc a68018a4ae7e 097cfa4ae8a8 ead88a6e8c2c b9b6a8220b49 94939e0418e3 868815145a1f f18ca1e66654 f2fa432cfeca 4109ad95f8dc
  f7c984aba6a3 3a76cf4b736a 1619591e92cc a68018a4ae7e 9eb8249869b2 8a0a94c758c2 9eb8249869b2 8a0a94c758c2 6f277763280f 1b4955ca01a7
  6f277763280f 1b4955ca01a7 e02ceccae2d7 378aebf901db e02ceccae2d7 378aebf901db cb557a0b6954 1bc4a13a331d cb557a0b6954 1bc4a13a331d
  f0ae0b7cef4a 7446ff0cee7f f0ae0b7cef4a 7446ff0cee7f 92cc031355dd cd6ffef72f57 92cc031355dd cd6ffef72f57 1e1859ad3e24 de29ee27773d
  81238f74dfae 4f6ed7882b45 6702d3d90523 9558b1ca3567 89c66db3444b 54c94ed74caa d6cf5f1e4996 f715099a8fc5 81c7644a0414 98cd51f0bf4f
  a84cb6b0d8f5 3de54e02af47 a84cb6b0d8f5 3de54e02af47 41c41244f166 21254b0fd6d0 41c41244f166 21254b0fd6d0 3d4aaaa89b68 4865d6a41666
  3d4aaaa89b68 4865d6a41666 df918154d9e0 e47dc715c081 df918154d9e0 e47dc715c081 001f6a71fbf1 99762fa56001 001f6a71fbf1 99762fa56001
  f5e084567ee9 50365d323a79 f5e084567ee9 50365d323a79 1229cd02b0c9 35515d7e90bb 1229cd02b0c9 35515d7e90bb 804759490aed af8ce39fc5b5
  804759490aed af8ce39fc5b5 282c458e0dea 6a55001bbaa9 282c458e0dea 6a55001bbaa9 b369d961832c 43c9247f7471 ad3737c72394 6c44c9f31ad8
  13aaef9de481 04c223b7b534 c8de50aab1ae dee48ef7a9bb d7a0db39eac2 54124451316c 6c0d92b04b6f bb1ecb766139 92e458f6bbe2 37e9aa3a0b91
  92e458f6bbe2 37e9aa3a0b91 2fb82fe7139f fedb4dc7a3cc 2fb82fe7139f fedb4dc7a3cc cbb188c397cd 026a01760c75 cbb188c397cd 026a01760c75
  5e2828d86d05 992c7e788d81 5e2828d86d05 992c7e788d81 8cdda24abaa1 09a012a7f22f 8cdda24abaa1 09a012a7f22f 08b37824a321 b9a5b8bd434f
  08b37824a321 b9a5b8bd434f 5ae4a9ce18ef 4f139b2316ab 5ae4a9ce18ef 4f139b2316ab 226fd7b24c1d 31084a9b090b 226fd7b24c1d 31084a9b090b
  4b8a1c3690d9 2a009b9d8b98 4b8a1c3690d9 2a009b9d8b98 bc6183f713c4 0433e4836a13 ad7808a7e6d6 663fc3717d43 3fc59d7dbc52 4ca30bb1fc8a
  2c256b74e579 e2e6afeab53c 008106536312 18d857ea23c2 e879e685d641 b78b13eee3c2 d2b46b1ccbd8 0ebff89604c9 4d5de3646cb1 2f7a6fc95554
  c25964e39a64 3a8e7461f303 b1755117c418 df17100a0e7c dcc90454da98 b1755117c418 df17100a0e7c dcc90454da98 7f6b5f1576d1 ef7b5f1171fd
  119137ed5626 7f6b5f1576d1 ef7b5f1171fd 119137ed5626 ace8397eba14 21157296be91 48ad9f3b5df4 ace8397eba14 21157296be91 48ad9f3b5df4
  53ff9c50ea4d 57587096ad32 682886ac059e 53ff9c50ea4d 57587096ad32 682886ac059e e7ac55d97250 68a106aa42cc 5752f4bbb337 e7ac55d97250
  68a106aa42cc 5752f4bbb337 b532a4cf06e1 4f5e12f3b72e e107dbaee7be b532a4cf06e1 4f5e12f3b72e e107dbaee7be ae92cf9c07d8 92b235c3e821
  cd850529c287 ae92cf9c07d8 92b235c3e821 cd850529c287 a87dd0359eaa 8f776b30e515 e6c9b3b1bc3e a87dd0359eaa 8f776b30e515 e6c9b3b1bc3e
  621a56800808 873312f9c02f ef927369a53c 621a56800808 873312f9c02f ef927369a53c 9736d2905821 96e74e033362 0b0f12a1d3e4 43d670b2495d
  4acc7dca8932 318e41e0c20a e29fe19af1eb dbe929bea354 a6f9ac7bc97a a45b732c51ec d41616e7f044 9baaf1f4d5ea e403254188fa 1450c3f26c1c
  505bae1edd46 09510e6c9f58 3bd3b5ed6ed1 af286fbc2e4f 87c431866a53 2125b259c5f3 1f76caf4aa43 87c431866a53 2125b259c5f3 1f76caf4aa43
  b3db3a3406cc 1bf97f10be12 8ee32f795688 b3db3a3406cc 1bf97f10be12 8ee32f795688 9093a3aa6166 a0f6870c4ee8 ceba67365447 9093a3aa6166
  a0f6870c4ee8 ceba67365447 520267af5bfc ae7f7f8f1626 e8131b0dcdcd 520267af5bfc ae7f7f8f1626 e8131b0dcdcd a43938414e53 54f00bce3246
  d4eb824c6b05 a43938414e53 54f00bce3246 d4eb824c6b05 27e3fb8f47ad 6d274b864efe 7062af74a80a 27e3fb8f47ad 6d274b864efe 7062af74a80a
  27300add67f9 24aa0749a6d6 1a2c3adad965 27300add67f9 24aa0749a6d6 1a2c3adad965 df98ea1afb02 736eebb7428a e9b4b68fbdb0 df98ea1afb02
  736eebb7428a e9b4b68fbdb0 b093504c6de4 e95fee23cf54 feee6816c12d b093504c6de4 e95fee23cf54 feee6816c12d 599c2d2f7245 f5c5e49ab450
  1613336b825e 9b9069a13652 d34906ba517e 3c006f249a65 6d405ad36c7a 5bee30eed89a bbac7e30ff8e 6b5dab355c46 caddffcf9f28 6e5f9aedd283
  1e55f18ee1b5 07cbf376a5d6 1e55f18ee1b5 07cbf376a5d6 b459a5a816d9 d61f761ce5dc b459a5a816d9 d61f761ce5dc decaaae5eceb 992e592e77c4
  decaaae5eceb 992e592e77c4 142c5ccf1996 4ab852b50846 142c5ccf1996 4ab852b50846 3349cd5b6834 44da31f31de5 3349cd5b6834 44da31f31de5
  92bd6fcab63f 81556a1d046d 92bd6fcab63f 81556a1d046d 55711d016214 c81a7a5fcbf1 55711d016214 c81a7a5fcbf1 d80335d1534e 21e9138d0055
  d80335d1534e 21e9138d0055 b349531a1908 f651c1e14a94 b349531a1908 f651c1e14a94 15a5dcbd2c8c 6a29fac7f5f0 d3a4665433f7 149697cb8e74
  4dd48104c177 b97acdc3095c db5f0c3ad374 2c13a581f4fc 90e8de517d86 2714046705a4 b5c01925a0ab 4f124d3be6c4 d4659d877fa0 9cf974e88da3
  d4659d877fa0 9cf974e88da3 0d3d2c7694d7 af40c6eeab6d 0d3d2c7694d7 af40c6eeab6d 2904c6db5626 2472e1f0910d 2904c6db5626 2472e1f0910d
  a7953cf354b3 c5dcb491c484 a7953cf354b3 c5dcb491c484 15c289d9aa82 92cc4f6fa815 15c289d9aa82 92cc4f6fa815 f37349fa7e00 78b63212b361
  f37349fa7e00 78b63212b361 a39397cf304e 6da06b6fff98 a39397cf304e 6da06b6fff98 3770d6b02795 7a45380ef7a3 3770d6b02795 7a45380ef7a3
  0fcf61b35f19 52c54a4393ca 0fcf61b35f19 52c54a4393ca 5da154c9fbcf fc2401c2b7c1 2c769549c235 7414576aadff 293b2c1a6300 a328d980b13e
  de616e8b96cc b5eec9bdb609 18291b5a92d6 44d70b92453c 81d32d03b79b 96dcdf34455d 5da154c9fbcf fc2401c2b7c1 2c769549c235 7414576aadff
  293b2c1a6300 a328d980b13e de616e8b96cc b5eec9bdb609 18291b5a92d6 44d70b92453c 81d32d03b79b 96dcdf34455d 522e49e36c03 527fa3ed3a3f
  522e49e36c03 527fa3ed3a3f d5b9d9aa9f12 233bc562c965 d5b9d9aa9f12 233bc562c965 de51a6cdcac3 e99ff5d400e1 de51a6cdcac3 e99ff5d400e1
  185f8a0cd8f8 1c756a0116da 185f8a0cd8f8 1c756a0116da 0a26424f4c9e b31619ea1eb6 0a26424f4c9e b31619ea1eb6 e7d9f96d21bf 37bc488fab79
  e7d9f96d21bf 37bc488fab79 537a165dfa5a 490f75c9cb6a 325aaea99fc5 73b0c18c4756 e379df6e7bae 4e4bb9c755a4 cfac1103075f 6e7750734c58
  e6eef38a285c f75590f945af e0d7066c28ed 28b2ea60163a 05df0b764d9b 8e4ee259fc7c 05df0b764d9b 8e4ee259fc7c c2677ebed7c5 845c54cec583
  c2677ebed7c5 845c54cec583 9a274ba0427c e7dee847b5e2 9a274ba0427c e7dee847b5e2 95d0914fcf9d 6ec468007396 95d0914fcf9d 6ec468007396
  4f1fd7873745 3bd5d3f6daef 4f1fd7873745 3bd5d3f6daef 62d68ae8605e 7375f05f326f 62d68ae8605e 7375f05f326f 940bed7e4d8d 69c90ef0906a
  940bed7e4d8d 69c90ef0906a 8747591d2d97 4e4a980680b0 8747591d2d97 4e4a980680b0 c1491bd05321 6a45c9d00b18 c1491bd05321 6a45c9d00b18
  7fe6a6ca6d69 0239e84f1590 dc3cda46a298 2ca4d9749ac2 bfdb32f1bd86 0fba83f100df 057f06bd6331 d374cf3b1be0 137fda6d6168 6089a5c06fd4
  86f2ca0da8ca 2999516829c6 144dd51efa9e 6034219aebb4 144dd51efa9e 6034219aebb4 9547ec264f3c 554c7451986f 9547ec264f3c 554c7451986f
  f438ae9a91d8 e0d5be90cb53 f438ae9a91d8 e0d5be90cb53 ffbad8caefd1 e381424e726f ffbad8caefd1 e381424e726f 75fabb2bccdb d7f375faa6f4
  75fabb2bccdb d7f375faa6f4 646394a9cc9b a7b0f13c7028 646394a9cc9b a7b0f13c7028 2b5d924d42c1 b7575aaf4a37 2b5d924d42c1 b7575aaf4a37
  b9556e72b0ad a651b11989c6 b9556e72b0ad a651b11989c6 1633c665b983 3263a43a5f7e 1633c665b983 3263a43a5f7e
`.trim().split(/\s+/);

/** بصمات reversalDraftFromRecord ما قبل L4 (goldenRecords × تاريخان) */
const GOLDEN_REVERSALS: readonly string[] = '9fd310f02ce0 ad257f188d21 223bad645209 a35174919f56 90e73a10c8bd ed4961bbd495'.split(' ');

// ═══ أدوات ═══

const M = (x: number | string, dec = 2) => toMilli(x, dec);
const code = (l: LineDraft, ctx: BuildContext) => resolveLineAccount(l, ctx.accounts)?.code;
const on = (m: MoveDraft, ctx: BuildContext, ...codes: string[]) => m.lines.filter((l) => codes.includes(code(l, ctx) ?? ''));
const net = (ls: readonly LineDraft[]) => ls.reduce((a, l) => a + l.debitMilli - l.creditMilli, 0n);
const sumD = (ls: readonly LineDraft[]) => ls.reduce((a, l) => a + l.debitMilli, 0n);
const sumC = (ls: readonly LineDraft[]) => ls.reduce((a, l) => a + l.creditMilli, 0n);

function asMove(r: BuildResult): MoveDraft {
  assert.equal(r.kind, 'MOVE', 'المتوقع قيد لا NO_MOVE');
  return r as MoveDraft;
}

/** validate.ts كاملاً (I1–I7 وG6/G7) ثم Σمدين = Σدائن */
function checked(r: BuildResult, ctx: BuildContext, where = ''): MoveDraft {
  const m = asMove(r);
  const v = validateMove(m, ctx);
  assert.equal(v.totalDebitMilli, v.totalCreditMilli, `متّزن ${where}`);
  assert.equal(sumD(m.lines), sumC(m.lines), `Σمدين = Σدائن ${where}`);
  for (const l of m.lines) {
    assert.match(l.label, /[؀-ۿ]/, `وصف عربي ${where}`);
    if (l.customerId || l.salesRepId) assert.ok(l.partnerName && l.partnerName.trim() !== '', `partnerName ${where}`);
  }
  return m;
}

function linkedCtx(c: Pick<MatrixCase, 'dec' | 'profile'>, extra: Partial<GlSettingsSnapshot> = {}): BuildContext {
  return contextFor(c.dec, profileOverrides(c.profile, { linkedPosting: true, ...extra }));
}

const REVENUE_CODES = ['411001', '411002', '412001'];

// ═══ 1. الذهبي: غير المربوطة بايتاً كما كانت ═══

test('ذهبي: بلا linkedPosting — 768 بناءً (POST وREVERSE وREVERSE بلا ساق النقد) تطابق مخرج ما قبل L4 بايتاً', () => {
  let k = 0;
  const mismatches: string[] = [];
  for (const c of matrixCases()) {
    const ctx = contextFor(c.dec, profileOverrides(c.profile));
    assert.equal(ctx.settings.linkedPosting, undefined, 'السياق الافتراضي بلا linkedPosting');
    const variants: [string, BuildResult][] = [
      ['POST', buildInvoiceMove(c.payload, ctx)],
      ['REVERSE', buildInvoiceMove(c.payload, ctx, { event: 'REVERSE', reverseDate: REVERSE_DATE_OTHER_PERIOD })],
    ];
    if (c.payload.type === 'CASH') {
      variants.push(['REVERSE_KEEP_CASH', buildInvoiceMove(c.payload, ctx, { event: 'REVERSE', reverseDate: REVERSE_DATE_OTHER_PERIOD, keepCashLeg: true })]);
    }
    for (const [name, r] of variants) {
      if (digest(r) !== GOLDEN_MATRIX[k]) mismatches.push(`${c.name}/${name}`);
      k++;
    }
  }
  assert.equal(k, GOLDEN_MATRIX.length, 'عدد البناءات = عدد البصمات');
  assert.deepEqual(mismatches, [], 'لا خانة تغيّر مخرجها');
});

test('ذهبي: reversalDraftFromRecord بلا vatPeriod كما كان بايتاً (فاتورة، مرتجع، سند)', () => {
  const out: string[] = [];
  for (const r of goldenRecords()) {
    out.push(digest(reversalDraftFromRecord(r, { date: '2026-10-03', reason: 'إلغاء', originalNumber: 'INV/2026/09/0001', sourceKey: 'INVOICE:inv1:REVERSE', sourceEvent: 'REVERSE' })));
    out.push(digest(reversalDraftFromRecord(r, { date: '2026-09-30', reason: 'إلغاء' })));
  }
  assert.deepEqual(out, GOLDEN_REVERSALS);
});

test('المربوطة بلا أي حقل جديد وبنود بلا صنف = مخرج غير المربوطة حرفاً (POST آجل/نقدي غير مختوم/مرتجع)', () => {
  for (const c of matrixCases()) {
    if (c.doc !== 'CREDIT' && c.doc !== 'CASH_UNSTAMPED' && c.doc !== 'RETURN_FREE') continue;
    const bare: InvoicePayload = {
      ...c.payload, dueDateDerived: undefined, appliesTo: undefined, cashCollectedByRep: undefined, installments: undefined,
      items: c.payload.items.map((it) => ({ ...it, productId: null })),
    };
    const plain = buildInvoiceMove(bare, contextFor(c.dec, profileOverrides(c.profile)));
    const linked = buildInvoiceMove(bare, linkedCtx(c));
    assert.deepEqual(linked, plain, c.name);
  }
});

// ═══ 2. المصفوفة للمربوطة ═══

function assertLinkedCell(c: MatrixCase): void {
  const ctx = linkedCtx(c);
  const p = c.payload;
  const dec = c.dec;
  const where = c.name;
  const m = checked(buildInvoiceMove(p, ctx), ctx, where);
  const total = M(p.total, dec);
  const subtotal = M(p.subtotal, dec);
  const discountAmt = M(p.discountAmt, dec);
  const taxAmt = M(p.taxAmt, dec);
  const isReturn = p.type === 'RETURN';
  const separate = c.profile === 'A';

  assert.equal(m.needsAttention, false, `بلا تنبيه ${where}`);
  assert.equal(on(m, ctx, '911001').length, 0, `لا 911001 ${where}`);

  // ── الذمة = total ──
  const ar = on(m, ctx, '113001');
  if (isReturn) {
    assert.equal(sumC(ar), total, `ذمة المرتجع = total ${where}`);
    assert.equal(sumD(ar), 0n);
  } else {
    assert.equal(sumD(ar), total, `ذمة الفاتورة = total ${where}`);
    assert.equal(sumC(ar), p.type === 'CASH' ? total : 0n, `ساق النقد تقفل الذمة ${where}`);
    for (const l of ar) assert.equal(l.customerId, 'cust1');
  }
  if (c.doc === 'CREDIT_INSTALLMENTS') {
    const debits = ar.filter((l) => l.debitMilli > 0n);
    const sorted = [...(p.installments ?? [])].sort((a, b) => a.seq - b.seq);
    assert.equal(debits.length, 3, `سطر لكل قسط ${where}`);
    assert.deepEqual(debits.map((l) => l.dueDate), sorted.map((i) => i.dueDate), 'بترتيب seq واستحقاقه');
    assert.deepEqual(debits.map((l) => l.debitMilli), sorted.map((i) => M(i.amount, dec)), 'مبلغ كل قسط');
    assert.equal(sumD(debits), total, 'Σ الأقساط = total');
    debits.forEach((l, k) => assert.match(l.label, new RegExp(`قسط ${k + 1}$`)));
  } else if (p.type === 'CREDIT') {
    const debits = ar.filter((l) => l.debitMilli > 0n);
    assert.equal(debits.length, 1);
    assert.equal(debits[0].dueDate, '2026-10-28');
  }

  // ── ساق النقد (OD2) ──
  if (p.type === 'CASH') {
    const custody = on(m, ctx, '111003');
    const cash = on(m, ctx, '111001');
    const toCustody = c.doc === 'CASH_STAMPED' || c.profile === 'B';
    assert.equal(sumD(custody), toCustody ? total : 0n, `عهدة المندوب ${where}`);
    assert.equal(sumD(cash), toCustody ? 0n : total, `الصندوق ${where}`);
    if (toCustody) assert.equal(custody[0].salesRepId, 'rep1');
  } else {
    assert.equal(on(m, ctx, '111003', '111001').length, 0);
  }

  // ── الإيراد والخصم ──
  const revenue = on(m, ctx, ...REVENUE_CODES);
  const disc = on(m, ctx, '413001');
  const revNet = isReturn ? net(revenue) : -net(revenue);
  if (separate) {
    assert.equal(revNet, subtotal, `Σ الإيراد = subtotal ${where}`);
    assert.equal(isReturn ? -net(disc) : net(disc), discountAmt, `Σ الخصم = discountAmt ${where}`);
  } else {
    assert.equal(revNet, subtotal - discountAmt, `Σ الإيراد = الصافي بلا فصل ${where}`);
    assert.equal(disc.length, 0);
  }

  // ── (ج) الإيراد لكل صنف: productId وquantity (Σ baseQty) ──
  const byProduct = new Map<string | null, LineDraft[]>();
  for (const l of revenue) byProduct.set(l.productId ?? null, [...(byProduct.get(l.productId ?? null) ?? []), l]);
  assert.deepEqual([...byProduct.keys()].sort((a, b) => String(a).localeCompare(String(b))), ['null', 'pA', 'pB'].map((x) => (x === 'null' ? null : x)).sort((a, b) => String(a).localeCompare(String(b))), `مجموعة لكل صنف ${where}`);
  for (const l of revenue) {
    if (l.productId === 'pA') { assert.equal(l.quantity, 77, `كمية pA بالأساس ${where}`); assert.match(l.label, /عصير برتقال/); }
    else if (l.productId === 'pB') { assert.equal(l.quantity, 2); assert.match(l.label, /مياه معدنية/); }
    else { assert.equal(l.productId, undefined); assert.equal(l.quantity, undefined, 'بلا كمية للبنود الحرّة'); }
  }
  for (const l of disc) assert.ok(l.quantity === undefined, 'الكمية على الإيراد وحده');
  // الملف B: صنف الفئة إلى 411002 (للمرتجع أيضاً حين لا مردودات مستقلة)
  if (c.profile === 'B') assert.ok(revenue.filter((l) => l.productId === 'pA').every((l) => code(l, ctx) === '411002'), `فئة pA ${where}`);

  // ── الضريبة لكل مربع = Σ taxAmt ──
  const taxLines = m.lines.filter((l) => l.taxRole === 'TAX');
  const markers = m.lines.filter((l) => l.taxRole === 'MARKER');
  const itemTax = p.items.reduce((a, it) => a + M(it.taxAmt, dec), 0n);
  const taxSigned = isReturn ? net(taxLines) : -net(taxLines);
  assert.equal(taxSigned, taxAmt, `ضريبة القيد = taxAmt ${where}`);
  assert.equal(taxSigned, itemTax, `= Σ taxAmt البنود ${where}`);
  const byBox = new Map<string, bigint>();
  for (const l of taxLines) byBox.set(String(l.vatBox), (byBox.get(String(l.vatBox)) ?? 0n) + (isReturn ? l.debitMilli - l.creditMilli : l.creditMilli - l.debitMilli));
  const b6 = c.tax === 'TAX_FREE' && c.doc === 'RETURN_LINKED';
  if (c.tax === 'TAXED' || b6) {
    assert.equal(taxLines.length, 1, `سطر ضريبة واحد ${where}`);
    assert.deepEqual([...byBox.entries()], [[c.dec === 2 ? 'SA_1' : 'null', itemTax]], `المربع ${where}`);
    assert.equal(taxLines[0].taxId, taxIdOf('S15_SALE'));
    assert.equal(taxLines[0].vatAdjustment === true, isReturn, 'المرتجع في عمود التعديلات');
    assert.equal(markers.length, 0);
  } else {
    assert.equal(taxLines.length, 0, `بلا ضريبة ${where}`);
  }
  if (c.tax === 'TAX_FREE' && !b6) {
    assert.equal(markers.length, 0, `«إزالة الضريبة»: لا علامة ${where}`);
    assert.ok(m.lines.every((l) => !l.taxId && !l.taxCode), 'ولا مفتاح ضريبة');
  }
  if (c.tax === 'ZERO' || c.tax === 'EXEMPT') {
    assert.equal(markers.length, 1, `علامة ${where}`);
    assert.equal(markers[0].taxId, taxIdOf(c.tax === 'ZERO' ? 'Z_SALE' : 'E_SALE'));
    assert.equal((markers[0].taxBaseMilli ?? 0n) * (isReturn ? -1n : 1n), subtotal - discountAmt, `وعاء العلامة ${where}`);
  }

  // ── العكس من المستند (OD17): فترة أخرى ⇒ vatAdjustment على TAX/MARKER، والفترة نفسها ⇒ قلبٌ حرفي ──
  const other = checked(buildInvoiceMove(p, ctx, { event: 'REVERSE', reverseDate: REVERSE_DATE_OTHER_PERIOD }), ctx, `${where}/REV`);
  const same = checked(buildInvoiceMove(p, ctx, { event: 'REVERSE', reverseDate: REVERSE_DATE_SAME_PERIOD }), ctx, `${where}/REV=`);
  assert.deepEqual(same, invertInvoiceDraft(m, REVERSE_DATE_SAME_PERIOD), 'الفترة نفسها = القلب الحرفي');
  const plainOther = invertInvoiceDraft(m, REVERSE_DATE_OTHER_PERIOD);
  assert.equal(other.lines.length, plainOther.lines.length);
  other.lines.forEach((l, i) => {
    const tagged = l.taxRole === 'TAX' || l.taxRole === 'MARKER';
    assert.deepEqual(l, tagged ? { ...plainOther.lines[i], vatAdjustment: true } : plainOther.lines[i], `${where}/REV سطر ${i}`);
  });
}

test('مصفوفة المربوطة: 336 خانة (7 مستندات × 4 أوضاع ضريبة × منازل 0/2/3 × شامل/غير شامل × ملفّان) ومعها العكس OD17', () => {
  const cases = matrixCases();
  assert.equal(cases.length, 7 * 4 * 3 * 2 * 2);
  for (const c of cases) assertLinkedCell(c);
});

// ═══ 3. أمثلة العقد المحلولة E4.1–E4.11 ═══

interface Expect { code: string; d?: string; c?: string; [k: string]: unknown }

/** يطابق سطور القيد (الحساب والمبلغين ومفاتيح مختارة) بالترتيب كما هي، بعد حذف سطور العلامة الصفرية */
function assertLines(m: MoveDraft, ctx: BuildContext, dec: number, exp: Expect[], where: string): void {
  const got = m.lines.filter((l) => l.debitMilli !== 0n || l.creditMilli !== 0n);
  assert.equal(got.length, exp.length, `${where}: عدد السطور ${got.map((l) => code(l, ctx)).join(',')}`);
  exp.forEach((e, i) => {
    const l = got[i];
    assert.equal(code(l, ctx), e.code, `${where}: حساب السطر ${i}`);
    assert.equal(l.debitMilli, e.d ? M(e.d, dec) : 0n, `${where}: مدين ${e.code}`);
    assert.equal(l.creditMilli, e.c ? M(e.c, dec) : 0n, `${where}: دائن ${e.code}`);
    for (const [k, v] of Object.entries(e)) {
      if (k === 'code' || k === 'd' || k === 'c') continue;
      assert.deepEqual((l as unknown as Record<string, unknown>)[k], v, `${where}: ${e.code}.${k}`);
    }
  });
}

function simple(over: Partial<InvoicePayload> & Pick<InvoicePayload, 'type' | 'subtotal' | 'taxAmt' | 'total'>, items: InvoicePayloadItem[]): InvoicePayload {
  return {
    invoiceId: 'inv1', number: 'INV-1001', customerId: 'C', customerName: 'عميل C', salesRepId: 'R', salesRepName: 'مندوب R',
    entryDate: '2026-11-14', dueDate: null, pricesIncludeTax: false, discountAmt: '0.00', currency: 'SAR', currencyDecimals: 2,
    items, ...over,
  };
}

const SA_LINKED = () => saContext({ settings: { linkedPosting: true } });

test('E4.1 آجل بقسطين: Dr 113001 575 (2026-12-14) + 575 (2027-01-13) / Cr 411001 [P، 240] 1,000 / Cr 212001 [SA_1، وعاء 1,000] 150', () => {
  const ctx = SA_LINKED();
  const p = simple({
    type: 'CREDIT', subtotal: '1000.00', taxAmt: '150.00', total: '1150.00', dueDate: '2027-01-13',
    installments: [{ seq: 1, dueDate: '2026-12-14', amount: '575.00' }, { seq: 2, dueDate: '2027-01-13', amount: '575.00' }],
  }, [{ productId: 'P', productName: 'كرتون ماء', qty: 10, unitPrice: 100, taxPct: 15, taxAmt: '150.00', lineTotal: '1150.00', baseQty: 240 }]);
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assertLines(m, ctx, 2, [
    { code: '113001', d: '575.00', customerId: 'C', salesRepId: 'R', dueDate: '2026-12-14' },
    { code: '113001', d: '575.00', customerId: 'C', salesRepId: 'R', dueDate: '2027-01-13' },
    { code: '411001', c: '1000.00', productId: 'P', quantity: 240 },
    { code: '212001', c: '150.00', taxId: taxIdOf('S15_SALE'), vatBox: 'SA_1', taxBaseMilli: M(1000) },
  ], 'E4.1');
  // غير المربوطة: سطر ذمة واحد باستحقاق payload.dueDate، وإيراد بلا صنف
  const plain = checked(buildInvoiceMove(p, saContext()), saContext());
  assertLines(plain, saContext(), 2, [
    { code: '113001', d: '1150.00', dueDate: '2027-01-13' },
    { code: '411001', c: '1000.00', productId: undefined, quantity: undefined },
    { code: '212001', c: '150.00' },
  ], 'E4.1/غير مربوطة');
});

test('E4.2 نقدي مختوم (OD2): Dr 113001 115 / Cr 411001 100 / Cr 212001 15 / Dr 111003 [R] 115 / Cr 113001 115 — والإعداد MAIN_CASH', () => {
  const ctx = SA_LINKED();
  assert.equal(ctx.settings.cashInvoiceRouting, 'MAIN_CASH');
  const p = simple({ type: 'CASH', number: 'INV-1002', subtotal: '100.00', taxAmt: '15.00', total: '115.00', cashCollectedByRep: true },
    [{ productId: 'P', qty: 1, unitPrice: 100, taxPct: 15, taxAmt: '15.00', lineTotal: '115.00' }]);
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assertLines(m, ctx, 2, [
    { code: '113001', d: '115.00' },
    { code: '411001', c: '100.00', productId: 'P', quantity: 1 },
    { code: '212001', c: '15.00' },
    { code: '111003', d: '115.00', salesRepId: 'R', partnerName: 'مندوب R' },
    { code: '113001', c: '115.00', customerId: 'C' },
  ], 'E4.2');
  // الختم بلا مندوب ⇒ القاعدة القائمة (MAIN_CASH)
  const noRep = checked(buildInvoiceMove({ ...p, salesRepId: null }, ctx), ctx);
  assert.equal(sumD(on(noRep, ctx, '111001')), M(115));
  // غير المربوطة تتجاهل الختم (سلوك اليوم)
  const plain = checked(buildInvoiceMove(p, saContext()), saContext());
  assert.equal(sumD(on(plain, saContext(), '111001')), M(115));
  assert.equal(on(plain, saContext(), '111003').length, 0);
});

test('E4.3 نقدي غير مختوم: MAIN_CASH ⇒ Dr 111001 115، وCUSTODY احتياطاً ⇒ 111003', () => {
  const p = simple({ type: 'CASH', subtotal: '100.00', taxAmt: '15.00', total: '115.00' },
    [{ productId: 'P', qty: 1, unitPrice: 100, taxPct: 15, taxAmt: '15.00', lineTotal: '115.00' }]);
  const ctx = SA_LINKED();
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assertLines(m, ctx, 2, [
    { code: '113001', d: '115.00' }, { code: '411001', c: '100.00' }, { code: '212001', c: '15.00' },
    { code: '111001', d: '115.00' }, { code: '113001', c: '115.00' },
  ], 'E4.3');
  const ctxC = saContext({ settings: { linkedPosting: true, cashInvoiceRouting: 'CUSTODY' } });
  assert.equal(sumD(on(checked(buildInvoiceMove(p, ctxC), ctxC), ctxC, '111003')), M(115));
});

test('E4.4 استحقاق افتراضي (B1): آجلة 2026-11-14 وdueDate مشتق 2026-12-14 ⇒ سطر 113001 باستحقاق 2026-12-14', () => {
  const ctx = SA_LINKED();
  const p = simple({ type: 'CREDIT', subtotal: '100.00', taxAmt: '15.00', total: '115.00', dueDate: '2026-12-14', dueDateDerived: true },
    [{ productId: 'P', qty: 1, unitPrice: 100, taxPct: 15, taxAmt: '15.00', lineTotal: '115.00' }]);
  const ar = on(checked(buildInvoiceMove(p, ctx), ctx), ctx, '113001');
  assert.equal(ar.length, 1);
  assert.equal(ar[0].dueDate, '2026-12-14');
});

test('E4.5 إيراد لكل صنف وخصم منفصل: Dr 113001 207 / Dr 413001 [P1] 10 / Dr 413001 [P2] 10 / Cr 411001 [P1، 2] 100 / Cr 411001 [P2، 1] 100 / Cr 212001 [180] 27', () => {
  const ctx = SA_LINKED();
  const calc = computeInvoiceTotals(
    [{ qty: 2, unitPrice: 50, discountPct: 0, taxPct: 15 }, { qty: 1, unitPrice: 100, discountPct: 0, taxPct: 15 }],
    { companyVat: 15, decimals: 2, invoiceDiscountPct: 10, pricesIncludeTax: false },
  );
  assert.deepEqual([calc.subtotal, calc.discountAmt, calc.taxAmt, calc.total], [200, 20, 27, 207]);
  const p = invoicePayloadFromRows({
    invoice: { id: 'inv5', number: 'INV-1005', type: 'CREDIT', customerId: 'C', salesRepId: 'R', pricesIncludeTax: false,
      subtotal: calc.subtotal, discountAmt: calc.discountAmt, taxAmt: calc.taxAmt, total: calc.total },
    items: calc.items.map((it, i) => ({ productId: i === 0 ? 'P1' : 'P2', productName: i === 0 ? 'صنف ١' : 'صنف ٢', baseQty: i === 0 ? 2 : 1,
      qty: it.qty, unitPrice: it.unitPrice, taxPct: it.taxPct, taxAmt: it.taxAmt, lineTotal: it.lineTotal })),
    customerName: 'عميل C', salesRepName: 'مندوب R', entryDate: '2026-11-14', dueDate: '2026-12-14', currency: 'SAR', currencyDecimals: 2,
  });
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assertLines(m, ctx, 2, [
    { code: '113001', d: '207.00' },
    { code: '411001', c: '100.00', productId: 'P1', quantity: 2, label: 'إيراد مبيعات INV-1005 — صنف ١ — 15٪' },
    { code: '413001', d: '10.00', productId: 'P1' },
    { code: '411001', c: '100.00', productId: 'P2', quantity: 1, label: 'إيراد مبيعات INV-1005 — صنف ٢ — 15٪' },
    { code: '413001', d: '10.00', productId: 'P2' },
    { code: '212001', c: '27.00', taxBaseMilli: M(180) },
  ], 'E4.5');
  assert.equal(sumD(m.lines), M(227));
  assert.equal(sumC(m.lines), M(227));
});

test('E4.6 تقريب (منزلتان): الإجمالي المخزَّن 115.01 ⇒ Cr 421009 0.01 بلا تنبيه', () => {
  const ctx = SA_LINKED();
  const p = simple({ type: 'CREDIT', subtotal: '100.00', taxAmt: '15.00', total: '115.01' },
    [{ productId: 'P', qty: 1, unitPrice: 100, taxPct: 15, taxAmt: '15.00', lineTotal: '115.00' }]);
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assertLines(m, ctx, 2, [
    { code: '113001', d: '115.01' }, { code: '411001', c: '100.00' }, { code: '212001', c: '15.00' }, { code: '421009', c: '0.01' },
  ], 'E4.6');
  assert.equal(m.needsAttention, false);
});

test('E4.7 ثلاث منازل (دينار بحريني 10٪): 3 × 0.333 ⇒ Dr 113001 1.099 / Cr 411001 0.999 / Cr 212001 0.100', () => {
  const ctx = genericContext('BH', { settings: { linkedPosting: true } });
  assert.equal(ctx.settings.currencyDecimals, 3);
  const calc = computeInvoiceTotals([{ qty: 3, unitPrice: 0.333, discountPct: 0, taxPct: 10 }], { companyVat: 10, decimals: 3, invoiceDiscountPct: 0 });
  assert.deepEqual([calc.subtotal, calc.taxAmt, calc.total], [0.999, 0.1, 1.099]);
  const p = simple({ type: 'CREDIT', subtotal: '0.999', discountAmt: '0.000', taxAmt: '0.100', total: '1.099', currency: 'BHD', currencyDecimals: 3 },
    [{ productId: 'P', qty: 3, unitPrice: 0.333, taxPct: 10, taxAmt: '0.100', lineTotal: '1.099' }]);
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assertLines(m, ctx, 3, [
    { code: '113001', d: '1.099' }, { code: '411001', c: '0.999', quantity: 3 }, { code: '212001', c: '0.100', taxId: taxIdOf('S10_SALE') },
  ], 'E4.7');
  // التقريب بثلاث منازل: فرق 0.001 ضمن الحد ⇒ 421009، و0.002 لبند واحد ⇒ 911001 مع تنبيه
  const r1 = checked(buildInvoiceMove({ ...p, total: '1.100' }, ctx), ctx);
  assert.equal(sumC(on(r1, ctx, '421009')), M('0.001', 3));
  const r2 = checked(buildInvoiceMove({ ...p, total: '1.101' }, ctx), ctx);
  assert.equal(sumC(on(r2, ctx, '911001')), M('0.002', 3));
  assert.equal(r2.needsAttention, true);
});

test('E4.8 صفر منازل (دينار عراقي بلا ضريبة): 2 × 1,500 ⇒ Dr 113001 3,000 / Cr 411001 3,000 بلا علامة', () => {
  const ctx = genericContext('IQ', { settings: { linkedPosting: true } });
  assert.equal(ctx.settings.currencyDecimals, 0);
  assert.equal(ctx.settings.zeroRatedSalesTaxKey, null);
  const p = simple({ type: 'CREDIT', subtotal: '3000', discountAmt: '0', taxAmt: '0', total: '3000', currency: 'IQD', currencyDecimals: 0 },
    [{ productId: 'P', qty: 2, unitPrice: 1500, taxPct: 0, taxAmt: '0', lineTotal: '3000' }]);
  const m = checked(buildInvoiceMove(p, ctx), ctx);
  assertLines(m, ctx, 0, [{ code: '113001', d: '3000' }, { code: '411001', c: '3000', quantity: 2 }], 'E4.8');
  assert.equal(m.lines.filter((l) => l.taxRole === 'MARKER').length, 0);
  // التقريب بصفر منازل: فرق 1 لبند واحد ⇒ 421009، و2 ⇒ 911001
  assert.equal(sumC(on(checked(buildInvoiceMove({ ...p, total: '3001' }, ctx), ctx), ctx, '421009')), M(1, 0));
  const r2 = checked(buildInvoiceMove({ ...p, total: '3002' }, ctx), ctx);
  assert.equal(sumC(on(r2, ctx, '911001')), M(2, 0));
  assert.equal(r2.needsAttention, true);
});

test('E4.9 B6 مرتجع «إزالة الضريبة» مرتبط ببيع خاضع: قبل ⇒ Dr 412001 115 / Cr 113001 115؛ بعد ⇒ Dr 412001 100 / Dr 212001 15 [تعديل، SA_1، −100] / Cr 113001 115', () => {
  const ctx = SA_LINKED();
  const before = simple({ type: 'RETURN', number: 'RET-901', taxFree: true, pricesIncludeTax: true, subtotal: '115.00', taxAmt: '0.00', total: '115.00',
    appliesTo: { invoiceId: 'INV-900', amount: '115.00' } },
  [{ productId: 'P', qty: 1, unitPrice: 115, taxPct: 0, taxAmt: '0.00', lineTotal: '115.00' }]);
  const mb = checked(buildInvoiceMove(before, ctx), ctx);
  assertLines(mb, ctx, 2, [{ code: '113001', c: '115.00' }, { code: '412001', d: '115.00' }], 'E4.9/قبل');
  assert.equal(mb.lines.length, 2, 'لا علامة صفرية ولا «0٪» (taxFree)');
  const after = simple({ type: 'RETURN', number: 'RET-901', taxFree: true, pricesIncludeTax: true, subtotal: '100.00', taxAmt: '15.00', total: '115.00',
    appliesTo: { invoiceId: 'INV-900', amount: '115.00' } },
  [{ productId: 'P', qty: 1, unitPrice: 115, taxPct: 15, taxAmt: '15.00', lineTotal: '115.00' }]);
  const ma = checked(buildInvoiceMove(after, ctx), ctx);
  assertLines(ma, ctx, 2, [
    { code: '113001', c: '115.00', dueDate: null },
    { code: '412001', d: '100.00', productId: 'P' },
    { code: '212001', d: '15.00', vatAdjustment: true, vatBox: 'SA_1', taxBaseMilli: -M(100) },
  ], 'E4.9/بعد');
});

test('E4.10 OD17 (ربعية): بيع 2026-09-28 أُلغي 2026-10-03 ⇒ Dr 212001 15 [vatAdjustment=true]؛ أُلغي 2026-09-30 ⇒ false — وللمرتجع يبقى true', () => {
  const ctx = SA_LINKED();
  assert.equal(ctx.settings.taxPeriodicity, 'QUARTERLY');
  const p = simple({ type: 'CREDIT', entryDate: '2026-09-28', subtotal: '100.00', taxAmt: '15.00', total: '115.00' },
    [{ productId: 'P', qty: 1, unitPrice: 100, taxPct: 15, taxAmt: '15.00', lineTotal: '115.00' }]);
  const other = checked(buildInvoiceMove(p, ctx, { event: 'REVERSE', reverseDate: '2026-10-03' }), ctx);
  assertLines(other, ctx, 2, [
    { code: '113001', c: '115.00' },
    { code: '411001', d: '100.00' },
    { code: '212001', d: '15.00', vatAdjustment: true, taxBaseMilli: -M(100) },
  ], 'E4.10');
  assert.equal(other.date, '2026-10-03');
  assert.equal(other.sourceKey, 'INVOICE:inv1:REVERSE');
  const same = checked(buildInvoiceMove(p, ctx, { event: 'REVERSE', reverseDate: '2026-09-30' }), ctx);
  assert.equal(same.lines.find((l) => l.taxRole === 'TAX')?.vatAdjustment, undefined, 'الفترة نفسها: لا علَم (كاليوم)');
  // غير المربوطة: كاليوم مهما كانت الفترة
  const plain = checked(buildInvoiceMove(p, saContext(), { event: 'REVERSE', reverseDate: '2026-10-03' }), saContext());
  assert.equal(plain.lines.find((l) => l.taxRole === 'TAX')?.vatAdjustment, undefined);
  // الشهرية: 2026-09-28 ⇒ 2026-09-30 الفترة نفسها، وFISCAL_YEAR (نهاية 6/30): 2026-06-28 ⇒ 2026-07-01 فترة أخرى
  const monthly = saContext({ settings: { linkedPosting: true, taxPeriodicity: 'MONTHLY' } });
  assert.equal(asMove(buildInvoiceMove(p, monthly, { event: 'REVERSE', reverseDate: '2026-09-30' })).lines.find((l) => l.taxRole === 'TAX')?.vatAdjustment, undefined);
  assert.equal(asMove(buildInvoiceMove(p, monthly, { event: 'REVERSE', reverseDate: '2026-10-01' })).lines.find((l) => l.taxRole === 'TAX')?.vatAdjustment, true);
  const fy = saContext({ settings: { linkedPosting: true, taxPeriodicity: 'FISCAL_YEAR', fiscalYearEndMonth: 6, fiscalYearEndDay: 30 } });
  const pJune = { ...p, entryDate: '2026-06-28' };
  assert.equal(asMove(buildInvoiceMove(pJune, fy, { event: 'REVERSE', reverseDate: '2026-06-30' })).lines.find((l) => l.taxRole === 'TAX')?.vatAdjustment, undefined);
  assert.equal(asMove(buildInvoiceMove(pJune, fy, { event: 'REVERSE', reverseDate: '2026-07-01' })).lines.find((l) => l.taxRole === 'TAX')?.vatAdjustment, true);
  // المرتجع: معلَّم أصلاً، فيبقى true في الفترتين
  const ret = { ...p, type: 'RETURN' as const, number: 'RET-1' };
  for (const d of ['2026-09-30', '2026-10-03']) {
    assert.equal(asMove(buildInvoiceMove(ret, ctx, { event: 'REVERSE', reverseDate: d })).lines.find((l) => l.taxRole === 'TAX')?.vatAdjustment, true, d);
  }
});

test('OD17 مع الإقفال: عكسٌ في الفترة نفسها بتاريخ مقفل ضريبياً يُزاح إلى فترة لاحقة ⇒ vatAdjustment=true (كما سيرحّله postMove(SHIFT))', () => {
  const p = simple({ type: 'CREDIT', entryDate: '2026-09-28', subtotal: '100.00', taxAmt: '15.00', total: '115.00' },
    [{ productId: 'P', qty: 1, unitPrice: 100, taxPct: 15, taxAmt: '15.00', lineTotal: '115.00' }, { qty: 1, unitPrice: 0, taxPct: 0, taxAmt: '0.00', lineTotal: '0.00' }]);
  const open = SA_LINKED();
  const r0 = asMove(buildInvoiceMove(p, open, { event: 'REVERSE', reverseDate: '2026-09-29' }));
  assert.ok(r0.lines.filter((l) => l.taxRole === 'TAX' || l.taxRole === 'MARKER').every((l) => l.vatAdjustment !== true));
  const locked = saContext({ settings: { linkedPosting: true, taxLockDate: '2026-09-30' } });
  const r1 = asMove(buildInvoiceMove(p, locked, { event: 'REVERSE', reverseDate: '2026-09-29' }));
  assert.equal(r1.date, '2026-09-29', 'الـbuilder لا يزيح التاريخ (postMove يفعل)');
  const tagged = r1.lines.filter((l) => l.taxRole === 'TAX' || l.taxRole === 'MARKER');
  assert.equal(tagged.length, 2, 'TAX والعلامة الصفرية');
  assert.ok(tagged.every((l) => l.vatAdjustment === true));
  assert.ok(r1.lines.filter((l) => !l.taxRole || l.taxRole === 'BASE').every((l) => l.vatAdjustment === undefined));
});

test('E4.11 إبطال ZATCA يحتفظ بالنقد: عكس E4.2 بلا ساق النقد ⇒ Dr 411001 100 / Dr 212001 15 / Cr 113001 115، و111003 لا يُمسّ', () => {
  const ctx = SA_LINKED();
  const p = simple({ type: 'CASH', number: 'INV-1002', subtotal: '100.00', taxAmt: '15.00', total: '115.00', cashCollectedByRep: true },
    [{ productId: 'P', qty: 1, unitPrice: 100, taxPct: 15, taxAmt: '15.00', lineTotal: '115.00' }]);
  const m = checked(buildInvoiceMove(p, ctx, { event: 'REVERSE', reverseDate: '2026-11-20', keepCashLeg: true }), ctx);
  assertLines(m, ctx, 2, [{ code: '113001', c: '115.00' }, { code: '411001', d: '100.00' }, { code: '212001', d: '15.00' }], 'E4.11');
  assert.equal(on(m, ctx, '111003', '111001').length, 0);
  // العكس الكامل (إلغاء) للمختومة يعكس ساق العهدة نفسها
  const full = checked(buildInvoiceMove(p, ctx, { event: 'REVERSE', reverseDate: '2026-11-20' }), ctx);
  assert.equal(sumC(on(full, ctx, '111003')), M(115));
});

// ═══ 4. الأقساط: حالات الحافة ═══

test('الأقساط: مجموعها ≠ total (قديمة) ⇒ Σ السطور = total حرفاً بأكبر الباقي، وقسط صفري بلا سطر، وغير الآجلة تتجاهلها', () => {
  const ctx = SA_LINKED();
  const base = simple({ type: 'CREDIT', subtotal: '100.00', taxAmt: '15.00', total: '115.00' },
    [{ productId: 'P', qty: 1, unitPrice: 100, taxPct: 15, taxAmt: '15.00', lineTotal: '115.00' }]);
  const stale = checked(buildInvoiceMove({ ...base, installments: [
    { seq: 1, dueDate: '2026-12-01', amount: '33.33' }, { seq: 2, dueDate: '2027-01-01', amount: '33.33' }, { seq: 3, dueDate: '2027-02-01', amount: '33.34' },
  ] }, ctx), ctx);
  const ar = on(stale, ctx, '113001');
  assert.equal(sumD(ar), M(115));
  assert.deepEqual(ar.map((l) => l.debitMilli), [M('38.33'), M('38.33'), M('38.34')]);
  const zero = checked(buildInvoiceMove({ ...base, installments: [
    { seq: 1, dueDate: '2026-12-01', amount: '115.00' }, { seq: 2, dueDate: '2027-01-01', amount: '0.00' },
  ] }, ctx), ctx);
  assert.deepEqual(on(zero, ctx, '113001').map((l) => [l.debitMilli, l.dueDate]), [[M(115), '2026-12-01']]);
  const cash = checked(buildInvoiceMove({ ...base, type: 'CASH', installments: [{ seq: 1, dueDate: '2026-12-01', amount: '115.00' }] }, ctx), ctx);
  assert.equal(on(cash, ctx, '113001').filter((l) => l.debitMilli > 0n).length, 1, 'النقدية: سطر ذمة واحد');
  const none = checked(buildInvoiceMove({ ...base, installments: [] }, ctx), ctx);
  assert.equal(on(none, ctx, '113001').length, 1);
});

// ═══ 5. خاصية: فواتير عشوائية للمربوطة ═══

test('خاصية: 900 فاتورة عشوائية للمربوطة (منازل 0/2/3، أنواع، أصناف مكرّرة، أقساط، ختم) ⇒ متّزنة، الذمة = AccountEntry، والكميات = Σ الأساس', async () => {
  let seed = 20261114;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  for (let n = 0; n < 900; n++) {
    const dec = pick([0, 2, 3] as const);
    const separate = rnd() < 0.5;
    const ctx = contextFor(dec, { settings: { linkedPosting: true, postSalesDiscountSeparately: separate, cashInvoiceRouting: pick(['MAIN_CASH', 'CUSTODY'] as const) } });
    const count = 1 + Math.floor(rnd() * 7);
    const raw = Array.from({ length: count }, () => ({
      productId: pick(['p1', 'p2', 'p3', null] as const),
      qty: pick([1, 2, 3, 0.5, 12, 7]),
      factor: pick([1, 6, 24]),
      unitPrice: Math.round(rnd() * 50000) / pick([100, 1000, 10]),
      discountPct: pick([0, 0, 5, 10, 12.5, 100]),
      taxPct: pick([15, 15, 0]),
    }));
    const inclusive = rnd() < 0.5;
    const calc = computeInvoiceTotals(raw.map((r) => ({ qty: r.qty, unitPrice: r.unitPrice, discountPct: r.discountPct, taxPct: r.taxPct })),
      { companyVat: 15, decimals: dec, invoiceDiscountPct: pick([0, 0, 3, 7.5]), pricesIncludeTax: inclusive });
    const type = pick(['CASH', 'CREDIT', 'RETURN'] as const);
    const withInst = type === 'CREDIT' && rnd() < 0.5;
    const p = invoicePayloadFromRows({
      invoice: { id: `r${n}`, number: `N-${n}`, type, customerId: 'c1', salesRepId: rnd() < 0.8 ? 'rep1' : null, pricesIncludeTax: inclusive,
        subtotal: calc.subtotal, discountAmt: calc.discountAmt, taxAmt: calc.taxAmt, total: calc.total, cashCollectedByRep: type === 'CASH' && rnd() < 0.5 },
      items: calc.items.map((it, i) => ({ productId: raw[i].productId, productName: raw[i].productId ? `اسم ${raw[i].productId}` : null,
        baseQty: raw[i].qty * raw[i].factor, qty: it.qty, unitPrice: it.unitPrice, taxPct: it.taxPct, taxAmt: it.taxAmt, lineTotal: it.lineTotal })),
      customerName: 'عميل', salesRepName: 'مندوب', entryDate: '2026-11-14', dueDate: type === 'CREDIT' ? '2026-12-14' : null,
      currency: 'X', currencyDecimals: dec,
      installments: withInst ? [{ seq: 1, dueDate: '2026-12-14', amount: calc.total / 2 }, { seq: 2, dueDate: '2027-01-14', amount: calc.total - calc.total / 2 }] : null,
    });
    const r = buildInvoiceMove(p, ctx);
    const total = M(p.total, dec);
    if (total === 0n) { assert.ok(isNoMove(r)); continue; }
    const m = checked(r, ctx, `#${n}`);
    assert.equal(on(m, ctx, '911001').length, 0, `معلّق غير متوقع #${n}`);
    const inc = type === 'RETURN' ? 1n : -1n;
    assert.equal(net(m.lines.filter((l) => l.taxRole === 'TAX')) * inc, M(p.taxAmt, dec), `ضريبة #${n}`);
    const rev = on(m, ctx, ...REVENUE_CODES);
    assert.equal(net(rev) * inc, separate ? M(p.subtotal, dec) : M(p.subtotal, dec) - M(p.discountAmt, dec), `إيراد #${n}`);
    // الكمية لكل صنف = Σ baseQty بنوده (على سطور الإيراد غير الصفرية لكل سلة)
    for (const l of rev) {
      if (!l.productId) { assert.equal(l.quantity, undefined); continue; }
      const sameBucket = p.items.filter((it) => it.productId === l.productId && ((Number(it.taxPct) > 0) === (l.taxId === taxIdOf('S15_SALE'))));
      const qty = Math.round(sameBucket.reduce((a, it) => a + (it.baseQty ?? 0), 0) * 1e6) / 1e6;
      assert.equal(l.quantity, qty, `كمية ${l.productId} #${n}`);
    }
    // R2: الذمة = AccountEntry (صافياً)
    if (n % 9 === 0) {
      const rows: { debit: number; credit: number }[] = [];
      const tx = {
        accountEntry: {
          aggregate: async () => ({ _sum: { debit: rows.reduce((a, x) => a + x.debit, 0), credit: rows.reduce((a, x) => a + x.credit, 0) } }),
          create: async ({ data }: { data: { debit: number; credit: number } }) => { rows.push(data); return data; },
        },
        customer: { update: async () => ({}) },
      } as never;
      const t = Number(p.total);
      if (type === 'RETURN') await postReturnEntries(tx, 't', p.invoiceId, 'c1', t);
      else if (type === 'CASH') await postCashInvoiceEntries(tx, 't', p.invoiceId, 'c1', t);
      else await postInvoiceEntries(tx, 't', p.invoiceId, 'c1', t);
      assert.equal(net(on(m, ctx, '113001')), rows.reduce((a, x) => a + M(x.debit, dec) - M(x.credit, dec), 0n), `R2 #${n}`);
    }
  }
});

// ═══ 6. invoicePayloadFromRows ═══

const ROW_BASE = {
  invoice: { id: 'i1', number: 'INV-1', type: 'CREDIT', customerId: 'c1', salesRepId: 'r1', pricesIncludeTax: false,
    subtotal: 100, discountAmt: 0, taxAmt: 15, total: 115 },
  items: [{ productId: 'p1', categoryId: null, qty: 1, unitPrice: 100, taxPct: 15, taxAmt: 15, lineTotal: 115 }],
  customerName: 'عميل', salesRepName: 'مندوب', entryDate: '2026-11-14', dueDate: null, currency: 'SAR', currencyDecimals: 2,
};

test('invoicePayloadFromRows: بلا الحقول الجديدة ⇒ المفاتيح حرفاً كما كانت (لا مفتاح جديد ولا undefined)', () => {
  const p = invoicePayloadFromRows(ROW_BASE);
  assert.deepEqual(Object.keys(p), ['invoiceId', 'number', 'type', 'customerId', 'customerName', 'salesRepId', 'salesRepName', 'entryDate',
    'dueDate', 'pricesIncludeTax', 'subtotal', 'discountAmt', 'taxAmt', 'total', 'currency', 'currencyDecimals', 'items']);
  assert.deepEqual(Object.keys(p.items[0]), ['productId', 'categoryId', 'qty', 'unitPrice', 'taxPct', 'taxAmt', 'lineTotal']);
  // القيم «الفارغة» لا تُكتب: false وnull و[] و'' وNaN
  const q = invoicePayloadFromRows({
    ...ROW_BASE, invoice: { ...ROW_BASE.invoice, cashCollectedByRep: false }, cashCollectedByRep: null, installments: [], dueDateDerived: false,
    appliesTo: null, items: [{ ...ROW_BASE.items[0], baseQty: null, productName: '   ' }, { ...ROW_BASE.items[0], baseQty: Number.NaN, productName: null }],
  });
  assert.deepEqual(q, { ...p, items: [p.items[0], p.items[0]] });
});

test('invoicePayloadFromRows: الحقول الجديدة حين تحمل قيمة — الأقساط مرتّبة نصوصاً، وappliesTo، والختم من الصف أو المستوى الأعلى', () => {
  const p = invoicePayloadFromRows({
    ...ROW_BASE,
    invoice: { ...ROW_BASE.invoice, cashCollectedByRep: true },
    installments: [{ seq: 2, dueDate: '2027-01-14', amount: 57.5 }, { seq: 1, dueDate: '2026-12-14', amount: '57.5' }],
    dueDateDerived: true,
    appliesTo: { invoiceId: 'sale1', amount: 115 },
    items: [{ ...ROW_BASE.items[0], baseQty: 24, productName: '  كرتون ماء ' }],
  });
  assert.equal(p.cashCollectedByRep, true);
  assert.deepEqual(p.installments, [{ seq: 1, dueDate: '2026-12-14', amount: '57.50' }, { seq: 2, dueDate: '2027-01-14', amount: '57.50' }]);
  assert.equal(p.dueDateDerived, true);
  assert.deepEqual(p.appliesTo, { invoiceId: 'sale1', amount: '115.00' });
  assert.equal(p.items[0].baseQty, 24);
  assert.equal(p.items[0].productName, 'كرتون ماء');
  assert.equal(invoicePayloadFromRows({ ...ROW_BASE, cashCollectedByRep: true }).cashCollectedByRep, true);
  assert.deepEqual(invoicePayloadFromRows({ ...ROW_BASE, appliesTo: { invoiceId: 'orig1', amount: null } }).appliesTo, { invoiceId: 'orig1', amount: null });
  assert.equal(invoicePayloadFromRows({ ...ROW_BASE, appliesTo: { invoiceId: '', amount: 1 } }).appliesTo, undefined);
  // ثلاث منازل وصفر منازل: نصوص بمنازل العملة (نصف-لأعلى)
  const d3 = invoicePayloadFromRows({ ...ROW_BASE, currencyDecimals: 3, installments: [{ seq: 1, dueDate: '2026-12-14', amount: 1.0995 }] });
  assert.equal(d3.installments?.[0].amount, '1.100');
  const d0 = invoicePayloadFromRows({ ...ROW_BASE, currencyDecimals: 0, appliesTo: { invoiceId: 's', amount: '1499.5' } });
  assert.equal(d0.appliesTo?.amount, '1500');
});
