import { isAbsolute } from 'node:path';
import type { Env, Inputs } from './lib/actions.ts';
import { assertRefName, isCommitSha, parseRepository } from './lib/refname.ts';

export const IF_EXISTS = ['fail', 'skip', 'update'] as const;
export const LATEST = ['true', 'false', 'legacy'] as const;

export type IfExists = (typeof IF_EXISTS)[number];
export type Latest = (typeof LATEST)[number];

/** Optional fields are undefined when the input was not set, so updates only send what was asked for. */
export interface Config {
  token: string;
  owner: string;
  repo: string;
  workspace: string;
  tag: string;
  name: string | undefined;
  target: string | undefined;
  body: string | undefined;
  bodyFile: string | undefined;
  notesGenerate: boolean;
  notesPreviousTag: string | undefined;
  draft: boolean | undefined;
  prerelease: boolean | undefined;
  latest: Latest | undefined;
  ifExists: IfExists;
  assets: string[];
  assetsOverwrite: boolean;
}

const optional = (value: string): string | undefined => value || undefined;

export function readConfig(inputs: Inputs, env: Env): Config {
  const target = optional(inputs.get('release-target'));
  if (target && !isCommitSha(target)) assertRefName('release-target', target);

  const body = optional(inputs.get('release-body'));
  const bodyFile = optional(inputs.get('release-body-file'));
  if (body && bodyFile) throw new Error('set only one of release-body and release-body-file');

  const notesPreviousTag = optional(inputs.get('release-notes-previous-tag'));
  if (notesPreviousTag) assertRefName('release-notes-previous-tag', notesPreviousTag);

  const assets = inputs.list('release-assets');
  for (const pattern of assets) {
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
      throw new Error(`release-assets pattern '${pattern}' must stay inside the workspace`);
    }
  }

  return {
    token: inputs.required('github-token'),
    ...parseRepository(inputs.required('github-repository')),
    workspace: env['GITHUB_WORKSPACE'] || process.cwd(),
    tag: assertRefName('release-tag', inputs.required('release-tag')),
    name: optional(inputs.get('release-name')),
    target,
    body,
    bodyFile,
    notesGenerate: inputs.boolean('release-notes-generate', false),
    notesPreviousTag,
    draft: inputs.get('release-draft') ? inputs.boolean('release-draft', false) : undefined,
    prerelease: inputs.get('release-prerelease') ? inputs.boolean('release-prerelease', false) : undefined,
    latest: inputs.get('release-latest') ? inputs.choice('release-latest', LATEST, 'true') : undefined,
    ifExists: inputs.choice('release-if-exists', IF_EXISTS, 'fail'),
    assets,
    assetsOverwrite: inputs.boolean('release-assets-overwrite', false),
  };
}
