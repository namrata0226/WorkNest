import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { cx } from './ui';

/** A colleague's photo, or just initials when they have not added one. */
export const PersonAvatar = ({ person }: { person: { _id: string; fullName: string; avatarFile?: string | null } }) => (
  <Avatar name={person.fullName} url={person.avatarFile ? `/employees/${person._id}/avatar?v=${person.avatarFile}` : null} />
);

const initials = (name: string) => name.trim().split(/[\s.@]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');

/** Fetched through axios rather than an img src, so an expired session refreshes instead of showing a broken image. */
export function Avatar({ url, name, size = 'small' }: { url?: string | null; name: string; size?: 'small' | 'large' }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    if (!url) return;
    let objectUrl: string | null = null;
    let stale = false;
    api.get(url, { responseType: 'blob' })
      .then((res) => {
        if (stale) return;
        objectUrl = URL.createObjectURL(res.data);
        setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  const box = cx('shrink-0 rounded-full', size === 'large' ? 'h-20 w-20 text-2xl' : 'h-7 w-7 text-[11px]');
  if (src) return <img src={src} alt={`${name}'s profile photo`} className={cx(box, 'object-cover')} />;
  return <span aria-hidden className={cx(box, 'flex items-center justify-center bg-brand-soft font-semibold text-brand')}>{initials(name)}</span>;
}
