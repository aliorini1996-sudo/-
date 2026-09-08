import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, UserRound, Maximize2, X, Check } from 'lucide-react';
import { useTr } from '../i18n/strings';

/**
 * لوحة مسار الاعتماد — عُقدٌ على مساحةٍ فارغة، كل عقدةٍ **شخصٌ بعينه**.
 *
 * لماذا لوحة لا قائمة: السلسلة مسارٌ بين أشخاص، والمالك يضبطها وهو يفكّر
 * بأسمائهم لا بمسمّياتٍ مجرّدة. «من يستقبل بعد خالد؟» سؤالٌ عن شخص، وتمثيله
 * صفّاً في جدولٍ يُخفي الشكل الذي يراه في ذهنه أصلاً.
 *
 * قاعدةٌ حاكمة: **الموضع بصريٌّ محض ولا يمسّ الترتيب.** ربطُ ترتيب الاعتماد
 * بموضع العقدة يجعل سحبةً عابرة تعيد ترتيب سلسلةٍ مالية بلا أن ينتبه أحد.
 * فالترتيب رقمٌ ظاهرٌ على العقدة يُبدَّل بزرّين، والسحب لتنظيم اللوحة وحده.
 */

export interface CanvasNode {
  id: string;
  seq: number;
  name: string;
  kind: string;
  color: string | null;
  posX: number | null;
  posY: number | null;
  ownerName: string | null;
  ownerAdminId: string | null;
  repIds: string[];
}

export interface Person { id: string; name: string; role?: string }

const PALETTE = ['#F5C400', '#1E5FE0', '#F1F5F9', '#22C55E', '#A855F7', '#06B6D4', '#F97316', '#EC4899'];
const REP_COLOR = '#EF4444';
const NODE_W = 132;
const NODE_H = 116;
const STEP = NODE_W + 76;
const EDGE_X = 40;
const REP_Y = 150;

const colorOf = (n: CanvasNode, i: number) => n.color || PALETTE[i % PALETTE.length];

/**
 * التخطيط الافتراضيّ **يمضي يميناً ← يساراً** كاتّجاه القراءة العربية:
 * المندوب أقصى اليمين، وكل عقدةٍ تالية إلى يساره، و«معتمد» أقصى اليسار.
 *
 * وهو ما تفترضه الوصلات أصلاً (تخرج من يسار العقدة وتدخل يمين التالية).
 * فالتخطيط الذي كان يزيد x مع الترتيب كان يعاكسها: أسهمٌ ترجع إلى الوراء،
 * وبطاقة «معتمد» تُرسم فوق بطاقة المندوب.
 */
const repXFor = (count: number) => EDGE_X + (count + 1) * STEP;
const defaultXFor = (repX: number, i: number) => repX - (i + 1) * STEP;

const posOf = (n: CanvasNode, i: number, repX: number) => ({
  x: n.posX ?? defaultXFor(repX, i),
  y: n.posY ?? REP_Y,
});

/** منحنى بيزيه بين عقدتين — من يسار الأولى إلى يمين الثانية (اتجاه عربيّ) */
function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
}

function Avatar({ color, name, size = 42 }: { color: string; name: string | null; size?: number }) {
  const initial = (name || '').trim().charAt(0);
  const dark = color === '#F1F5F9' || color === '#FFFFFF';
  return (
    <div
      className="rounded-full flex items-center justify-center font-bold mx-auto"
      style={{
        width: size, height: size, background: color,
        color: dark ? '#1F1A13' : '#fff',
        fontSize: size * 0.42,
        border: dark ? '2px solid #CBD5E1' : 'none',
      }}
    >
      {initial || <UserRound size={size * 0.5} />}
    </div>
  );
}

export default function DailyReportCanvas({
  nodes, people, reps, onAdd, onUpdate, onDelete, onMove, onOwner,
}: {
  nodes: CanvasNode[];
  people: Person[];
  reps: Person[];
  onAdd: (afterSeq: number | null, adminId: string, name: string, color: string, pos: { x: number; y: number }) => void;
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, pos: { x: number; y: number }) => void;
  onOwner: (id: string, adminId: string, repIds: string[]) => void;
}) {
  const tr = useTr();
  const boardRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ afterSeq: number | null } | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; x: number; y: number } | null>(null);

  const ordered = useMemo(() => [...nodes].sort((a, b) => a.seq - b.seq), [nodes]);
  const repX = repXFor(ordered.length);
  /** هل تحرّك المؤشّر فعلاً بعد الضغط؟ — يفصل السحب عن النقر */
  const movedRef = useRef(false);
  const live = useCallback((n: CanvasNode, i: number) => (
    drag?.id === n.id ? { x: drag.x, y: drag.y } : posOf(n, i, repX)
  ), [drag, repX]);

  // سحبُ العقدة — يُحفظ عند الإفلات لا مع كل بكسل
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const r = boardRef.current?.getBoundingClientRect();
      if (!r) return;
      movedRef.current = true;
      setDrag(d => d && ({ ...d, x: Math.max(0, e.clientX - r.left - d.dx), y: Math.max(0, e.clientY - r.top - d.dy) }));
    };
    // **لا يُحفَظ موضعٌ لم يتغيّر**: كانت كل نقرةٍ ترسل طلب تعديل فتكتب سطراً
    // كاذباً «عدّل المستوى» في سجلّ تغييرات الإعداد — سجلُّ تدقيقٍ يمتلئ بضجيج.
    const up = () => {
      setDrag(d => { if (d && movedRef.current) onMove(d.id, { x: Math.round(d.x), y: Math.round(d.y) }); return null; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [drag, onMove]);

  const startDrag = (e: React.PointerEvent, n: CanvasNode, i: number) => {
    const r = boardRef.current?.getBoundingClientRect();
    if (!r) return;
    const p = posOf(n, i, repX);
    movedRef.current = false;
    setDrag({ id: n.id, dx: e.clientX - r.left - p.x, dy: e.clientY - r.top - p.y, x: p.x, y: p.y });
  };

  const height = Math.max(360, ...ordered.map((n, i) => live(n, i).y + NODE_H + 60), REP_Y + NODE_H + 60);
  const width = Math.max(760, ...ordered.map((n, i) => live(n, i).x + NODE_W + 80), repX + NODE_W + 80);
  const selected = ordered.find(n => n.id === sel) || null;

  // نقاط الوصل: العربية تمضي يميناً ← يساراً، فالخارج من يسار العقدة
  const outOf = (p: { x: number; y: number }) => ({ x: p.x, y: p.y + NODE_H / 2 });
  const inOf = (p: { x: number; y: number }) => ({ x: p.x + NODE_W, y: p.y + NODE_H / 2 });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <p className="font-bold text-sm">{tr('لوحة مسار الاعتماد')}</p>
          <p className="text-xs text-[#6E6557] mt-0.5">{tr('كل عقدة شخص بعينه — اسحبها لترتيب اللوحة واضغطها لتعديلها')}</p>
        </div>
        <button className="btn-primary" onClick={() => { setAdding({ afterSeq: ordered.length ? ordered[ordered.length - 1].seq : 0 }); setSel(null); }}>
          <Plus size={16} /> {tr('إضافة عقدة')}
        </button>
      </div>

      {/* اللوحة */}
      <div
        className="rounded-2xl border border-[#2A2A38] overflow-auto relative"
        style={{
          background: '#14141C',
          backgroundImage: 'radial-gradient(circle, #2E2E3E 1px, transparent 1px)',
          backgroundSize: '18px 18px',
          maxHeight: '62vh',
        }}
      >
        <div ref={boardRef} className="relative" style={{ width, height }}>
          {/* الوصلات خلف العقد */}
          <svg className="absolute inset-0 pointer-events-none" width={width} height={height}>
            {ordered.map((n, i) => {
              const from = i === 0 ? { x: repX, y: REP_Y } : live(ordered[i - 1], i - 1);
              const a = outOf(from);
              const b = inOf(live(n, i));
              const broken = !n.ownerAdminId;
              return (
                <g key={`e-${n.id}`}>
                  <path
                    d={edgePath(a.x, a.y, b.x, b.y)} fill="none"
                    stroke={broken ? '#EF4444' : '#4B5563'} strokeWidth={2}
                    strokeDasharray={broken ? '5 5' : undefined}
                  />
                  <circle cx={a.x} cy={a.y} r={3.5} fill={broken ? '#EF4444' : '#6B7280'} />
                  <circle cx={b.x} cy={b.y} r={3.5} fill={broken ? '#EF4444' : '#6B7280'} />
                </g>
              );
            })}
            {/* الوصلة الأخيرة إلى «معتمد» */}
            {ordered.length > 0 && (() => {
              const last = live(ordered[ordered.length - 1], ordered.length - 1);
              const a = outOf(last);
              const ex = Math.max(EDGE_X, last.x - STEP) + NODE_W;
              return <path d={edgePath(a.x, a.y, ex, last.y + NODE_H / 2)} fill="none" stroke="#22C55E" strokeWidth={2} />;
            })()}
          </svg>

          {/* عقدة المندوب — ثابتة، نقطة البداية لا صفّ في الجدول */}
          <div
            className="absolute rounded-2xl border-2 text-center px-2 py-2.5 select-none"
            style={{ left: repX, top: REP_Y, width: NODE_W, borderColor: '#3F3F52', background: '#1C1C28' }}
          >
            <Avatar color={REP_COLOR} name={null} />
            <p className="text-xs font-bold text-white mt-1.5">{tr('المندوب')}</p>
            <p className="text-[10px] text-[#8B8BA0] mt-0.5">{tr('يرفع التقرير')}</p>
          </div>

          {/* العقد */}
          {ordered.map((n, i) => {
            const p = live(n, i);
            const broken = !n.ownerAdminId;
            const c = colorOf(n, i);
            return (
              <div
                key={n.id}
                onPointerDown={e => startDrag(e, n, i)}
                // الحارس القديم كان يقرأ drag بعد أن صُفّرت في pointerup فلا يمنع
                // شيئاً: كل سحبةٍ كانت تفتح المحرّر أو تُغلقه فتضيع تعديلاتٌ لم تُحفظ
                onClick={() => { if (!movedRef.current) { setSel(sel === n.id ? null : n.id); setAdding(null); } }}
                className={`absolute rounded-2xl border-2 text-center px-2 py-2.5 cursor-grab active:cursor-grabbing select-none transition-shadow
                  ${sel === n.id ? 'shadow-lg' : ''}`}
                style={{
                  left: p.x, top: p.y, width: NODE_W,
                  borderColor: sel === n.id ? '#E15A30' : broken ? '#EF4444' : '#3F3F52',
                  background: '#1C1C28',
                }}
              >
                <span className="absolute top-1 right-2 text-[9px] text-[#6B7280] font-mono">{n.seq}</span>
                <Avatar color={c} name={n.ownerName} />
                <p className="text-xs font-bold text-white mt-1.5 truncate" title={n.ownerName || ''}>
                  {n.ownerName || tr('بلا مستقبل')}
                </p>
                <p className="text-[10px] text-[#8B8BA0] mt-0.5 truncate" title={n.name}>{n.name}</p>
                {n.kind === 'ENTER' && (
                  <span className="inline-block mt-1 text-[9px] rounded px-1.5 py-0.5 bg-[#26263A] text-[#A5B4FC]">{tr('يسجل بياناته')}</span>
                )}
              </div>
            );
          })}

          {/* نهاية المسار */}
          {ordered.length > 0 && (() => {
            const last = live(ordered[ordered.length - 1], ordered.length - 1);
            return (
              <div
                className="absolute rounded-2xl border-2 border-dashed text-center px-2 py-2.5 select-none"
                style={{ left: Math.max(EDGE_X, last.x - STEP), top: last.y, width: NODE_W, borderColor: '#22C55E44', background: '#16211A' }}
              >
                <div className="flex justify-center items-center h-[42px]"><Check size={26} className="text-[#22C55E]" /></div>
                <p className="text-xs font-bold text-white mt-1.5">{tr('معتمد')}</p>
                <p className="text-[10px] text-[#8B8BA0] mt-0.5">{tr('يدخل التقرير الشامل')}</p>
              </div>
            );
          })()}

          {/* لوحة فارغة */}
          {ordered.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
              <Maximize2 size={26} className="text-[#3F3F52]" />
              <p className="text-sm text-[#8B8BA0]">{tr('اللوحة فارغة — أضف أول عقدة ليبدأ مسار الاعتماد')}</p>
              <p className="text-xs text-[#6B7280]">{tr('لن يستطيع المندوب رفع تقريره قبل وجود عقدة واحدة على الأقل')}</p>
            </div>
          )}
        </div>
      </div>

      {adding && (
        <AddNode
          people={people}
          index={ordered.length}
          afterSeq={adding.afterSeq}
          suggestedPos={{ x: defaultXFor(repXFor(ordered.length + 1), ordered.length), y: REP_Y }}
          onCancel={() => setAdding(null)}
          onAdd={(adminId, name, color, pos) => { onAdd(adding.afterSeq, adminId, name, color, pos); setAdding(null); }}
        />
      )}

      {selected && (
        <NodeEditor
          key={selected.id}
          node={selected}
          index={ordered.findIndex(n => n.id === selected.id)}
          people={people} reps={reps}
          onUpdate={patch => onUpdate(selected.id, patch)}
          onOwner={(adminId, repIds) => onOwner(selected.id, adminId, repIds)}
          onDelete={() => { onDelete(selected.id); setSel(null); }}
          onClose={() => setSel(null)}
        />
      )}
    </div>
  );
}

function AddNode({ people, index, afterSeq, suggestedPos, onAdd, onCancel }: {
  people: Person[]; index: number; afterSeq: number | null;
  suggestedPos: { x: number; y: number };
  onAdd: (adminId: string, name: string, color: string, pos: { x: number; y: number }) => void;
  onCancel: () => void;
}) {
  const tr = useTr();
  const [adminId, setAdminId] = useState('');
  const [name, setName] = useState('');
  const color = PALETTE[index % PALETTE.length];
  const person = people.find(p => p.id === adminId);

  return (
    <div className="card border-2 border-[#E15A30]">
      <div className="flex items-center justify-between mb-3">
        <p className="font-bold text-sm">{tr('عقدة جديدة')}</p>
        <button onClick={onCancel} className="text-[#6E6557]"><X size={16} /></button>
      </div>
      <div className="flex gap-3 flex-wrap items-end">
        <div>
          <label className="label text-xs">{tr('الشخص')}</label>
          <select className="input w-52" value={adminId} onChange={e => setAdminId(e.target.value)}>
            <option value="">{tr('اختر مستخدما')}</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label text-xs">{tr('صفته في المسار')}</label>
          <input className="input w-52" value={name} onChange={e => setName(e.target.value)} placeholder={tr('مشرف المبيعات')} />
        </div>
        <button
          className="btn-primary" disabled={!adminId}
          onClick={() => onAdd(adminId, name.trim() || person?.name || tr('مستوى'), color, suggestedPos)}
        >
          <Plus size={16} /> {tr('إضافة')}
        </button>
      </div>
      <p className="text-xs text-[#6E6557] mt-2">
        {afterSeq ? tr('تضاف في آخر المسار') : tr('تُدرج مباشرة بعد المندوب')}
      </p>
    </div>
  );
}

function NodeEditor({ node, index, people, reps, onUpdate, onOwner, onDelete, onClose }: {
  node: CanvasNode; index: number; people: Person[]; reps: Person[];
  onUpdate: (patch: Record<string, unknown>) => void;
  onOwner: (adminId: string, repIds: string[]) => void;
  onDelete: () => void; onClose: () => void;
}) {
  const tr = useTr();
  const [name, setName] = useState(node.name);
  const [adminId, setAdminId] = useState(node.ownerAdminId || '');
  const [repIds, setRepIds] = useState<string[]>(node.repIds);
  const color = colorOf(node, index);

  return (
    <div className="card border-2 border-[#E15A30] space-y-3">
      <div className="flex items-center gap-2.5 flex-wrap">
        <Avatar color={color} name={node.ownerName} size={30} />
        <p className="font-bold text-sm">{node.ownerName || tr('بلا مستقبل')}</p>
        <span className="text-xs text-[#6E6557]">{tr('الترتيب')} {node.seq}</span>
        <span className="flex-1" />
        <button onClick={onDelete} className="btn-secondary text-xs text-red-600"><Trash2 size={13} /> {tr('حذف العقدة')}</button>
        <button onClick={onClose} className="btn-secondary text-xs"><X size={13} /> {tr('إغلاق')}</button>
      </div>

      <div className="flex gap-3 flex-wrap items-end">
        <div>
          <label className="label text-xs">{tr('الشخص')}</label>
          <select className="input w-48" value={adminId} onChange={e => setAdminId(e.target.value)}>
            <option value="">{tr('اختر مستخدما')}</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label text-xs">{tr('صفته في المسار')}</label>
          <input
            className="input w-48" value={name} onChange={e => setName(e.target.value)}
            onBlur={() => { const n = name.trim(); if (n && n !== node.name) onUpdate({ name: n }); else setName(node.name); }}
          />
        </div>
        <div>
          <label className="label text-xs">{tr('دوره')}</label>
          <select className="input w-44" value={node.kind} onChange={e => onUpdate({ kind: e.target.value })}>
            <option value="REVIEW">{tr('يراجع ويعتمد')}</option>
            <option value="ENTER">{tr('يسجل بياناته ثم يعتمد')}</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-[#6E6557]">{tr('اللون')}</span>
        {PALETTE.map(c => (
          <button
            key={c} onClick={() => onUpdate({ color: c })} title={c}
            className={`w-6 h-6 rounded-full border-2 ${color.toLowerCase() === c.toLowerCase() ? 'border-[#E15A30]' : 'border-[#E9E1D3]'}`}
            style={{ background: c }}
          />
        ))}
      </div>

      <div>
        <p className="text-xs font-semibold mb-1">{tr('يستقبل تقارير')}</p>
        <p className="text-[11px] text-[#6E6557] mb-1.5">{tr('اتركها فارغة ليستقبل تقارير كل المناديب')}</p>
        <select
          multiple className="input w-full h-24 text-xs" value={repIds}
          onChange={e => setRepIds([...e.target.selectedOptions].map(o => o.value))}
        >
          {reps.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      <button className="btn-primary text-xs" disabled={!adminId} onClick={() => onOwner(adminId, repIds)}>
        {tr('حفظ')}
      </button>
    </div>
  );
}
