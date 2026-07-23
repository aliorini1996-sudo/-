import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireVertical } from '../../middleware/vertical';
import menuRouter from './menu';
import tablesRouter from './tables';
import posRouter from './pos';
import shiftsRouter from './shifts';
import reportsRouter from './reports';

// جذر مسارات عمودية المطاعم — كل ما تحته محمي بالمصادقة + حارس العمودية.
// requireVertical('restaurant') يمنع أي حساب توزيع (أو توكن بلا vertical) من بلوغ هذه المسارات.
const router = Router();
router.use(authenticate, requireVertical('restaurant'));

router.use('/menu', menuRouter);
router.use('/tables', tablesRouter);
router.use('/pos', posRouter);
router.use('/shifts', shiftsRouter);
router.use('/reports', reportsRouter);

export default router;
