import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireVertical } from '../../middleware/vertical';
import menuRouter from './menu';
import tablesRouter from './tables';

// جذر مسارات عمودية المطاعم — كل ما تحته محمي بالمصادقة + حارس العمودية.
// requireVertical('restaurant') يمنع أي حساب توزيع (أو توكن بلا vertical) من بلوغ هذه المسارات.
const router = Router();
router.use(authenticate, requireVertical('restaurant'));

router.use('/menu', menuRouter);
router.use('/tables', tablesRouter);

export default router;
