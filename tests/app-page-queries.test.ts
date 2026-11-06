import { expect, test, vi } from 'vitest';
import { handle } from '../supabase/functions/_shared/app/routes';
import { gradingContext, state } from '../supabase/functions/_shared/app/repository';

function fixture() {
  const reads: { table: string; columns: string; filters: Record<string, unknown> }[] = [];
  const tables: Record<string, any[]> = {
    documents: [{ id: 'doc', user_id: 'owner', data: {}, title: 'PDF' }],
    document_pages: [{ id: 'page', user_id: 'owner', document_id: 'doc', number: 73, image_path: 'owner/doc/73.png', kind: 'content', width: 595, height: 842, data: { kind: 'content', width: 595, height: 842, items: ['large OCR coordinates'] } }],
    problems: [{ id: 'q', user_id: 'owner', document_id: 'doc', data: { regions: [{ page: 73 }] } }],
    problem_regions: [{ user_id: 'owner', problem_id: 'q', part: 0, image_path: 'owner/doc/q.png' }],
    solve_sessions: [{ id: 'solve', user_id: 'owner', data: { id: 'solve', status: 'active', questionIds: ['q'], questionSnapshots: [{ id: 'q' }], drawings: {}, answers: {} } }],
    study_sessions: [{ id: 'study', user_id: 'owner', data: { id: 'study', mode: 'memory', status: 'active', items: [{ id: 'item', answer: 'saved answer' }] } }],
  };
  const from = (table: string) => {
    const read = { table, columns: '', filters: {} as Record<string, unknown> };
    reads.push(read);
    const field = (row: any, path: string) => path.split(/->>?/).reduce((value, key) => value?.[key], row);
    const result = () => {
      const rows = (tables[table] ?? []).filter(row => Object.entries(read.filters).every(([key, value]) => Array.isArray(value) ? value.includes(field(row,key)) : field(row,key) === value));
      return { data: read.columns === '*' ? rows : rows.map(row => Object.fromEntries(read.columns.split(',').map(column => {
        const [alias, path = alias] = column.split(':');
        return [alias, field(row, path)];
      }))), error: null };
    };
    const query: any = { select: (columns: string) => { read.columns = columns; return query; }, eq: (key: string, value: unknown) => { read.filters[key] = value; return query; }, in: (key: string, value: unknown[]) => { read.filters[key] = value; return query; }, range: () => query, order: () => query, maybeSingle: async () => ({ ...result(), data: result().data[0] ?? null }), then: (resolve: any) => Promise.resolve(result()).then(resolve) };
    return query;
  };
  const sign = vi.fn(async (path: string) => ({ data: { signedUrl: `https://signed.invalid/${path}` }, error: null }));
  const rpc = vi.fn(async (_name: string, args: any) => ({ data: { ...args.p_data, version: 1 }, error: null }));
  const ctx = { user: { id: 'owner' }, db: { from, storage: { from: () => ({ createSignedUrl: sign }) } }, admin: { rpc } };
  return { ctx: ctx as any, reads, sign, tables };
}

test('opening one saved page reads only its metadata and never the library OCR payload', async () => {
  const f = fixture();
  const image = await handle(f.ctx, { path: 'asset', method: 'POST', body: { path: 'materials/doc/page/73' } });
  const page = f.reads.find(read => read.table === 'document_pages')!;
  expect(f.reads).toHaveLength(1);
  expect(page.filters).toEqual({ user_id: 'owner', document_id: 'doc', number: 73 });
  expect(page.columns).not.toContain('*');
  expect(page.columns.split(',')).not.toContain('data');
  expect(page.columns).not.toContain('text');
  expect(f.sign).toHaveBeenCalledWith('owner/doc/73.png', 180);
  expect(image.storagePath).toBe('owner/doc/73.png');
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
  expect(f.reads.find(read=>read.table==='document_pages')?.columns).not.toContain('text');
});

test('lightweight crop lookup still rejects an answer page', async()=>{
  const f=fixture();
  f.tables.document_pages[0].data.kind='answers';
  await expect(handle(f.ctx,{path:'asset',method:'POST',body:{path:'questions/q/image/0'}})).rejects.toThrow('정답·해설');
  expect(f.sign).not.toHaveBeenCalled();
});

test('saving a drawing reads only the selected solve session', async () => {
  const f = fixture();
  const result = await handle(f.ctx, { path: 'solve/solve/drawing', method: 'POST', body: { questionId: 'q', strokes: [{ color: 'black' }] } });
  expect(result.drawings).toEqual({ q: [{ color: 'black' }] });
  expect(f.reads.map(read => read.table)).toEqual(['solve_sessions']);
});

test('grading an original reads only its mistake record and selected session', async () => {
  const f = fixture();
  await handle(f.ctx, { path: 'solve/solve/answer', method: 'POST', body: { questionId: 'q', result: 'wrong' } });
  expect(f.reads.map(read => read.table)).toEqual(['solve_sessions', 'wrong_answers']);
  expect(f.reads[1].filters).toEqual({ user_id: 'owner', problem_id: 'q' });
});

test('revealing a study snapshot reads only that study session', async () => {
  const f = fixture();
  const result = await handle(f.ctx, { path: 'study/study/reveal', method: 'POST', body: { itemId: 'item' } });
  expect(result.answer).toBe('saved answer');
  expect(f.reads.map(read => read.table)).toEqual(['study_sessions']);
});

test('drawing autosave can acknowledge persistence without returning the full solve snapshot', async () => {
  const f = fixture();
  const strokes = [{ color: 'black' }];
  const result = await handle(f.ctx, { path: 'solve/solve/drawing', method: 'POST', body: { questionId: 'q', strokes, minimal: true } });
  expect(result).toEqual({ saved: true });
  expect(f.ctx.admin.rpc).toHaveBeenCalledWith('save_learning_session', expect.objectContaining({ p_data: expect.objectContaining({ drawings: { q: strokes } }) }));
});

test('the viewer fetches page coordinates without OCR text or another library read', async () => {
  const f = fixture();
  const result = await handle(f.ctx, { path: 'materials/doc/pages' });
  expect(f.reads.map(read => read.table)).toEqual(['documents','document_pages']);
  expect(f.reads[1].filters).toEqual({user_id:'owner',document_id:'doc'});
  expect(f.reads[1].columns).not.toContain('text:data');
  expect(result.pages[0]).toMatchObject({number:73,width:595,height:842});
});

test('the overview keeps the saved crop links and bank counts but omits OCR and session snapshots', async () => {
  const f = fixture();
  f.tables.problems[0].data.text = 'large OCR payload';
  f.tables.problem_regions[0].data = {page:73};
  f.tables.concepts = [{id:'c',user_id:'owner',data:{}}];
  f.tables.problem_concepts = [{user_id:'owner',problem_id:'q',concept_id:'c'}];
  f.tables.concept_questions = [{id:'b',user_id:'owner',concept_id:'c',review_status:'approved',data:{modes:['quiz'],answer:'answer'}}];
  const result = await handle(f.ctx, { path: 'overview' });
  expect(result.bankStats).toEqual([{conceptId:'c',count:1,modes:['quiz']}]);
  expect(result.questions[0]).toMatchObject({id:'q',hasContent:true,imagePaths:['owner/doc/q.png']});
  expect(result.questions[0]).not.toHaveProperty('text');
  expect(result.studies[0]).not.toHaveProperty('items');
  expect(result.sessions[0]).not.toHaveProperty('drawings');
  expect(f.reads.map(read => read.table)).not.toContain('content_refs');
  expect(f.reads.find(read => read.table === 'concept_questions')?.columns).not.toContain('answer');
});

test('grading uses saved region page kinds without fetching any bank or session snapshots', async () => {
  const f = fixture();
  f.tables.wrong_answers = [{id:'wrong',user_id:'owner',problem_id:'q',data:{}}];
  f.tables.problem_concepts = [{user_id:'owner',problem_id:'q',concept_id:'c'}];
  f.tables.problem_regions[0].page = 73;
  expect((await gradingContext(f.ctx, [])).questions).toEqual([{id:'q',conceptIds:['c']}]);
  f.tables.document_pages[0].data.kind = 'answers';
  expect((await gradingContext(f.ctx, [])).questions).toEqual([]);
  expect(f.reads.map(read => read.table)).not.toContain('concept_questions');
  expect(f.reads.map(read => read.table)).not.toContain('solve_sessions');
});
