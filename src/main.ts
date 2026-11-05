import { runAction } from './lib/actions.ts';
import { GitHub } from './lib/github.ts';
import { readConfig } from './config.ts';
import { run } from './run.ts';

await runAction(async (rt) => {
  const config = readConfig(rt.inputs, rt.env);
  rt.mask(config.token);
  const github = new GitHub({
    token: config.token,
    userAgent: 'cruxstack/gh-create-release-action',
    apiUrl: rt.env['GITHUB_API_URL'],
    log: rt.log,
  });
  return run(config, { github, log: rt.log });
});
