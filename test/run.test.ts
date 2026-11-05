import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Log } from '../src/lib/actions.ts';
import { GitHub } from '../src/lib/github.ts';
import type { Config } from '../src/config.ts';
import { mapLimit, run } from '../src/run.ts';
import { fakeFetch, type Route } from './helpers/fake-fetch.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'c'.repeat(40);
const REPO = '/repos/o/r';
const UPLOAD = 'https://uploads.github.com/repos/o/r/releases/7/assets';

let ws = '';
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'release-')));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const config = (overrides: Partial<Config> = {}): Config => ({
  token: 't',
  owner: 'o',
  repo: 'r',
  workspace: ws,
  tag: 'v1.0.0',
  name: undefined,
  target: undefined,
  body: undefined,
  bodyFile: undefined,
  notesGenerate: false,
  notesPreviousTag: undefined,
  draft: undefined,
  prerelease: undefined,
  latest: undefined,
  ifExists: 'fail',
  assets: [],
  assetsOverwrite: false,
  ...overrides,
});

const release = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  html_url: 'https://github.com/o/r/releases/tag/v1.0.0',
  upload_url: `${UPLOAD}{?name,label}`,
  tag_name: 'v1.0.0',
  draft: false,
  ...overrides,
});

const asset = (name: string, id = 1) => ({ id, name, size: 2, browser_download_url: `https://github.com/o/r/releases/download/v1.0.0/${name}` });

const routes = {
  byTag: (json?: unknown): Route => ({ method: 'GET', path: `${REPO}/releases/tags/v1.0.0`, ...(json ? { json } : { status: 404, json: { message: 'Not Found' } }) }),
  list: (json: unknown[]): Route => ({ method: 'GET', path: `${REPO}/releases`, json }),
  tagRef: (sha?: string, type = 'commit'): Route => ({
    method: 'GET',
    path: `${REPO}/git/ref/tags/v1.0.0`,
    ...(sha ? { json: { object: { type, sha } } } : { status: 404, json: { message: 'Not Found' } }),
  }),
  createDraft: (check: (body: Record<string, unknown>) => void, json = release({ draft: true })): Route => ({
    method: 'POST',
    path: `${REPO}/releases`,
    status: 201,
    json,
    check: (req) => check(req.json as Record<string, unknown>),
  }),
  patch: (expected: Record<string, unknown>, json = release()): Route => ({
    method: 'PATCH',
    path: `${REPO}/releases/7`,
    json,
    check: (req) => assert.deepEqual(req.json, expected),
  }),
  upload: (name: string, content: string, type: string): Route => ({
    method: 'POST',
    path: '/repos/o/r/releases/7/assets',
    status: 201,
    json: asset(name),
    check: (req) => {
      assert.equal(req.url.origin, 'https://uploads.github.com');
      assert.equal(req.url.searchParams.get('name'), name);
      assert.equal(req.headers.get('content-type'), type);
      assert.equal(req.body, content);
    },
  }),
  deleteRelease: (status = 204): Route => ({ method: 'DELETE', path: `${REPO}/releases/7`, status }),
};

async function execute(list: Route[], overrides: Partial<Config> = {}) {
  const fake = fakeFetch(list);
  const logs: string[] = [];
  const log: Log = { debug() {}, info: (m) => logs.push(m), warning: (m) => logs.push(`warn: ${m}`), error() {} };
  const github = new GitHub({ token: 't', userAgent: 'test', apiUrl: 'https://api.github.com', fetch: fake.fetch, sleep: async () => {}, maxRetries: 0 });
  try {
    return { outputs: await run(config(overrides), { github, log }), logs };
  } finally {
    fake.done();
  }
}

const files = (entries: Record<string, string>) => {
  for (const [file, content] of Object.entries(entries)) {
    mkdirSync(join(ws, file, '..'), { recursive: true });
    writeFileSync(join(ws, file), content);
  }
};

describe('run: new releases', () => {
  it('creates a draft for an existing tag, uploads assets, then publishes', async () => {
    files({ 'dist/app.zip': 'zz', 'dist/notes.txt': 'tt' });
    const { outputs } = await execute(
      [
        routes.byTag(),
        routes.list([release({ id: 1, draft: true, tag_name: 'v0.9.0' })]),
        routes.tagRef(SHA),
        routes.createDraft((body) => assert.deepEqual(body, { tag_name: 'v1.0.0', name: 'v1.0.0', draft: true, prerelease: false, body: 'hello' })),
        routes.upload('app.zip', 'zz', 'application/zip'),
        { ...routes.upload('notes.txt', 'tt', 'text/plain'), json: asset('notes.txt', 2) },
        routes.patch({ draft: false, make_latest: 'true' }),
      ],
      { body: 'hello', assets: ['dist/*'], target: SHA },
    );
    assert.deepEqual(outputs, {
      'release-id': 7,
      'release-url': 'https://github.com/o/r/releases/tag/v1.0.0',
      'release-operation': 'created',
      'release-assets': JSON.stringify([
        { name: 'app.zip', url: 'https://github.com/o/r/releases/download/v1.0.0/app.zip', size: 2 },
        { name: 'notes.txt', url: 'https://github.com/o/r/releases/download/v1.0.0/notes.txt', size: 2 },
      ]),
    });
  });

  it('creates the tag from release-target and can stay a draft', async () => {
    const { outputs, logs } = await execute(
      [
        routes.byTag(),
        routes.list([]),
        routes.tagRef(),
        routes.createDraft((body) =>
          assert.deepEqual(body, { tag_name: 'v1.0.0', name: 'Hotfix', draft: true, prerelease: true, target_commitish: 'release/1.x' }),
        ),
      ],
      { target: 'release/1.x', name: 'Hotfix', prerelease: true, draft: true },
    );
    assert.equal(outputs['release-operation'], 'created');
    assert.equal(outputs['release-assets'], '[]');
    assert.ok(logs.includes('Created draft release 7 for v1.0.0'));
  });

  it('publishes with the requested latest flag', async () => {
    await execute(
      [routes.byTag(), routes.list([]), routes.tagRef(SHA), routes.createDraft(() => {}), routes.patch({ draft: false, make_latest: 'false' })],
      { latest: 'false' },
    );
  });

  it('refuses to create a tag implicitly', async () => {
    await assert.rejects(execute([routes.byTag(), routes.list([]), routes.tagRef()]), /tag v1.0.0 does not exist; set release-target/);
  });

  it('refuses a tag that points elsewhere, following annotated tags', async () => {
    const tagObject = 'd'.repeat(40);
    await assert.rejects(
      execute(
        [
          routes.byTag(),
          routes.list([]),
          routes.tagRef(tagObject, 'tag'),
          { method: 'GET', path: `${REPO}/git/tags/${tagObject}`, json: { object: { type: 'commit', sha: OTHER } } },
        ],
        { target: SHA },
      ),
      /points at c{40}, not release-target a{40}/,
    );
    await assert.rejects(execute([routes.byTag(), routes.list([]), routes.tagRef(SHA, 'tree')]), /points to a tree/);
  });

  it('appends generated notes to the body file', async () => {
    files({ 'body.md': 'Intro' });
    await execute(
      [
        routes.byTag(),
        routes.list([]),
        routes.tagRef(),
        {
          method: 'POST',
          path: `${REPO}/releases/generate-notes`,
          json: { name: 'v1.0.0', body: '## Changes' },
          check: (req) => assert.deepEqual(req.json, { tag_name: 'v1.0.0', target_commitish: SHA, previous_tag_name: 'v0.9.0' }),
        },
        routes.createDraft((body) => assert.equal(body['body'], 'Intro\n\n## Changes')),
        routes.patch({ draft: false, make_latest: 'true' }),
      ],
      { bodyFile: 'body.md', notesGenerate: true, notesPreviousTag: 'v0.9.0', target: SHA },
    );
  });

  it('uses generated notes alone and rejects oversized bodies', async () => {
    await execute(
      [
        routes.byTag(),
        routes.list([]),
        routes.tagRef(SHA),
        { method: 'POST', path: `${REPO}/releases/generate-notes`, json: { body: 'generated' }, check: (req) => assert.deepEqual(req.json, { tag_name: 'v1.0.0' }) },
        routes.createDraft((body) => assert.equal(body['body'], 'generated')),
        routes.patch({ draft: false, make_latest: 'true' }),
      ],
      { notesGenerate: true },
    );
    await assert.rejects(execute([routes.byTag(), routes.list([]), routes.tagRef(SHA)], { body: 'x'.repeat(125_001) }), /longer than 125000/);
  });

  it('validates local files before calling the API', async () => {
    await assert.rejects(execute([], { assets: ['*.zip'] }), /matched no files/);
    await assert.rejects(execute([], { bodyFile: 'missing.md' }), /ENOENT/);
  });

  it('deletes its draft when an upload fails', async () => {
    files({ 'a.zip': 'zz' });
    await assert.rejects(
      execute(
        [
          routes.byTag(),
          routes.list([]),
          routes.tagRef(SHA),
          routes.createDraft(() => {}),
          { method: 'POST', path: '/repos/o/r/releases/7/assets', status: 502, json: { message: 'Bad Gateway' } },
          routes.deleteRelease(),
        ],
        { assets: ['a.zip'] },
      ),
      /failed with 502/,
    );
  });

  it('warns when the draft cannot be cleaned up', async () => {
    const fake = fakeFetch([
      routes.byTag(),
      routes.list([]),
      routes.tagRef(SHA),
      routes.createDraft(() => {}),
      { method: 'PATCH', path: `${REPO}/releases/7`, status: 422, json: { message: 'nope' } },
      { method: 'DELETE', path: `${REPO}/releases/7`, status: 403, json: { message: 'Forbidden' } },
    ]);
    const warnings: string[] = [];
    const log: Log = { debug() {}, info() {}, warning: (m) => warnings.push(m), error() {} };
    const github = new GitHub({ token: 't', userAgent: 'test', apiUrl: 'https://api.github.com', fetch: fake.fetch, sleep: async () => {} });
    await assert.rejects(run(config(), { github, log }), /422: nope/);
    assert.match(warnings[0]!, /Could not delete draft release 7: .*403: Forbidden/);
    fake.done();
  });
});

describe('run: existing releases', () => {
  it('fails or skips when configured', async () => {
    await assert.rejects(execute([routes.byTag(release())]), /a release for v1.0.0 already exists: https:\/\/github.com/);
    const { outputs } = await execute([routes.byTag(release())], { ifExists: 'skip' });
    assert.equal(outputs['release-operation'], 'skipped');
    assert.equal(outputs['release-id'], 7);
  });

  it('updates only explicitly set fields', async () => {
    const { outputs } = await execute(
      [routes.byTag(release()), routes.tagRef(SHA), routes.patch({ name: 'New', body: 'b', prerelease: false, make_latest: 'legacy' })],
      { ifExists: 'update', name: 'New', body: 'b', prerelease: false, latest: 'legacy', target: SHA },
    );
    assert.equal(outputs['release-operation'], 'updated');
  });

  it('skips the PATCH when nothing changes', async () => {
    const { outputs } = await execute([routes.byTag(release()), routes.tagRef(SHA)], { ifExists: 'update' });
    assert.equal(outputs['release-operation'], 'updated');
  });

  it('replaces existing assets only when allowed', async () => {
    files({ 'app.zip': 'zz', 'new.txt': 'nn' });
    const existingAssets: Route = { method: 'GET', path: `${REPO}/releases/7/assets`, json: [asset('app.zip', 41)] };
    await assert.rejects(
      execute([routes.byTag(release()), routes.tagRef(SHA), existingAssets], { ifExists: 'update', assets: ['*'] }),
      /assets already exist: app.zip; set release-assets-overwrite/,
    );
    const { outputs } = await execute(
      [
        routes.byTag(release()),
        routes.tagRef(SHA),
        existingAssets,
        { method: 'DELETE', path: `${REPO}/releases/assets/41`, status: 204 },
        {
          method: 'POST',
          path: '/repos/o/r/releases/7/assets',
          status: 201,
          times: 2,
          json: asset('uploaded'),
          check: (req) => {
            const expected = { 'app.zip': 'zz', 'new.txt': 'nn' } as Record<string, string>;
            assert.equal(req.body, expected[req.url.searchParams.get('name') ?? '']);
          },
        },
      ],
      { ifExists: 'update', assets: ['*'], assetsOverwrite: true },
    );
    assert.equal(JSON.parse(String(outputs['release-assets'])).length, 2);
  });

  it('finds drafts in the release list and can publish them', async () => {
    const draft = release({ id: 7, draft: true, html_url: 'https://github.com/o/r/releases/tag/untagged-1' });
    const { outputs } = await execute(
      [
        routes.byTag(),
        routes.list([release({ id: 3, tag_name: 'v0.1.0' }), draft, release({ id: 2, draft: true })]),
        routes.tagRef(),
        routes.patch({ draft: false, target_commitish: SHA }),
      ],
      { ifExists: 'update', draft: false, target: SHA },
    );
    assert.equal(outputs['release-url'], 'https://github.com/o/r/releases/tag/v1.0.0');
  });
});

describe('mapLimit', () => {
  it('keeps order and bounds concurrency', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    assert.deepEqual(result, [50, 10, 40, 20, 30]);
    assert.equal(peak, 2);
  });

  it('stops starting work after a failure', async () => {
    const started: number[] = [];
    await assert.rejects(
      mapLimit([1, 2, 3, 4], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      }),
      /boom/,
    );
    assert.deepEqual(started, [1, 2]);
    assert.deepEqual(await mapLimit([], 4, async (n) => n), []);
  });
});
