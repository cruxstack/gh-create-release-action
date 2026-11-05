import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { assetName, contentType, readBodyFile, resolveAssets } from '../src/files.ts';

let root = '';
let ws = '';
const write = (files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(ws, file, '..'), { recursive: true });
    writeFileSync(join(ws, file), content);
  }
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'files-')));
  ws = join(root, 'ws');
  mkdirSync(ws);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('assetName and contentType', () => {
  it('sanitizes names', () => {
    assert.equal(assetName('dir/my app v1.0 (linux).tar.gz'), 'my.app.v1.0..linux..tar.gz');
    assert.equal(assetName('.hidden.'), 'hidden');
    assert.equal(assetName('a+b_c-d.zip'), 'a+b_c-d.zip');
    assert.throws(() => assetName('...'), /no usable name/);
  });

  it('maps known extensions', () => {
    assert.equal(contentType('a.ZIP'), 'application/zip');
    assert.equal(contentType('a.tar.gz'), 'application/gzip');
    assert.equal(contentType('a.bin'), 'application/octet-stream');
  });
});

describe('readBodyFile', () => {
  it('reads files inside the workspace', async () => {
    write({ 'notes/body.md': '# Notes' });
    assert.equal(await readBodyFile(ws, 'notes/body.md'), '# Notes');
  });

  it('rejects files outside the workspace, directories and large files', async () => {
    writeFileSync(join(root, 'secret'), 'x');
    symlinkSync(join(root, 'secret'), join(ws, 'link'));
    write({ 'big.md': 'x'.repeat(1024 ** 2 + 1) });
    mkdirSync(join(ws, 'dir'));
    await assert.rejects(readBodyFile(ws, '../secret'), /outside the workspace/);
    await assert.rejects(readBodyFile(ws, 'link'), /outside the workspace/);
    await assert.rejects(readBodyFile(ws, 'dir'), /not a regular file/);
    await assert.rejects(readBodyFile(ws, 'big.md'), /larger than 1 MiB/);
    await assert.rejects(readBodyFile(ws, 'missing.md'), /ENOENT/);
  });
});

describe('resolveAssets', () => {
  it('returns nothing without patterns', async () => {
    assert.deepEqual(await resolveAssets(join(root, 'missing'), []), []);
  });

  it('matches files, skips directories and dedupes', async () => {
    write({ 'dist/b.zip': 'bb', 'dist/a.txt': 'a', 'dist/sub/c.zip': 'c' });
    const assets = await resolveAssets(ws, ['dist/*', 'dist/**/*.zip']);
    assert.deepEqual(
      assets.map((a) => [a.name, a.size, a.contentType, a.path]),
      [
        ['a.txt', 1, 'text/plain', join(ws, 'dist/a.txt')],
        ['b.zip', 2, 'application/zip', join(ws, 'dist/b.zip')],
        ['c.zip', 1, 'application/zip', join(ws, 'dist/sub/c.zip')],
      ],
    );
  });

  it('fails on patterns without files', async () => {
    write({ 'dist/sub/x': 'x' });
    await assert.rejects(resolveAssets(ws, ['*.zip']), /'\*\.zip' matched no files/);
    await assert.rejects(resolveAssets(ws, ['dist/*']), /'dist\/\*' matched no files/);
  });

  it('fails on name collisions', async () => {
    write({ 'a/x.zip': '1', 'b/x.zip': '2' });
    await assert.rejects(resolveAssets(ws, ['*/x.zip']), /would both be named 'x.zip'/);
  });

  it('fails on empty files and links that leave the workspace', async () => {
    write({ 'empty.txt': '' });
    await assert.rejects(resolveAssets(ws, ['empty.txt']), /is empty/);
    writeFileSync(join(root, 'outside.txt'), 'x');
    symlinkSync(join(root, 'outside.txt'), join(ws, 'link.txt'));
    await assert.rejects(resolveAssets(ws, ['link.txt']), /outside the workspace/);
  });
});
