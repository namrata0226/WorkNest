import { ButtonHTMLAttributes, createContext, forwardRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { PageMeta } from '../types';
import { STATUS_LABEL, STATUS_TONE } from '../utils/labels';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white shadow-[0_1px_2px_rgba(10,68,63,0.25),inset_0_1px_0_rgba(255,255,255,0.08)] hover:bg-brand-strong',
  secondary: 'bg-surface border border-line-strong text-ink shadow-[0_1px_2px_rgba(16,24,40,0.05)] hover:bg-paper hover:border-faint/50',
  ghost: 'text-muted hover:bg-paper hover:text-ink',
  danger: 'bg-rose text-white shadow-[0_1px_2px_rgba(180,35,60,0.25)] hover:brightness-95',
};

export function Button({ variant = 'secondary', loading, small, className, children, disabled, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean; small?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-y-0 whitespace-nowrap', small ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-[13px]', BUTTON[variant], className)}
      {...rest}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span role="status" aria-label="Loading" className={cx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', small ? 'h-3 w-3' : 'h-5 w-5')} />;
}

export function Card({ title, actions, children, className, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cx('overflow-hidden rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.04)]', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
          <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
          {actions}
        </header>
      )}
      <div className={flush ? '' : 'p-5'}>{children}</div>
    </section>
  );
}

type Tone = 'green' | 'amber' | 'rose' | 'gray' | 'sky';
const TONE: Record<Tone, string> = {
  green: 'bg-brand-soft text-brand-strong',
  amber: 'bg-amber-soft text-amber',
  rose: 'bg-rose-soft text-rose',
  gray: 'bg-paper text-muted ring-1 ring-inset ring-line',
  sky: 'bg-sky-soft text-sky',
};

export function Badge({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap', TONE[tone])}>{children}</span>;
}

export const StatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS_TONE[status] ?? 'gray'}>{STATUS_LABEL[status] ?? status}</Badge>;

export function TypeTag({ type }: { type: { name?: string; code: string; color: string } }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={type.name}>
      <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: type.color }} />
      <span>{type.name ?? type.code}</span>
    </span>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'brand' | 'amber' }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-shadow hover:shadow-[0_4px_14px_-6px_rgba(16,24,40,0.12)]">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={cx('tnum mt-1.5 text-[24px] font-semibold leading-tight tracking-tight', tone === 'brand' && 'text-brand', tone === 'amber' && 'text-amber')}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-faint">{hint}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-[13.5px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Note({ tone = 'rose', children }: { tone?: 'rose' | 'amber' | 'sky' | 'green'; children: ReactNode }) {
  const map = { rose: 'bg-rose-soft text-rose border-rose/15', amber: 'bg-amber-soft text-amber border-amber/15', sky: 'bg-sky-soft text-sky border-sky/15', green: 'bg-brand-soft text-brand-strong border-brand/15' };
  return <div role={tone === 'rose' ? 'alert' : 'status'} className={cx('rounded-lg border px-3.5 py-2.5 text-[13px]', map[tone])}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-[13px] text-faint">{children}</div>;
}

export function Loading() {
  return <div className="flex justify-center py-10 text-brand"><Spinner /></div>;
}

/* Forms */
export function Field({ label, error, hint, children, required }: { label: string; error?: string; hint?: ReactNode; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-ink/80">
        {label}
        {required && <span aria-hidden className="text-rose"> *</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-faint">{hint}</span>}
      {error && <span role="alert" className="mt-1 block text-xs text-rose">{error}</span>}
    </label>
  );
}

/** Full width unless the caller sets its own, as Tailwind's class order would otherwise decide the winner. */
const controlWidth = (className?: string) => (/(^|\s)w-/.test(className ?? '') ? '' : 'w-full');
const CONTROL = 'block rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-shadow placeholder:text-faint hover:border-faint/60 focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/10 focus-visible:outline-none disabled:bg-paper disabled:text-muted';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => <input ref={ref} className={cx(CONTROL, controlWidth(className), className)} {...rest} />);
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...rest }, ref) => <select ref={ref} className={cx(CONTROL, controlWidth(className), className)} {...rest}>{children}</select>);
Select.displayName = 'Select';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => <textarea ref={ref} rows={3} className={cx(CONTROL, controlWidth(className), className)} {...rest} />);
Textarea.displayName = 'Textarea';

export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }>(({ label, ...rest }, ref) => (
  <label className="flex items-center gap-2 text-[13px]">
    <input ref={ref} type="checkbox" className="h-3.5 w-3.5 accent-[var(--color-brand)]" {...rest} />
    <span>{label}</span>
  </label>
));
Checkbox.displayName = 'Checkbox';

/** A compact list of checkboxes that behaves as one multi-value field. */
export function CheckboxGroup({ options, value, onChange }: { options: { value: string; label: string }[]; value: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1.5 overflow-y-auto rounded-md border border-line-strong bg-surface p-2">
      {options.length === 0 && <span className="text-xs text-faint">None available</span>}
      {options.map((o) => (
        <Checkbox
          key={o.value}
          label={o.label}
          checked={value.includes(o.value)}
          onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))}
        />
      ))}
    </div>
  );
}

/* Modal */
export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
    // Only on mount: onClose is usually a new closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#0b1f1c]/45 p-4 backdrop-blur-[2px] sm:p-10" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx('w-full overflow-hidden rounded-2xl bg-surface shadow-2xl ring-1 ring-black/5 focus:outline-none', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-paper hover:text-ink">✕</button>
        </header>
        <div className="p-5">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line bg-paper/50 px-5 py-3.5">{footer}</footer>}
      </div>
    </div>
  );
}

/* Table */
export interface Column<T> {
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'right' | 'center';
  className?: string;
}

export function DataTable<T>({ columns, rows, rowKey, loading, empty = 'Nothing to show yet.', onRowClick }: { columns: Column<T>[]; rows: T[] | null | undefined; rowKey: (row: T) => string; loading?: boolean; empty?: ReactNode; onRowClick?: (row: T) => void }) {
  if (loading && !rows?.length) return <Loading />;
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return (
    <div className={cx('overflow-x-auto', loading && 'opacity-60')}>
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-paper/60 text-[11.5px] uppercase tracking-[0.04em] text-muted">
            {columns.map((c, i) => (
              <th key={i} scope="col" className={cx('whitespace-nowrap px-4 py-2.5 font-semibold', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              className={cx('border-b border-line transition-colors last:border-0 hover:bg-paper/50', onRowClick && 'cursor-pointer hover:bg-brand-soft/40')}
            >
              {columns.map((c, i) => (
                <td key={i} className={cx('px-4 py-3 align-middle', c.align === 'right' && 'tnum text-right', c.align === 'center' && 'text-center', c.className)}>{c.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ meta, onPage }: { meta: PageMeta | null; onPage: (page: number) => void }) {
  if (!meta || meta.totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-muted">
      <span className="tnum">Page {meta.page} of {meta.totalPages} · {meta.total} records</span>
      <span className="flex gap-1.5">
        <Button small disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>Previous</Button>
        <Button small disabled={meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)}>Next</Button>
      </span>
    </nav>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-line bg-paper p-0.5">
      {tabs.map((t) => (
        <button key={t.value} role="tab" type="button" aria-selected={t.value === value} onClick={() => onChange(t.value)} className={cx('rounded-md px-3 py-1 text-[13px] font-medium transition-all', t.value === value ? 'bg-surface text-brand shadow-[0_1px_2px_rgba(16,24,40,0.1)]' : 'text-muted hover:text-ink')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* Toasts */
interface Toast { id: number; message: string; tone: 'ok' | 'error' }
const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const show = useCallback((message: string, tone: Toast['tone'] = 'ok') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 right-4 z-[60] flex max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cx('rounded-xl px-4 py-3 text-[13px] text-white shadow-xl ring-1 ring-black/5', t.tone === 'ok' ? 'bg-nav' : 'bg-rose')}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
