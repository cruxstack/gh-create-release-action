import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runAction } from './helpers/action.ts';

const SHA = 'a'.repeat(40);
const inputs = {
  'github-token': 'e2e-token',
  'github-repository': 'o/r',
  'release-tag': 'v2.0.0',
  'release-target': SHA,
  'release-body': 'Release notes',
  'release-assets': 'out/*.tgz',
  'release-notes-generate': 'false',
  'release-if-exists': 'fail',
  'release-assets-overwrite': 'false',
};

describe('dist/main.js', () => {
  let ws = '';
  before(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'release-e2e-')));
    mkdirSync(join(ws, 'out'));
    writeFileSync(join(ws, 'out', 'app-linux.tgz'), 'binary');
  });
  after(() => rmSync(ws, { recursive: true, force: true }));

  it('creates, uploads and publishes a release', async () => {
    // A relative upload_url keeps uploads on the local fake server.
    const release = { id: 9, html_url: 'https://github.com/o/r/releases/tag/v2.0.0', upload_url: '/upload/9/assets{?name,label}', tag_name: 'v2.0.0', draft: true };
    const result = await runAction(
      inputs,
      [
        {
          method: 'GET',
          path: '/repos/o/r/releases/tags/v2.0.0',
          status: 404,
          json: { message: 'Not Found' },
          check: (req) => assert.equal(req.headers.get('authorization'), 'Bearer e2e-token'),
        },
        { method: 'GET', path: '/repos/o/r/releases', json: [] },
        { method: 'GET', path: '/repos/o/r/git/ref/tags/v2.0.0', status: 404, json: { message: 'Not Found' } },
        {
          method: 'POST',
          path: '/repos/o/r/releases',
          status: 201,
          json: release,
          check: (req) =>
            assert.deepEqual(req.json, { tag_name: 'v2.0.0', name: 'v2.0.0', draft: true, prerelease: false, body: 'Release notes', target_commitish: SHA }),
        },
        {
          method: 'POST',
          path: '/upload/9/assets',
          status: 201,
          json: { id: 1, name: 'app-linux.tgz', size: 6, browser_download_url: 'https://github.com/o/r/releases/download/v2.0.0/app-linux.tgz' },
          check: (req) => {
            assert.equal(req.url.searchParams.get('name'), 'app-linux.tgz');
            assert.equal(req.headers.get('content-type'), 'application/gzip');
            assert.equal(req.body, 'binary');
          },
        },
        {
          method: 'PATCH',
          path: '/repos/o/r/releases/9',
          json: { ...release, draft: false },
          check: (req) => assert.deepEqual(req.json, { draft: false, make_latest: 'true' }),
        },
      ],
      { cwd: ws, env: { GITHUB_WORKSPACE: ws } },
    );
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0, result.stdout);
    result.api.done();
    assert.match(result.stdout, /^::add-mask::e2e-token$/m);
    assert.deepEqual(result.outputs, {
      'release-id': '9',
      'release-url': 'https://github.com/o/r/releases/tag/v2.0.0',
      'release-operation': 'created',
      'release-assets': JSON.stringify([{ name: 'app-linux.tgz', url: 'https://github.com/o/r/releases/download/v2.0.0/app-linux.tgz', size: 6 }]),
    });
  });

  it('fails the step on invalid input without calling the API', async () => {
    const result = await runAction({ ...inputs, 'release-assets': '../escape/*' }, [], { cwd: ws, env: { GITHUB_WORKSPACE: ws } });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^::error::release-assets pattern '..\/escape\/\*' must stay inside the workspace$/m);
    assert.deepEqual(result.outputs, {});
    result.api.done();
    assert.doesNotMatch(result.stdout, /e2e-token/);
  });
});
