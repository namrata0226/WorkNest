import type { CalendarItemColor } from '../../types';

/** Light card, strong title and accent per colour, matching the app palette. Violet and slate fill the gaps. */
export const TONES: Record<CalendarItemColor | 'holiday', { label: string; card: string; title: string; accent: string; swatch: string; dot: string }> = {
  brand: { label: 'Green', card: 'bg-brand-soft', title: 'text-brand-strong', accent: 'border-t-brand', swatch: 'bg-brand', dot: 'bg-brand' },
  sky: { label: 'Blue', card: 'bg-sky-soft', title: 'text-sky', accent: 'border-t-sky', swatch: 'bg-sky', dot: 'bg-sky' },
  violet: { label: 'Purple', card: 'bg-[#f2eefd]', title: 'text-[#5a3fc0]', accent: 'border-t-[#7c5ce6]', swatch: 'bg-[#7c5ce6]', dot: 'bg-[#7c5ce6]' },
  amber: { label: 'Orange', card: 'bg-amber-soft', title: 'text-amber', accent: 'border-t-amber', swatch: 'bg-amber', dot: 'bg-amber' },
  rose: { label: 'Red', card: 'bg-rose-soft', title: 'text-rose', accent: 'border-t-rose', swatch: 'bg-rose', dot: 'bg-rose' },
  slate: { label: 'Grey', card: 'bg-paper', title: 'text-ink', accent: 'border-t-faint', swatch: 'bg-muted', dot: 'bg-muted' },
  holiday: { label: 'Holiday', card: 'bg-[#f9e7cf]', title: 'text-[#7c4408]', accent: 'border-t-[#d08a2c]', swatch: 'bg-[#d08a2c]', dot: 'bg-[#d08a2c]' },
};
