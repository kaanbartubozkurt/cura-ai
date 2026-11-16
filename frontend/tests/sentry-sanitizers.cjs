// Run with: node tests/sentry-sanitizers.cjs (no dependencies beyond local TypeScript).
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../src/lib');
function load(name) {
  const filename = path.join(root, name + '.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(root);
  const original = mod.require.bind(mod);
  mod.require = value => value === './loadTimings' ? load('loadTimings') : original(value);
  mod._compile(compiled, filename);
  return mod.exports;
}
const { sanitizeSpan, sanitizeEvent, sanitizeBreadcrumb } = load('sentrySanitizers');
const api = 'https://api.example.com';
const origin = 'https://app.example.com';
const span = sanitizeSpan({ op: 'http.client', description: `GET ${api}/api/auth/users/123/sync?token=secret#frag`,
  data: { 'http.method': 'post', 'http.url': `${api}/api/auth/users/123/sync?token=secret`, 'url.query': 'token=secret', 'server.address': 'api.example.com' } }, api, origin);
assert.equal(span.description, 'POST /api/auth/users/:id/sync');
assert.equal(sanitizeSpan({ op: 'http.client', description: 'GET /api/auth/me?token=secret' }, api, origin).description, 'GET /api/auth/me');
assert.equal(span.data['url.template'], '/api/auth/users/:id/sync');
assert.equal(span.data['http.url'], `${api}/api/auth/users/123/sync`);
assert.equal(span.data['url.query'], '');
assert.equal(span.data['server.address'], 'api.example.com');
assert.equal(sanitizeSpan({ op: 'http.client', description: 'GET /api/auth/me?token=secret' }, '', origin).description, 'GET /api/auth/me');
assert.equal(sanitizeSpan({ op: 'http.client', description: 'GET https://external.com/item/123?sig=secret' }, api, origin).description, 'GET https://external.com/item/123');
for (const file of ['a.png', 'b.JPG', 'c.webp', 'abcdef1234567890', '12345678-1234-abcd-1234-123456789abc']) {
  assert.equal(sanitizeSpan({ op: 'resource.img', description: `https://blob.example.com/images/${file}?sig=secret#frag` }).description, 'https://blob.example.com/images/:file');
}
assert.equal(sanitizeSpan({ op: 'resource.script', description: 'https://cdn.example.com/app.js?v=123' }).description, 'https://cdn.example.com/app.js');
assert.equal(sanitizeSpan({ description: 'GET http://[bad?secret#frag' }).description, 'GET http://[bad');
assert.equal(sanitizeSpan({}).description, undefined);
assert.deepEqual(sanitizeBreadcrumb({ category: 'navigation', data: { from: '/a?token=secret', to: '/b#secret' } }).data, { from: '/a', to: '/b' });
const event = sanitizeEvent({ transaction: 'https://app.example.com/page?secret', request: { url: '/api?token=secret' }, breadcrumbs: [{ category: 'fetch', data: { url: '/api?secret' } }] });
assert.equal(event.transaction, 'https://app.example.com/page');
assert.equal(event.request.url, '/api');
assert.equal(event.breadcrumbs[0].data.url, '/api');
assert.equal(sanitizeEvent({ transaction: 'page action' }).transaction, 'page action');
console.log('Sentry sanitizer checks passed');
