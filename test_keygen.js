const fetch = require('node-fetch');
async function test() {
  const response = await fetch('https://api.keygen.sh/v1/accounts/dcc57dd7-bfd1-4469-a4f4-7c8545660f76/licenses/actions/validate-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.api+json', 'Accept': 'application/vnd.api+json' },
    body: JSON.stringify({ meta: { key: '86144C-6F9F1B-D7FF33-D25972-457482-V3', scope: { fingerprint: 'test-fingerprint' } } })
  });
  console.log(await response.json());
}
test();
