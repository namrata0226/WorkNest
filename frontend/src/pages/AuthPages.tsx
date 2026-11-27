import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { api, applyServerErrors, errorCode, errorMessage, errorMeta } from '../api/client';
import { Avatar } from '../components/Avatar';
import { Button, Card, cx, Field, Input, Modal, Note, PageHeader, PasswordInput, StatusBadge, useConfirm, useToast } from '../components/ui';
import { Icon } from '../components/icons';
import { LoginChallenge, OtpSent, useAuth } from '../context/AuthContext';
import { AuthLayout } from '../layouts/AppLayout';
import { uploadAvatar } from '../services/download';
import { SelfService } from './SelfServicePage';
import { EmployeeFormModal } from './admin/EmployeesPage';
import { formatDate } from '../utils/date';
import type { Employee } from '../types';
import { ROLE_LABEL, titleCase } from '../utils/labels';
import { changePasswordSchema, forgotSchema, LoginForm, loginSchema, ProfileForm, profileSchema, resetSchema } from '../validations';

/** Seconds until a moment, ticking once a second. Zero once it has passed or when there is none. */
function useSecondsUntil(iso: string | null): number {
  const left = () => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000)) : 0);
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    setSeconds(left());
    if (!iso) return;
    const timer = window.setInterval(() => {
      const next = left();
      setSeconds(next);
      if (next === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso]);
  return seconds;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

const OTP_LENGTH = 6;

/** Six boxes for the code: typing moves along, Backspace moves back, and pasting fills them all. */
function OtpInput({ value, onChange, onComplete, disabled, invalid }: { value: string; onChange: (v: string) => void; onComplete: (v: string) => void; disabled?: boolean; invalid?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const focusAt = (i: number) => refs.current[Math.max(0, Math.min(OTP_LENGTH - 1, i))]?.focus();
  const digits = Array.from({ length: OTP_LENGTH }, (_, i) => value[i] ?? '');

  const setFrom = (start: number, typed: string) => {
    const clean = typed.replace(/\D/g, '');
    if (!clean) return;
    const next = (value.slice(0, start) + clean).slice(0, OTP_LENGTH);
    onChange(next);
    focusAt(next.length);
    if (next.length === OTP_LENGTH) onComplete(next);
  };

  return (
    <div className="flex justify-center gap-2 sm:gap-2.5" onPaste={(e) => { e.preventDefault(); setFrom(0, e.clipboardData.getData('text')); }}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          aria-label={`Digit ${i + 1} of ${OTP_LENGTH}`}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={OTP_LENGTH}
          disabled={disabled}
          autoFocus={i === 0}
          value={d}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setFrom(i, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault();
              const at = d ? i : i - 1;
              if (at < 0) return;
              onChange(value.slice(0, at));
              focusAt(at);
            } else if (e.key === 'ArrowLeft') focusAt(i - 1);
            else if (e.key === 'ArrowRight') focusAt(i + 1);
          }}
          className={cx(
            'h-12 w-10 rounded-xl border bg-surface text-center text-[22px] font-semibold tabular-nums outline-none transition-all sm:h-14 sm:w-12',
            'focus:border-brand focus:ring-4 focus:ring-brand/15',
            invalid ? 'border-rose/60 text-rose' : d ? 'border-brand/50' : 'border-line-strong',
            disabled && 'opacity-60',
          )}
        />
      ))}
    </div>
  );
}

/** A round icon above each sign-in step. */
const StepIcon = ({ name }: { name: 'mail' | 'shield' }) => (
  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-brand ring-8 ring-brand-soft/40">
    <Icon name={name} size={26} />
  </div>
);

type Step = 'password' | 'send' | 'code';

export function LoginPage() {
  const { user, ready, login, sendOtp, verifyOtp } = useAuth();
  const [step, setStep] = useState<Step>('password');
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [sent, setSent] = useState<OtpSent | null>(null);
  const [resendAt, setResendAt] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

  const lockSeconds = useSecondsUntil(lockedUntil);
  const resendSeconds = useSecondsUntil(resendAt);
  const codeSeconds = useSecondsUntil(sent?.codeExpiresAt ?? null);

  // Signing in sets the user, and every sign-in lands on the home screen, whatever page sent them here.
  if (ready && user) return <Navigate to="/" replace />;

  const restart = (message: string | null) => {
    setStep('password');
    setChallenge(null);
    setSent(null);
    setResendAt(null);
    setCode('');
    setError(message);
  };

  /** Errors that end this sign-in send the person back to the password step. */
  const handleError = (err: unknown) => {
    const codeName = errorCode(err);
    const meta = errorMeta(err);
    if (codeName === 'ACCOUNT_LOCKED') {
      restart(null);
      setLockedUntil(typeof meta.lockedUntil === 'string' ? meta.lockedUntil : null);
      return;
    }
    if (codeName === 'LOGIN_CHALLENGE_EXPIRED' || codeName === 'OTP_SEND_LIMIT') return restart(errorMessage(err));
    if (codeName === 'OTP_RESEND_WAIT' && typeof meta.resendAt === 'string') setResendAt(meta.resendAt);
    setError(errorMessage(err));
  };

  const onPassword = async (values: LoginForm) => {
    setError(null);
    try {
      const next = await login(values.email, values.password);
      setLockedUntil(null);
      setChallenge(next);
      setStep('send');
    } catch (err) {
      handleError(err);
    }
  };

  const onSend = async (again = false) => {
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      const result = await sendOtp(challenge.challengeToken);
      setSent(result);
      setResendAt(result.resendAt);
      setCode('');
      setResent(again);
      setStep('code');
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async (value = code) => {
    if (!challenge || busy) return;
    if (value.length !== OTP_LENGTH) return setError('Enter all 6 digits of the code');
    setError(null);
    setBusy(true);
    try {
      await verifyOtp(challenge.challengeToken, value);
    } catch (err) {
      setCode('');
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const locked = lockSeconds > 0;
  const backLink = <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-ink" onClick={() => restart(null)}><Icon name="chevronLeft" size={14} />Back to sign in</button>;

  if (step === 'send' && challenge) {
    return (
      <AuthLayout title="Verify it's you" subtitle="One more step to keep your account safe">
        <div className="space-y-4 text-center">
          <StepIcon name="mail" />
          {error && <div className="text-left"><Note>{error}</Note></div>}
          <div className="rounded-xl border border-line bg-paper/60 px-4 py-3">
            <div className="text-xs text-muted">We'll email a 6-digit code to</div>
            <div className="mt-0.5 text-[15px] font-semibold">{challenge.destination}</div>
          </div>
          <Button variant="primary" className="w-full" loading={busy} disabled={resendSeconds > 0} onClick={() => onSend(false)}>
            {resendSeconds > 0 ? `Send OTP in ${clock(resendSeconds)}` : 'Send OTP'}
          </Button>
          <div className="flex items-center justify-center gap-4">
            {sent && <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => { setError(null); setStep('code'); }}>I already have a code</button>}
            {backLink}
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (step === 'code' && challenge && sent) {
    return (
      <AuthLayout title="Enter your code" subtitle="Check your inbox for the 6-digit code">
        <form className="space-y-5 text-center" onSubmit={(e) => { e.preventDefault(); void onVerify(); }} noValidate>
          <StepIcon name="shield" />
          <p className="text-[13px] text-muted">
            {resent ? 'A new code was sent to ' : 'We sent a code to '}
            <span className="font-semibold text-ink">{sent.destination}</span>
          </p>
          {error && <div className="text-left"><Note>{error}</Note></div>}
          <OtpInput value={code} onChange={(v) => { setCode(v); if (error) setError(null); }} onComplete={(v) => void onVerify(v)} disabled={busy} invalid={Boolean(error)} />
          <p className={cx('text-xs tabular-nums', codeSeconds > 0 ? 'text-muted' : 'text-rose')} aria-live="polite">
            {codeSeconds > 0 ? <>Code expires in <span className="font-semibold">{clock(codeSeconds)}</span></> : 'This code has expired. Ask for a new one.'}
          </p>
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={code.length !== OTP_LENGTH}>Verify OTP</Button>
          <div className="rounded-xl bg-paper/60 px-4 py-3 text-xs text-muted">
            Didn't get it? Check your spam folder, or{' '}
            {resendSeconds > 0 ? (
              <span aria-live="polite">resend in <span className="font-semibold tabular-nums text-ink">{clock(resendSeconds)}</span></span>
            ) : (
              <button type="button" className="font-semibold text-brand hover:underline" disabled={busy} onClick={() => void onSend(true)}>resend OTP</button>
            )}
          </div>
          <div>{backLink}</div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Sign in" subtitle="Use your work email">
      <form className="space-y-3" onSubmit={handleSubmit(onPassword)} noValidate>
        {locked ? (
          <Note tone="amber">
            <span className="font-medium">Account locked after too many failed attempts.</span> You can try again in <span className="font-semibold tabular-nums" aria-live="polite">{clock(lockSeconds)}</span>.
          </Note>
        ) : lockedUntil ? (
          <Note tone="green">Your account is unlocked. You can sign in now.</Note>
        ) : error && <Note>{error}</Note>}
        <Field label="Email" error={errors.email?.message}>
          <Input type="email" autoComplete="username" autoFocus {...register('email')} />
        </Field>
        <Field label="Password" error={errors.password?.message}>
          <PasswordInput autoComplete="current-password" {...register('password')} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={isSubmitting} disabled={locked}>
          {locked ? `Locked · ${clock(lockSeconds)}` : 'Sign in'}
        </Button>
        <p className="text-center text-xs"><Link className="text-brand hover:underline" to="/forgot-password">Forgot your password?</Link></p>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<{ email: string }>({ resolver: zodResolver(forgotSchema) });

  const onSubmit = async (values: { email: string }) => {
    setError(null);
    try {
      const res = await api.post('/auth/forgot-password', values);
      setSent(res.data.data.message);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuthLayout title="Reset your password" subtitle="We will email you a one-time link">
      {sent ? (
        <Note tone="green">{sent}</Note>
      ) : (
        <form className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
          {error && <Note>{error}</Note>}
          <Field label="Email" error={errors.email?.message}><Input type="email" autoFocus {...register('email')} /></Field>
          <Button type="submit" variant="primary" className="w-full" loading={isSubmitting}>Send reset link</Button>
        </form>
      )}
      <p className="mt-3 text-center text-xs"><Link className="text-brand hover:underline" to="/login">Back to sign in</Link></p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema) });

  const onSubmit = async (values: z.infer<typeof resetSchema>) => {
    setError(null);
    try {
      await api.post('/auth/reset-password', { token, password: values.password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuthLayout title="Set a new password">
      {done ? (
        <Note tone="green">Your password is set. <Link className="underline" to="/login">Sign in</Link>.</Note>
      ) : !token ? (
        <Note>This link is missing its token. Ask for a new one.</Note>
      ) : (
        <form className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
          {error && <Note>{error}</Note>}
          <Field label="New password" hint="At least 10 characters, with a letter and a number" error={errors.password?.message}>
            <PasswordInput autoComplete="new-password" autoFocus {...register('password')} />
          </Field>
          <Field label="Confirm password" error={errors.confirm?.message}>
            <PasswordInput autoComplete="new-password" {...register('confirm')} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={isSubmitting}>Save password</Button>
        </form>
      )}
    </AuthLayout>
  );
}

const PROFILE_FIELDS = ['fullName', 'phone'] as const;

function EditProfileModal({ employee, onClose, onSaved }: { employee: Employee; onClose: () => void; onSaved: () => Promise<void> }) {
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: { fullName: employee.fullName, phone: employee.phone ?? '' },
  });

  const onSubmit = async (v: ProfileForm) => {
    setFormError(null);
    try {
      await api.patch('/employees/me', { fullName: v.fullName, phone: v.phone || null });
      await onSaved();
    } catch (err) {
      setFormError(applyServerErrors(err, setError, PROFILE_FIELDS));
    }
  };

  return (
    <Modal
      title="Edit profile"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="profile-form" loading={isSubmitting}>Save changes</Button></>}
    >
      <form id="profile-form" className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
        {formError && <Note>{formError}</Note>}
        <Field label="Full name" required error={errors.fullName?.message}><Input {...register('fullName')} /></Field>
        <Field label="Phone" error={errors.phone?.message}><Input type="tel" autoComplete="tel" {...register('phone')} /></Field>
        <p className="text-xs text-muted">Ask HR to change anything else, including your email, gender or team.</p>
      </form>
    </Modal>
  );
}

function ProfilePhoto() {
  const { user, refreshProfile } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const hasPhoto = Boolean(user?.avatarUrl);
  const removePhoto = async () => {
    if (!(await confirm({ title: 'Remove your profile photo?', message: 'Your initials will show instead. You can add a new photo at any time.', confirmLabel: 'Remove photo', tone: 'danger' }))) return;
    await run(() => api.delete('/me/avatar'), 'Profile photo removed');
  };

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      await refreshProfile();
      toast(done);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="mb-4 flex items-center gap-4 border-b border-line pb-4">
      <Avatar url={user?.avatarUrl} name={user?.employee?.fullName ?? user?.email ?? ''} size="large" />
      <div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden aria-label="Choose a profile photo" onChange={(ev) => { const file = ev.target.files?.[0]; if (file) void run(() => uploadAvatar(file), hasPhoto ? 'Profile photo changed' : 'Profile photo added'); }} />
        <div className="flex flex-wrap gap-2">
          <Button small loading={busy} onClick={() => fileRef.current?.click()}>{hasPhoto ? 'Change photo' : 'Add photo'}</Button>
          {hasPhoto && <Button small disabled={busy} onClick={() => removePhoto()}>Remove photo</Button>}
        </div>
        <p className="mt-1.5 text-xs text-faint">PNG or JPEG, up to 2 MB</p>
      </div>
    </div>
  );
}

export function AccountPage() {
  const { user, refreshProfile, can } = useAuth();
  // People who manage employees can already change every detail on the People page, including their own.
  const canEditAll = can('employees:write');
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<z.infer<typeof changePasswordSchema>>({ resolver: zodResolver(changePasswordSchema) });
  const e = user?.employee;

  const onSubmit = async (values: z.infer<typeof changePasswordSchema>) => {
    setError(null);
    try {
      await api.post('/auth/change-password', { currentPassword: values.currentPassword, newPassword: values.newPassword });
      reset();
      await refreshProfile();
      toast('Password changed. Your other devices were signed out.');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const rows: [string, React.ReactNode][] = e
    ? [
        ['Employee ID', e.employeeId], ['Name', e.fullName], ['Email', e.email], ['Phone', e.phone ?? '—'], ['Gender', e.gender ? titleCase(e.gender) : 'Not recorded'],
        ['Team', e.department?.name ?? '—'], ['Designation', e.designation ?? '—'], ['Reporting manager', e.reportingManager?.fullName ?? '—'],
        ['Location', e.location?.name ?? '—'], ['Joined', formatDate(e.joiningDate)], ['Status', <StatusBadge key="s" status={e.employmentStatus} />],
      ]
    : [['Email', user?.email], ['Role', ROLE_LABEL[user?.role ?? ''] ?? user?.role]];

  return (
    <>
      <PageHeader title="My account" subtitle={e ? (canEditAll ? 'You can update all of your details.' : 'You can update your name and phone. Ask HR to correct anything else, including your gender or email.') : 'Ask HR to correct anything here.'} />
      {user?.mustChangePassword && <div className="mb-4"><Note tone="amber">Change your temporary password to continue using WorkNest.</Note></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Profile" actions={e && <Button small onClick={() => setEditing(true)}>Edit profile</Button>}>
          <ProfilePhoto />
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[13px]">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Change password">
          <form className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
            {error && <Note>{error}</Note>}
            <Field label="Current password" error={errors.currentPassword?.message}><PasswordInput autoComplete="current-password" {...register('currentPassword')} /></Field>
            <Field label="New password" hint="At least 10 characters, with a letter and a number" error={errors.newPassword?.message}><PasswordInput autoComplete="new-password" {...register('newPassword')} /></Field>
            <Field label="Confirm password" error={errors.confirm?.message}><PasswordInput autoComplete="new-password" {...register('confirm')} /></Field>
            <Button type="submit" variant="primary" loading={isSubmitting}>Change password</Button>
          </form>
        </Card>
      </div>
      {e && <SelfService />}
      {editing && e && canEditAll && (
        <EmployeeFormModal
          employee={e as Employee}
          onClose={() => setEditing(false)}
          onSaved={async () => { await refreshProfile(); setEditing(false); toast('Profile updated'); }}
        />
      )}
      {editing && e && !canEditAll && (
        <EditProfileModal
          employee={e}
          onClose={() => setEditing(false)}
          onSaved={async () => { await refreshProfile(); setEditing(false); toast('Profile updated'); }}
        />
      )}
    </>
  );
}
