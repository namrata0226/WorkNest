import { ButtonHTMLAttributes, createContext, FormEvent, forwardRef, InputHTMLAttributes, MouseEvent, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PageMeta } from '../types';
import { Icon } from './icons';
import { STATUS_LABEL, STATUS_TONE } from '../utils/labels';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white shadow-[0_1px_2px_rgba(10,68,63,0.25),inset_0_1px_0_rgba(255,255,255,0.08)] hover:bg-brand-strong',
  secondary: 'bg-surface border border-line-strong text-ink shadow-[0_1px_2px_rgba(16,24,40,0.05)] hover:bg-paper hover:border-faint/50',
  ghost: 'text-muted hover:bg-paper hover:text-ink',
  danger: 'bg-rose text-white shadow-[0_1px_2px_rgba(180,35,60,0.25)] hover:brightness-95',
};

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  variant?: ButtonVariant;
  loading?: boolean;
  small?: boolean;
  /** Return a promise to keep the button disabled, with a spinner, until it settles. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => unknown;
};

export function Button({ variant = 'secondary', loading, small, className, children, disabled, type = 'button', onClick, ...rest }: ButtonProps) {
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    // `detail` counts rapid clicks: the second click of a double-click is dropped, as is any click while an
    // earlier one is still running. Both can land before React has re-rendered the button as disabled.
    if (running.current || e.detail > 1) {
      e.preventDefault();
      return;
    }
    const result = onClick?.(e);
    if (result instanceof Promise) {
      running.current = true;
      setPending(true);
      void result.catch(() => undefined).finally(() => {
        running.current = false;
        if (mounted.current) setPending(false);
      });
    }
  };

  const busy = loading || pending;
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={handleClick}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-y-0 whitespace-nowrap', small ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-[13px]', BUTTON[variant], className)}
      {...rest}
    >
      {busy && <Spinner small />}
      {children}
    </button>
  );
}

/** Wraps an async handler so it cannot run again until the previous call has finished. For triggers that are not a Button. */
export function useSingleFlight<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(fn);
  ref.current = fn;
  const run = useCallback(async (...args: A) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await ref.current(...args);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return [run, busy] as const;
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

/** A number with its label. With `onClick` it becomes a button that opens the list behind the number. */
export function Stat({ label, value, hint, tone, onClick, actionLabel = 'View list' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'brand' | 'amber'; onClick?: () => void; actionLabel?: string }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[12px] font-medium text-muted">{label}</div>
        {onClick && <Icon name="chevronRight" size={15} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />}
      </div>
      <div className={cx('tnum mt-1.5 text-[24px] font-semibold leading-tight tracking-tight', tone === 'brand' && 'text-brand', tone === 'amber' && 'text-amber')}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-faint">{hint}</div>}
      {onClick && <div className="mt-1.5 text-[11.5px] font-medium text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{actionLabel} →</div>}
    </>
  );
  const box = 'rounded-xl border border-line bg-surface px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-all hover:shadow-[0_4px_14px_-6px_rgba(16,24,40,0.12)]';
  if (!onClick) return <div className={box}>{body}</div>;
  return (
    <button type="button" onClick={onClick} aria-label={`${label}: ${typeof value === 'string' || typeof value === 'number' ? value : ''}. ${actionLabel}`} className={cx(box, 'group flex w-full cursor-pointer flex-col items-stretch justify-start text-left hover:-translate-y-px hover:border-brand/40')}>
      {body}
    </button>
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

/** A password field with an eye button that shows or hides what has been typed. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...rest }, ref) => {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input ref={ref} type={visible ? 'text' : 'password'} className={cx(CONTROL, 'w-full pr-10', className)} {...rest} />
      <button
        type="button"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        // Keeps focus (and the caret) in the field while toggling.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted hover:text-ink focus-visible:text-ink"
      >
        <Icon name={visible ? 'eyeOff' : 'eye'} size={17} />
      </button>
    </div>
  );
});
PasswordInput.displayName = 'PasswordInput';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...rest }, ref) => <select ref={ref} className={cx(CONTROL, 'select-control', controlWidth(className), className)} {...rest}>{children}</select>);
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
/** Open modals, innermost last, so Escape closes only the one on top. */
const modalStack: number[] = [];
let nextModalId = 1;

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const id = nextModalId++;
    modalStack.push(id);
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === id) onClose();
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      modalStack.splice(modalStack.indexOf(id), 1);
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

/**
 * Sits after a list and loads the next page as it scrolls into view, so lists grow instead of paging.
 * A button is kept for keyboard users and browsers without IntersectionObserver.
 */
export function InfiniteLoader({ list, noun = 'records' }: { list: { meta: PageMeta | null; hasMore: boolean; loading: boolean; loadingMore: boolean; loadMore: () => void; data: unknown }; noun?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { hasMore, loading, loadingMore, loadMore, meta } = list;
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore || loading || typeof IntersectionObserver === 'undefined') return;
    // Starts loading a little before the end is reached, so scrolling rarely has to wait.
    const observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '0px 0px 320px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore, meta?.page]);

  if (!meta || meta.total === 0) return null;
  return (
    <div ref={ref} className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-xs text-muted" aria-live="polite">
      {loadingMore ? (
        <><Spinner small /><span>Loading more…</span></>
      ) : hasMore ? (
        <button type="button" onClick={loadMore} className="rounded-md px-2 py-1 font-medium text-brand hover:bg-brand-soft">Load more</button>
      ) : (
        <span className="tnum">{meta.totalPages > 1 ? `All ${meta.total} ${noun} shown` : `${meta.total} ${noun}`}</span>
      )}
    </div>
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
type ToastTone = 'ok' | 'error' | 'info';
interface Toast { id: number; message: string; tone: ToastTone }
const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

const TOAST_STYLE: Record<ToastTone, { icon: string; accent: string; label: string }> = {
  ok: { icon: '✓', accent: 'bg-brand text-white', label: 'Success' },
  error: { icon: '!', accent: 'bg-rose text-white', label: 'Error' },
  info: { icon: 'i', accent: 'bg-sky text-white', label: 'Notice' },
};

/** Also hosts the confirmation dialog, so anything that can toast can ask for confirmation too. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const show = useCallback((message: string, tone: ToastTone = 'ok') => {
    const id = nextId.current++;
    // A message already on screen (e.g. a repeated failure) is not stacked a second time. At most four show at once.
    setToasts((t) => (t.some((x) => x.message === message && x.tone === tone) ? t : [...t.slice(-3), { id, message, tone }]));
    setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4000);
  }, [dismiss]);
  return (
    <ToastContext.Provider value={show}>
      <ConfirmProvider>{children}</ConfirmProvider>
      {/* Bottom centre on phones, top right from the sm breakpoint up. */}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col-reverse items-center gap-2 px-4 sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-4 sm:flex-col sm:items-end sm:px-0">
        {toasts.map((t) => {
          const style = TOAST_STYLE[t.tone];
          return (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="toast-in pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border border-line bg-surface py-3 pl-3.5 pr-2 text-[13px] text-ink shadow-xl ring-1 ring-black/5 sm:w-80">
              <span aria-hidden className={cx('mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold', style.accent)}>{style.icon}</span>
              <span className="min-w-0 flex-1 break-words pt-px"><span className="sr-only">{style.label}: </span>{t.message}</span>
              <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="shrink-0 rounded-md px-1 text-faint hover:bg-paper hover:text-ink">✕</button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/* Confirmation dialog */
export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger styles the confirm button red. Use it for anything destructive or hard to undo. */
  tone?: 'danger' | 'primary';
}

export interface PromptOptions extends ConfirmOptions {
  label: string;
  type?: 'text' | 'date';
  defaultValue?: string;
  required?: boolean;
  hint?: ReactNode;
}

interface DialogApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
}

const ConfirmContext = createContext<DialogApi>({
  confirm: async () => false,
  prompt: async () => null,
});

/** `const ok = await confirm({ title: 'Delete holiday?', tone: 'danger' })`: resolves false if dismissed. */
export const useConfirm = () => useContext(ConfirmContext).confirm;
/** Like confirm, with one input. Resolves to the entered value, or null if dismissed. */
export const usePrompt = () => useContext(ConfirmContext).prompt;

type Pending = { options: PromptOptions | ConfirmOptions; withInput: boolean; resolve: (value: string | boolean | null) => void };

function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const api = useMemo<DialogApi>(() => ({
    confirm: (options) => new Promise<boolean>((resolve) => {
      setPending((current) => {
        current?.resolve(current.withInput ? null : false);
        return { options, withInput: false, resolve: (v) => resolve(v === true) };
      });
    }),
    prompt: (options) => new Promise<string | null>((resolve) => {
      setPending((current) => {
        current?.resolve(current.withInput ? null : false);
        return { options, withInput: true, resolve: (v) => resolve(typeof v === 'string' ? v : null) };
      });
    }),
  }), []);

  const settle = (value: string | boolean | null) => {
    pending?.resolve(value);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      {pending && <ConfirmDialog key={pending.options.title} pending={pending} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ pending, onSettle }: { pending: Pending; onSettle: (value: string | boolean | null) => void }) {
  const { options, withInput } = pending;
  const input = withInput ? (options as PromptOptions) : null;
  const [value, setValue] = useState(input?.defaultValue ?? '');
  const [touched, setTouched] = useState(false);
  const missing = Boolean(input?.required) && !value.trim();
  const formId = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (missing) return;
    onSettle(input ? value.trim() : true);
  };
  const cancel = () => onSettle(input ? null : false);

  return (
    <Modal
      title={options.title}
      onClose={cancel}
      footer={(
        <>
          <Button onClick={cancel}>{options.cancelLabel ?? 'Cancel'}</Button>
          <Button type="submit" form={formId} variant={options.tone === 'danger' ? 'danger' : 'primary'}>{options.confirmLabel ?? 'Confirm'}</Button>
        </>
      )}
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-3">
        {options.message && <div className="text-[13px] text-muted">{options.message}</div>}
        {input && (
          <Field label={input.label} required={input.required} hint={input.hint} error={touched && missing ? `${input.label} is required` : undefined}>
            <Input autoFocus type={input.type ?? 'text'} value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        )}
      </form>
    </Modal>
  );
}
