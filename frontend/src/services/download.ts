import { api, errorMessage } from '../api/client';

/** Through axios rather than a plain link, so an expired session refreshes instead of downloading an error. */
export async function downloadFile(url: string, params: Record<string, unknown>, fallbackName: string): Promise<void> {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  let res;
  try {
    res = await api.get(url, { params: clean, responseType: 'blob' });
  } catch (err) {
    // With responseType 'blob' the JSON error body arrives as a Blob, so read it before looking for the message.
    const response = (err as { response?: { data?: unknown } }).response;
    if (response?.data instanceof Blob) {
      try {
        response.data = JSON.parse(await response.data.text());
      } catch {
        // Not JSON, so fall back to the status text.
      }
    }
    throw new Error(errorMessage(err, 'The download failed'));
  }
  const disposition = String(res.headers['content-disposition'] ?? '');
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const href = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

export async function uploadDocument(file: File): Promise<{ id: string; originalName: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await api.post('/files', form);
  return res.data.data;
}

export async function deleteDocument(id: string): Promise<void> {
  await api.delete(`/files/${id}`);
}

export async function uploadAvatar(file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  await api.put('/me/avatar', form);
}

export async function uploadImport<T>(url: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const res = await api.post(url, form);
  return res.data.data;
}
