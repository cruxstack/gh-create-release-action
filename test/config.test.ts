import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Inputs } from '../src/lib/actions.ts';
import { readConfig } from '../src/config.ts';

const base = {
  'INPUT_GITHUB-TOKEN': 'tok',
  'INPUT_GITHUB-REPOSITORY': 'o/r',
  'INPUT_RELEASE-TAG': 'v1.2.0',
};
const read = (env: Record<string, string> = {}) => readConfig(new Inputs({ ...base, ...env }), env);

describe('readConfig', () => {
  it('leaves unset optional inputs undefined', () => {
    const config = read({ GITHUB_WORKSPACE: '/ws' });
    assert.equal(config.workspace, '/ws');
    assert.equal(config.tag, 'v1.2.0');
    for (const key of ['name', 'target', 'body', 'bodyFile', 'notesPreviousTag', 'draft', 'prerelease', 'latest'] as const) {
      assert.equal(config[key], undefined, key);
    }
    assert.equal(config.notesGenerate, false);
    assert.equal(config.ifExists, 'fail');
    assert.deepEqual(config.assets, []);
    assert.equal(config.assetsOverwrite, false);
  });

  it('defaults the workspace to the current directory', () => {
    assert.equal(read().workspace, process.cwd());
  });

  it('reads explicit values, including false booleans', () => {
    const config = read({
      'INPUT_RELEASE-NAME': 'Release 1.2',
      'INPUT_RELEASE-TARGET': 'a'.repeat(40),
      'INPUT_RELEASE-BODY': 'notes',
      'INPUT_RELEASE-NOTES-GENERATE': 'true',
      'INPUT_RELEASE-NOTES-PREVIOUS-TAG': 'v1.1.0',
      'INPUT_RELEASE-DRAFT': 'false',
      'INPUT_RELEASE-PRERELEASE': 'true',
      'INPUT_RELEASE-LATEST': 'legacy',
      'INPUT_RELEASE-IF-EXISTS': 'update',
      'INPUT_RELEASE-ASSETS': 'dist/*.zip\n\nchecksums.txt',
      'INPUT_RELEASE-ASSETS-OVERWRITE': 'true',
    });
    assert.equal(config.name, 'Release 1.2');
    assert.equal(config.target, 'a'.repeat(40));
    assert.equal(config.body, 'notes');
    assert.equal(config.notesGenerate, true);
    assert.equal(config.notesPreviousTag, 'v1.1.0');
    assert.equal(config.draft, false);
    assert.equal(config.prerelease, true);
    assert.equal(config.latest, 'legacy');
    assert.equal(config.ifExists, 'update');
    assert.deepEqual(config.assets, ['dist/*.zip', 'checksums.txt']);
    assert.equal(config.assetsOverwrite, true);
  });

  it('accepts branch names as targets', () => {
    assert.equal(read({ 'INPUT_RELEASE-TARGET': 'release/1.x' }).target, 'release/1.x');
  });

  it('rejects bad input', () => {
    assert.throws(() => read({ 'INPUT_RELEASE-TAG': '' }), /release-tag' is required/);
    assert.throws(() => read({ 'INPUT_RELEASE-TAG': 'v1..0' }), /release-tag 'v1..0'/);
    assert.throws(() => read({ 'INPUT_RELEASE-TARGET': 'bad branch' }), /release-target/);
    assert.throws(() => read({ 'INPUT_RELEASE-NOTES-PREVIOUS-TAG': 'a b' }), /release-notes-previous-tag/);
    assert.throws(() => read({ 'INPUT_RELEASE-BODY': 'x', 'INPUT_RELEASE-BODY-FILE': 'y' }), /only one of/);
    assert.throws(() => read({ 'INPUT_RELEASE-ASSETS': '../secret' }), /inside the workspace/);
    assert.throws(() => read({ 'INPUT_RELEASE-ASSETS': '/etc/passwd' }), /inside the workspace/);
    assert.throws(() => read({ 'INPUT_RELEASE-LATEST': 'yes' }), /one of true, false, legacy/);
    assert.throws(() => read({ 'INPUT_RELEASE-IF-EXISTS': 'replace' }), /one of fail, skip, update/);
    assert.throws(() => read({ 'INPUT_RELEASE-DRAFT': 'no' }), /must be 'true' or 'false'/);
  });
});
