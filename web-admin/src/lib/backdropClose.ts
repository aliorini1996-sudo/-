import type { MouseEvent } from 'react';

/**
 * إغلاق النافذة بالنقر على خلفيتها — دون أن يغلقها **تحديد النصّ**.
 *
 * العلّة التي يعالجها: حين تبدأ تحديد نصّ داخل النافذة وتُفلت زرّ الفأرة فوق
 * الخلفية، ينسب المتصفّح حدث `click` إلى أقرب سلف مشترك بين موضعَي الضغط
 * والإفلات — وهو الخلفية — فتُغلق النافذة فجأة ويضيع ما كنت تكتبه.
 * و`stopPropagation` في محتوى النافذة لا يمنع ذلك، لأن الحدث لم يمرّ
 * بالمحتوى أصلاً بل وُلد على الخلفية مباشرةً.
 *
 * العلاج: لا نغلق إلا إذا **بدأ الضغط وانتهى على الخلفية نفسها**. وحالة
 * البدء تُحفظ على عنصر الخلفية ذاته (لا في حالة React) لتبقى الدالّة نقيّة
 * فتُستدعى داخل JSX مباشرةً بلا قيود الـhooks.
 *
 * الاستعمال:  <div className="fixed inset-0 ..." {...backdropClose(onClose)}>
 */
export function backdropClose(onClose: () => void) {
  return {
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      e.currentTarget.dataset.bdDown = String(e.target === e.currentTarget);
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      const startedOnBackdrop = e.currentTarget.dataset.bdDown === 'true';
      delete e.currentTarget.dataset.bdDown;
      if (startedOnBackdrop && e.target === e.currentTarget) onClose();
    },
  };
}
