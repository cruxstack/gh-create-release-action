import { runAction } from './lib/actions.js';
import { GitHub } from './lib/github.js';
import { readConfig } from './config.js';
import { run } from './run.js';
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
