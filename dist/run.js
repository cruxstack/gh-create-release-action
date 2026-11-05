import { openAsBlob } from 'node:fs';
import { path } from './lib/github.js';
import { isCommitSha } from './lib/refname.js';
import { readBodyFile, resolveAssets } from './files.js';
const MAX_BODY_CHARS = 125_000;
const UPLOAD_CONCURRENCY = 4;
export async function run(config, { github, log }) {
    const repoPath = path `/repos/${config.owner}/${config.repo}`;
    // Validate local files before any API change.
    const assets = await resolveAssets(config.workspace, config.assets);
    const fileBody = config.bodyFile === undefined ? undefined : await readBodyFile(config.workspace, config.bodyFile);
    const existing = await findRelease(github, repoPath, config.tag);
    if (existing) {
        if (config.ifExists === 'fail')
            throw new Error(`a release for ${config.tag} already exists: ${existing.html_url}`);
        if (config.ifExists === 'skip') {
            log.info(`Release for ${config.tag} already exists; skipping`);
            return outputs(existing, 'skipped', []);
        }
    }
    const tagSha = await tagCommit(github, repoPath, config.tag);
    if (tagSha && config.target && isCommitSha(config.target) && tagSha !== config.target) {
        throw new Error(`tag ${config.tag} points at ${tagSha}, not release-target ${config.target}`);
    }
    if (!existing && !tagSha && !config.target) {
        throw new Error(`tag ${config.tag} does not exist; set release-target to create it`);
    }
    const body = await composeBody(github, repoPath, config, fileBody, tagSha !== undefined);
    return existing
        ? update(github, repoPath, config, existing, body, assets, log)
        : create(github, repoPath, config, tagSha !== undefined, body, assets, log);
}
/** Published releases by tag; drafts are only visible in the release list (newest first). */
async function findRelease(github, repoPath, tag) {
    const res = await github.request('GET', repoPath + path `/releases/tags/${tag}`, { allowStatus: [404] });
    if (res.status !== 404)
        return res.data;
    for await (const release of github.paginate(`${repoPath}/releases`)) {
        if (release.draft && release.tag_name === tag)
            return release;
    }
    return undefined;
}
async function tagCommit(github, repoPath, tag) {
    const res = await github.request('GET', repoPath + path `/git/ref/tags/${tag}`, { allowStatus: [404] });
    if (res.status === 404)
        return undefined;
    let object = res.data.object;
    for (let depth = 0; object.type === 'tag'; depth++) {
        if (depth === 10)
            throw new Error('annotated tag chain is too deep');
        object = (await github.request('GET', repoPath + path `/git/tags/${object.sha}`)).data.object;
    }
    if (object.type !== 'commit')
        throw new Error(`tag ${tag} points to a ${object.type}, not a commit`);
    return object.sha;
}
async function composeBody(github, repoPath, config, fileBody, tagExists) {
    let body = config.body ?? fileBody;
    if (config.notesGenerate) {
        const request = {
            tag_name: config.tag,
            ...(config.target && !tagExists ? { target_commitish: config.target } : {}),
            ...(config.notesPreviousTag ? { previous_tag_name: config.notesPreviousTag } : {}),
        };
        const notes = (await github.request('POST', `${repoPath}/releases/generate-notes`, { body: request, idempotent: true })).data.body;
        body = body ? `${body}\n\n${notes}` : notes;
    }
    if (body !== undefined && body.length > MAX_BODY_CHARS)
        throw new Error(`release body is longer than ${MAX_BODY_CHARS} characters`);
    return body;
}
async function create(github, repoPath, config, tagExists, body, assets, log) {
    // Created as a draft so assets are attached before anything is published.
    const draft = (await github.request('POST', `${repoPath}/releases`, {
        body: {
            tag_name: config.tag,
            name: config.name ?? config.tag,
            draft: true,
            prerelease: config.prerelease ?? false,
            ...(body === undefined ? {} : { body }),
            ...(tagExists ? {} : { target_commitish: config.target }),
        },
    })).data;
    log.info(`Created draft release ${draft.id} for ${config.tag}`);
    try {
        const uploaded = await uploadAssets(github, repoPath, draft, assets, [], false, log);
        let release = draft;
        if (!config.draft) {
            release = (await github.request('PATCH', `${repoPath}/releases/${draft.id}`, { body: { draft: false, make_latest: config.latest ?? 'true' } })).data;
            log.info(`Published ${release.html_url}`);
        }
        return outputs(release, 'created', uploaded);
    }
    catch (error) {
        try {
            await github.request('DELETE', `${repoPath}/releases/${draft.id}`, { allowStatus: [404] });
            log.info(`Deleted draft release ${draft.id} after failure`);
        }
        catch (cleanup) {
            log.warning(`Could not delete draft release ${draft.id}: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
        }
        throw error;
    }
}
async function update(github, repoPath, config, existing, body, assets, log) {
    const current = assets.length ? await listAssets(github, repoPath, existing.id) : [];
    // Upload first so a draft is complete before an update publishes it.
    const uploaded = await uploadAssets(github, repoPath, existing, assets, current, config.assetsOverwrite, log);
    const changes = {};
    if (config.name !== undefined)
        changes['name'] = config.name;
    if (body !== undefined)
        changes['body'] = body;
    if (config.prerelease !== undefined)
        changes['prerelease'] = config.prerelease;
    if (config.draft !== undefined)
        changes['draft'] = config.draft;
    if (config.latest !== undefined)
        changes['make_latest'] = config.latest;
    if (config.target !== undefined && existing.draft)
        changes['target_commitish'] = config.target;
    let release = existing;
    if (Object.keys(changes).length) {
        release = (await github.request('PATCH', `${repoPath}/releases/${existing.id}`, { body: changes })).data;
    }
    log.info(`Updated ${release.html_url}`);
    return outputs(release, 'updated', uploaded);
}
async function listAssets(github, repoPath, releaseId) {
    const assets = [];
    for await (const asset of github.paginate(`${repoPath}/releases/${releaseId}/assets`))
        assets.push(asset);
    return assets;
}
async function uploadAssets(github, repoPath, release, assets, current, overwrite, log) {
    const byName = new Map(current.map((a) => [a.name, a]));
    const conflicts = assets.filter((a) => byName.has(a.name)).map((a) => a.name);
    if (conflicts.length && !overwrite) {
        throw new Error(`assets already exist: ${conflicts.join(', ')}; set release-assets-overwrite to replace them`);
    }
    const uploadUrl = release.upload_url.replace(/\{[^}]*\}$/, '');
    return mapLimit(assets, UPLOAD_CONCURRENCY, async (asset) => {
        const old = byName.get(asset.name);
        if (old)
            await github.request('DELETE', `${repoPath}/releases/assets/${old.id}`, { allowStatus: [404] });
        const data = await openAsBlob(asset.path, { type: asset.contentType });
        const uploaded = (await github.request('POST', uploadUrl, { query: { name: asset.name }, data, contentType: asset.contentType })).data;
        log.info(`Uploaded ${uploaded.name} (${asset.size} bytes)`);
        return uploaded;
    });
}
/** Ordered map with bounded concurrency; stops starting work after the first failure. */
export async function mapLimit(items, limit, fn) {
    const results = [];
    let next = 0;
    let failure;
    const worker = async () => {
        while (!failure && next < items.length) {
            const index = next++;
            try {
                results[index] = await fn(items[index]);
            }
            catch (error) {
                failure ??= { error };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    if (failure)
        throw failure.error;
    return results;
}
function outputs(release, operation, uploaded) {
    return {
        'release-id': release.id,
        'release-url': release.html_url,
        'release-operation': operation,
        'release-assets': JSON.stringify(uploaded.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))),
    };
}
