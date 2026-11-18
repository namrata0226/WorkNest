import { useState } from 'react';
import { errorMessage } from '../api/client';
import { deleteDocument, uploadDocument } from '../services/download';
import { Button, Field, Input } from './ui';

export interface AttachedDocument { id: string; originalName: string }

// The upload happens on selection, so anything no longer wanted is deleted rather than left in storage.
// A failed delete is not shown: the file is already off the form and can never reach a request.
const discard = (doc: AttachedDocument | null) => {
  if (doc) void deleteDocument(doc.id).catch(() => undefined);
};

export function DocumentUpload({ label = 'Supporting document', value, onChange, onUploadingChange, required, error }: {
  label?: string;
  value: AttachedDocument | null;
  onChange: (doc: AttachedDocument | null) => void;
  onUploadingChange?: (uploading: boolean) => void;
  required?: boolean;
  error?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onFile = async (file?: File) => {
    setUploadError(null);
    if (!file) return;
    setUploading(true);
    onUploadingChange?.(true);
    try {
      onChange(await uploadDocument(file));
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
      onUploadingChange?.(false);
    }
  };

  const remove = () => {
    discard(value);
    onChange(null);
  };

  // Kept outside Field: a button inside its <label> would be pressed by any click on the label.
  if (value) {
    return (
      <div>
        <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
        <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate" title={value.originalName}>{value.originalName}</span>
          <Button small aria-label={`Remove ${value.originalName}`} onClick={remove}>Remove</Button>
        </div>
        {error && <span role="alert" className="mt-1 block text-xs text-rose">{error}</span>}
      </div>
    );
  }

  return (
    <Field label={label} required={required} error={uploadError ?? error} hint={uploading ? 'Uploading…' : 'PDF, PNG or JPEG, up to 5 MB'}>
      <Input type="file" accept=".pdf,.png,.jpg,.jpeg" disabled={uploading} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; void onFile(file); }} />
    </Field>
  );
}
