import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { StoredFile, User } from '../src/models';
import { agentFor, Agent, baseline, FRI, fullDay, makePerson, Person, typeId, useDatabase } from './helpers';

const { upload, destroy, url } = vi.hoisted(() => ({ upload: vi.fn(), destroy: vi.fn(), url: vi.fn() }));
vi.mock('cloudinary', () => ({ v2: { config: vi.fn(), url, uploader: { upload, destroy } } }));

useDatabase('storage');

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 2)]);
const SIGNED_URL = 'https://res.cloudinary.test/signed/s--secret--/file';

let emp: Person;
let empAgent: Agent;
let hrAgent: Agent;

const png = (agent = empAgent, buffer = PNG) => agent.put('/api/me/avatar').attach('file', buffer, { filename: 'me.png', contentType: 'image/png' });
const document = (agent = empAgent) => agent.post('/api/files').attach('file', PDF, { filename: 'note.pdf', contentType: 'application/pdf' });
const binary = (res: { text?: string; body: unknown }) => res.body as Buffer;
const getAvatar = (agent = empAgent) => agent.get('/api/me/avatar').buffer(true).parse((res, done) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
});

beforeEach(async () => {
  await baseline();
  upload.mockReset().mockResolvedValue({});
  destroy.mockReset().mockResolvedValue({ result: 'ok' });
  url.mockReset().mockReturnValue(SIGNED_URL);
  emp = await makePerson();
  empAgent = await agentFor(emp.email);
  hrAgent = await agentFor((await makePerson({ role: 'HR_ADMIN' })).email);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(env, { CLOUDINARY_CLOUD_NAME: undefined, CLOUDINARY_API_KEY: undefined, CLOUDINARY_API_SECRET: undefined });
});

const useCloudinary = (bytes: Buffer = PDF, status = 200) => {
  Object.assign(env, { CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: 'key', CLOUDINARY_API_SECRET: 'secret' });
  const fetcher = vi.fn(async () => new Response(new Uint8Array(bytes), { status }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};

describe('documents in Cloudinary', () => {
  it('stores them privately under a random name, never using the original name', async () => {
    useCloudinary();
    const res = await document();
    expect(res.status).toBe(201);
    const doc = (await StoredFile.findById(res.body.data.id).lean())!;
    expect(doc.storage).toBe('CLOUDINARY');
    const [data, options] = upload.mock.calls[0];
    expect(data).toMatch(/^data:application\/pdf;base64,/);
    expect(options).toMatchObject({ resource_type: 'raw', type: 'authenticated', public_id: `leave-hub/${doc.storedName}`, overwrite: false });
    expect(options.public_id).not.toContain('note');
  });

  it('serves them through the server, without ever revealing the Cloudinary address', async () => {
    const fetcher = useCloudinary();
    const id = (await document()).body.data.id;
    const res = await empAgent.get(`/api/files/${id}`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(fetcher).toHaveBeenCalledWith(SIGNED_URL, expect.anything());
    expect(url.mock.calls[0][1]).toMatchObject({ sign_url: true, type: 'authenticated', resource_type: 'raw' });
    expect(JSON.stringify(res.headers)).not.toContain('cloudinary');
  });

  it('still refuses people who may not see the file, without contacting Cloudinary', async () => {
    const fetcher = useCloudinary();
    const id = (await document()).body.data.id;
    const other = await agentFor((await makePerson()).email);
    expect((await other.get(`/api/files/${id}`)).status).toBe(404);
    expect((await hrAgent.get(`/api/files/${id}`)).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('removes them from Cloudinary when deleted', async () => {
    useCloudinary();
    const id = (await document()).body.data.id;
    const { storedName } = (await StoredFile.findById(id).lean())!;
    expect((await empAgent.delete(`/api/files/${id}`)).status).toBe(200);
    expect(destroy).toHaveBeenCalledWith(`leave-hub/${storedName}`, expect.objectContaining({ resource_type: 'raw', type: 'authenticated' }));
    expect(await StoredFile.findById(id)).toBeNull();
  });

  it('gives a plain message and keeps no record when the upload fails', async () => {
    useCloudinary();
    upload.mockRejectedValue({ error: { message: 'Invalid api_key secret-value', http_code: 401 } });
    const res = await document();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
    expect(await StoredFile.countDocuments()).toBe(0);
  });

  it('gives a plain message when Cloudinary cannot return a file', async () => {
    useCloudinary(PDF, 500);
    const id = (await document()).body.data.id;
    const res = await empAgent.get(`/api/files/${id}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_UNAVAILABLE');
  });

  it('keeps serving older files from the local folder after switching', async () => {
    const id = (await document()).body.data.id;
    const fetcher = useCloudinary();
    expect((await StoredFile.findById(id).lean())!.storage).toBe('LOCAL');
    expect((await empAgent.get(`/api/files/${id}`).buffer(true)).status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await empAgent.delete(`/api/files/${id}`)).status).toBe(200);
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe('profile photo', () => {
  it('is allowed by the content security policy, which the app needs in order to show it', async () => {
    const res = await empAgent.get('/api/auth/me');
    expect(res.headers['content-security-policy']).toMatch(/img-src 'self' data: blob:/);
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
  });

  it('uploads, shows in the profile, and reads back the same image', async () => {
    const res = await png();
    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toMatch(/^\/me\/avatar\?v=[0-9a-f]{24}$/);
    expect((await empAgent.get('/api/auth/me')).body.data.avatarUrl).toBe(res.body.data.avatarUrl);

    const image = await getAvatar();
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toMatch(/image\/png/);
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.headers['cache-control']).toMatch(/private/);
    expect(binary(image).equals(PNG)).toBe(true);
  });

  it('starts with none', async () => {
    expect((await empAgent.get('/api/auth/me')).body.data.avatarUrl).toBeNull();
    expect((await empAgent.get('/api/me/avatar')).status).toBe(404);
  });

  it('replaces the old photo, deleting it and giving a new address', async () => {
    const first = (await png()).body.data.avatarUrl;
    const second = await empAgent.put('/api/me/avatar').attach('file', JPEG, { filename: 'me.jpg', contentType: 'image/jpeg' });
    expect(second.status).toBe(200);
    expect(second.body.data.avatarUrl).not.toBe(first);
    expect(await StoredFile.countDocuments({ purpose: 'AVATAR' })).toBe(1);
    const image = await getAvatar();
    expect(image.headers['content-type']).toMatch(/image\/jpeg/);
    expect(binary(image).equals(JPEG)).toBe(true);
  });

  it('removes the photo completely, and removing again is harmless', async () => {
    await png();
    const res = await empAgent.delete('/api/me/avatar');
    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toBeNull();
    expect(await StoredFile.countDocuments({ purpose: 'AVATAR' })).toBe(0);
    expect((await empAgent.get('/api/me/avatar')).status).toBe(404);
    expect((await empAgent.delete('/api/me/avatar')).status).toBe(200);
  });

  it('works with Cloudinary too, and removes it there', async () => {
    useCloudinary(PNG);
    await png();
    const image = await getAvatar();
    expect(binary(image).equals(PNG)).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    await empAgent.delete('/api/me/avatar');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('only ever acts on the signed-in person', async () => {
    await png();
    const other = await agentFor((await makePerson()).email);
    expect((await other.get('/api/me/avatar')).status).toBe(404);
    await other.delete('/api/me/avatar');
    expect((await User.findById(emp.userId).lean())!.avatarFile).toBeTruthy();
  });

  it('accepts only real images up to 2 MB', async () => {
    const asPdf = await empAgent.put('/api/me/avatar').attach('file', PDF, { filename: 'me.pdf', contentType: 'application/pdf' });
    expect(asPdf.status).toBe(422);
    const svg = await empAgent.put('/api/me/avatar').attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { filename: 'me.svg', contentType: 'image/svg+xml' });
    expect(svg.status).toBe(422);
    const disguised = await empAgent.put('/api/me/avatar').attach('file', PDF, { filename: 'me.png', contentType: 'image/png' });
    expect(disguised.status).toBe(422);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const tooBig = await png(empAgent, big);
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE');
    expect(await StoredFile.countDocuments()).toBe(0);
  });

  it('keeps the existing photo when a new one fails to upload', async () => {
    const first = (await png()).body.data.avatarUrl;
    await empAgent.put('/api/me/avatar').attach('file', PDF, { filename: 'me.pdf', contentType: 'application/pdf' });
    expect((await empAgent.get('/api/auth/me')).body.data.avatarUrl).toBe(first);
  });

  it('cannot be deleted as a document or attached to a leave request', async () => {
    const id = String((await png()).body.data.avatarUrl).split('v=')[1];
    expect((await empAgent.delete(`/api/files/${id}`)).status).toBe(404);
    const leave = await empAgent.post('/api/leaves').send({ ...fullDay(await typeId('CL'), FRI), document: id });
    expect(leave.status).toBe(422);
    expect(leave.body.error.details[0].path).toBe('document');
  });

  it('needs the CSRF header and a session', async () => {
    expect((await empAgent.put('/api/me/avatar').unset('X-Requested-With').attach('file', PNG, { filename: 'me.png', contentType: 'image/png' })).status).toBe(403);
  });
});
