import { zodResolver } from '@hookform/resolvers/zod';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { api, applyServerErrors, errorMessage } from '../api/client';
import { Avatar } from '../components/Avatar';
import { Button, Card, Field, Input, Modal, Note, PageHeader, StatusBadge, useToast } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { AuthLayout } from '../layouts/AppLayout';
import { uploadAvatar } from '../services/download';
import { SelfService } from './SelfServicePage';
import { formatDate } from '../utils/date';
import type { Employee } from '../types';
import { ROLE_LABEL, titleCase } from '../utils/labels';
import { changePasswordSchema, forgotSchema, LoginForm, loginSchema, ProfileForm, profileSchema, resetSchema } from '../validations';

export function LoginPage() {
  const { user, ready, login } = useAuth();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

  // Signing in sets the user, so this is also what returns someone to the page they came for, such as an email link.
  if (ready && user) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />;

  const onSubmit = async (values: LoginForm) => {
    setError(null);
    try {
      await login(values.email, values.password);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <AuthLayout title="Sign in" subtitle="Use your work email">
      <form className="space-y-3" onSubmit={handleSubmit(onSubmit)} noValidate>
        {error && <Note>{error}</Note>}
        <Field label="Email" error={errors.email?.message}>
          <Input type="email" autoComplete="username" autoFocus {...register('email')} />
        </Field>
        <Field label="Password" error={errors.password?.message}>
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={isSubmitting}>Sign in</Button>
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
            <Input type="password" autoComplete="new-password" autoFocus {...register('password')} />
          </Field>
          <Field label="Confirm password" error={errors.confirm?.message}>
            <Input type="password" autoComplete="new-password" {...register('confirm')} />
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
        <Field label="Phone" error={errors.phone?.message}><Input {...register('phone')} /></Field>
      </form>
    </Modal>
  );
}

function ProfilePhoto() {
  const { user, refreshProfile } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const hasPhoto = Boolean(user?.avatarUrl);

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
          {hasPhoto && <Button small disabled={busy} onClick={() => void run(() => api.delete('/me/avatar'), 'Profile photo removed')}>Remove photo</Button>}
        </div>
        <p className="mt-1.5 text-xs text-faint">PNG or JPEG, up to 2 MB</p>
      </div>
    </div>
  );
}

export function AccountPage() {
  const { user, refreshProfile } = useAuth();
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
        ['Department', e.department?.name ?? '—'], ['Designation', e.designation ?? '—'], ['Reporting manager', e.reportingManager?.fullName ?? '—'],
        ['Location', e.location?.name ?? '—'], ['Joined', formatDate(e.joiningDate)], ['Status', <StatusBadge key="s" status={e.employmentStatus} />],
      ]
    : [['Email', user?.email], ['Role', ROLE_LABEL[user?.role ?? ''] ?? user?.role]];

  return (
    <>
      <PageHeader title="My account" subtitle={e ? 'You can update your name and phone. Ask HR to correct anything else, including your gender or email.' : 'Ask HR to correct anything here.'} />
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
            <Field label="Current password" error={errors.currentPassword?.message}><Input type="password" autoComplete="current-password" {...register('currentPassword')} /></Field>
            <Field label="New password" hint="At least 10 characters, with a letter and a number" error={errors.newPassword?.message}><Input type="password" autoComplete="new-password" {...register('newPassword')} /></Field>
            <Field label="Confirm password" error={errors.confirm?.message}><Input type="password" autoComplete="new-password" {...register('confirm')} /></Field>
            <Button type="submit" variant="primary" loading={isSubmitting}>Change password</Button>
          </form>
        </Card>
      </div>
      {e && <SelfService />}
      {editing && e && (
        <EditProfileModal
          employee={e}
          onClose={() => setEditing(false)}
          onSaved={async () => { await refreshProfile(); setEditing(false); toast('Profile updated'); }}
        />
      )}
    </>
  );
}
