import { expect, test, vi } from 'vitest';
import { handle } from '../supabase/functions/_shared/app/routes';
import { state } from '../supabase/functions/_shared/app/repository';

function fixture() {
  const reads: { table: string; columns: string; filters: Record<string, unknown> }[] = [];
  const tables: Record<string, any[]> = {
    documents: [{ id: 'doc', user_id: 'owner', data: {}, title: 'PDF' }],
    document_pages: [{ id: 'page', user_id: 'owner', document_id: 'doc', number: 73, image_path: 'owner/doc/73.png', kind: 'content', width: 595, height: 842, data: { kind: 'content', width: 595, height: 842, items: ['large OCR coordinates'] } }],
    problems: [{ id: 'q', user_id: 'owner', document_id: 'doc', data: { regions: [{ page: 73 }] } }],
    problem_regions: [{ user_id: 'owner', problem_id: 'q', part: 0, image_path: 'owner/doc/q.png' }],
  };
  const from = (table: string) => {
    const read = { table, columns: '', filters: {} as Record<string, unknown> };
    reads.push(read);
    const result = () => {
      const rows = (tables[table] ?? []).filter(row => Object.entries(read.filters).every(([key, value]) => row[key] === value));
      return { data: rows.map(({ data, ...row }) => read.columns.includes('kind:data') ? row : { ...row, data }), error: null };
    };
    const query: any = { select: (columns: string) => { read.columns = columns; return query; }, eq: (key: string, value: unknown) => { read.filters[key] = value; return query; }, range: () => query, order: () => query, maybeSingle: async () => ({ ...result(), data: result().data[0] ?? null }), then: (resolve: any) => Promise.resolve(result()).then(resolve) };
    return query;
  };
  const sign = vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed.invalid/${path}` }, error: null }));
  const ctx = { user: { id: 'owner' }, db: { from, storage: { from: () => ({ createSignedUrl: sign }) } }, admin: {} };
  return { ctx: ctx as any, reads, sign, tables };
}

test('opening one saved page reads only its metadata and never the library OCR payload', async () => {
  const f = fixture();
  await handle(f.ctx, { path: 'asset', method: 'POST', body: { path: 'materials/doc/page/73' } });
  const page = f.reads.find(read => read.table === 'document_pages')!;
  expect(page.filters).toEqual({ user_id: 'owner', document_id: 'doc', number: 73 });
  expect(page.columns).not.toContain('*');
  expect(page.columns.split(',')).not.toContain('data');
  expect(f.sign).toHaveBeenCalledWith('owner/doc/73.png', 180);
});

test('opening one crop reads only its source page and scoped stored region paths', async () => {
  const f = fixture();
  await handle(f.ctx, { path: 'asset', method: 'POST', body: { path: 'questions/q/image/0' } });
  expect(f.reads.find(read => read.table === 'document_pages')?.filters).toEqual({ user_id: 'owner', document_id: 'doc', number: 73 });
  expect(f.reads.find(read => read.table === 'problem_regions')?.filters).toEqual({ user_id: 'owner', problem_id: 'q' });
  expect(f.sign).toHaveBeenCalledWith('owner/doc/q.png', 180);
});

test('learning loads page metadata without copying the stored OCR coordinates', async () => {
  const f=fixture();
  const result=await state(f.ctx,true);
  expect(result.pages[0]).toMatchObject({number:73,materialId:'doc',kind:'content',width:595,height:842});
  expect(result.pages[0]).not.toHaveProperty('items');
  expect(f.tables.document_pages[0].data.items).toEqual(['large OCR coordinates']);
  expect(f.reads.find(read=>read.table==='document_pages')?.columns).not.toContain('*');
});

test('lightweight crop lookup still rejects an answer page', async()=>{
  const f=fixture();
  f.tables.document_pages[0].kind='answers';
  await expect(handle(f.ctx,{path:'asset',method:'POST',body:{path:'questions/q/image/0'}})).rejects.toThrow('정답·해설');
  expect(f.sign).not.toHaveBeenCalled();
});
