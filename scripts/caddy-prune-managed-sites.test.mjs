import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pruneCaddySiteBlocks } from '../deploy/scripts/prune-caddy-site-blocks.mjs';

test('prunes matching unmanaged top-level Caddy site blocks only', () => {
  const source = `{
  auto_https disable_redirects
}

http://brightos.world {
  redir https://brightos.world{uri} permanent
}

brightos.world {
  encode zstd gzip
  handle_path /api/* {
    reverse_proxy 127.0.0.1:3020
  }
  handle {
    root * /srv/projects/brai/landing/public
    try_files {path} {path}.html {path}/ /index.html
    file_server
  }
}

api.brightos.world {
  reverse_proxy 127.0.0.1:3020
}

# BEGIN BRAI DEV/PREVIEW ENVIRONMENTS
brightos.world {
  root * /srv/projects/brai/deploy/site
  file_server
}
# END BRAI DEV/PREVIEW ENVIRONMENTS
`;

  const result = pruneCaddySiteBlocks(source, {
    managedMarker: 'BRAI DEV/PREVIEW ENVIRONMENTS',
    sites: ['http://brightos.world', 'brightos.world']
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, ['http://brightos.world', 'brightos.world']);
  assert.doesNotMatch(result.output, /landing\/public/);
  assert.match(result.output, /api\.brightos\.world/);
  assert.match(result.output, /# BEGIN BRAI DEV\/PREVIEW ENVIRONMENTS\nbrightos\.world/);
});

test('reports unchanged when matching blocks are already inside the managed block', () => {
  const source = `# BEGIN BRAI DEV/PREVIEW ENVIRONMENTS
http://app.brightos.world {
  redir https://app.brightos.world{uri} permanent
}

app.brightos.world {
  root * /srv/projects/brai/deploy/web
  file_server
}
# END BRAI DEV/PREVIEW ENVIRONMENTS
`;

  const result = pruneCaddySiteBlocks(source, {
    managedMarker: 'BRAI DEV/PREVIEW ENVIRONMENTS',
    sites: ['http://app.brightos.world', 'app.brightos.world']
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.removed, []);
  assert.equal(result.output, source);
});
