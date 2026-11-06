import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpHandler, metadata } from '../../lib/relay-mcp';
import type { Distributor, RelayProfile } from '../../lib/relay-data';

type RpcPayload = { error: { code: number }; result: { content: unknown; supportedVersions: string[]; tools: unknown[]; isError: boolean } };
async function json(response: Response): Promise<RpcPayload> { return await response.json() as RpcPayload; }
const identity = { 'oai-authenticated-user-id': 'test-owner', 'oai-authenticated-user-email': 'owner@example.test' };
const record: Distributor = { id: 'test', company: 'Test distributor', phoneNumber: '+12025550123', city: '', state: 'GA', status: 'blocked', consentSource: 'test authorization', consentTimestamp: '2026-11-05T12:00:00Z', internalNotes: 'old', createdAt: '', updatedAt: '' };
function fixture() {
  let accesses = 0;
  const writes: unknown[] = [];
  const handler = createMcpHandler({
    bindings: async () => { accesses++; return { DB: {} as D1Database }; },
    listCalls: async () => [],
    listDistributors: async () => [{ ...record }],
    getRelayProfile: async () => ({ companyName: 'Haladir' } as RelayProfile),
    saveRelayProfile: async (_db, args) => { writes.push(args); return args as RelayProfile; },
    createDistributor: async (_db, args) => { writes.push(args); return { ...record, ...(args as object), status: 'research' }; },
    getDistributor: async (_db, id) => id === record.id ? { ...record } : null,
    saveDistributor: async (_db, distributor) => { writes.push(distributor); return distributor; },
    prepareOwnerTestCall: async () => ({ call: { id: 'owner-call' }, distributor: record } as never),
    prepareCall: async () => ({ call: { id: 'queue-call' }, distributor: { ...record, company: 'Test distributor' } } as never),
  });
  async function call(method: string, params: object = {}, authenticated = true) {
    return handler(new Request('https://relay.example/mcp', { method: 'POST', headers: authenticated ? identity : {}, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
  }
  return { call, handler, writes, accesses: () => accesses };
}
const cases = [
  ['prepare_owner_test_call', {}, { extra: true }],
  ['prepare_next_call', {}, { extra: true }],
  ['get_relay_status', {}, { extra: true }],
  ['list_call_queue', { status: 'ready', limit: 1 }, { status: 'invalid' }],
  ['get_recent_calls', { limit: 1 }, { limit: 1.5 }],
  ['get_haladir_call_brief', {}, { extra: true }],
  ['update_haladir_call_brief', { agentStyle: 'Friendly and curious' }, { approvedClaims: [123] }],
  ['add_distributor', { company: 'Test', phoneNumber: '+12025550123' }, { company: 'Test' }],
  ['update_distributor_notes', { id: 'test', internalNotes: 'New note' }, { id: 'test', internalNotes: 123 }],
] as const;
for (const [name, args, invalid] of cases) {
  test(`${name}: valid, invalid, and unauthenticated requests`, async () => {
    const f = fixture();
    assert.equal((await f.call('tools/call', { name, arguments: args }, false)).status, 401);
    assert.equal(f.accesses(), 0);
    const rejected = await json(await f.call('tools/call', { name, arguments: invalid }));
    assert.equal(rejected.error.code, -32602);
    assert.equal(f.accesses(), 0);
    assert.equal(f.writes.length, 0);
    const result = await json(await f.call('tools/call', { name, arguments: args }));
    assert.ok(result.result.content);
    assert.equal(f.accesses(), 1);
    if (name === 'update_distributor_notes') {
      const saved = f.writes[0] as Distributor;
      assert.equal(saved.status, 'blocked');
      assert.equal(saved.phoneNumber, record.phoneNumber);
      assert.equal(saved.consentSource, record.consentSource);
      assert.equal(saved.internalNotes, 'New note');
    }
  });
}
test('discovery and metadata require identity and do not access records', async () => {
  const f = fixture();
  for (const method of ['server/discover', 'initialize', 'tools/list', 'notifications/initialized']) {
    assert.equal((await f.call(method, {}, false)).status, 401);
  }
  const discovery = await json(await f.call('server/discover'));
  assert.deepEqual(discovery.result.supportedVersions, ['2026-07-28']);
  const listing = await json(await f.call('tools/list'));
  assert.equal(listing.result.tools.length, 9);
  assert.equal(f.accesses(), 0);
  assert.equal(metadata(new Request('https://relay.example/mcp')).status, 401);
  assert.equal(metadata(new Request('https://relay.example/mcp', { headers: identity })).headers.get('cache-control'), 'no-store');
});
test('malformed JSON, invalid envelopes, and invalid arguments fail before data access', async () => {
  const f = fixture();
  for (const [body, code] of [['{', -32700], ['null', -32600], ['[]', -32600], [JSON.stringify({ method: 'tools/list' }), -32600]] as const) {
    const r = await f.handler(new Request('https://relay.example/mcp', { method: 'POST', headers: identity, body }));
    assert.equal((await json(r)).error.code, code);
  }
  for (const args of [[], 'text', { limit: 0 }, { limit: 26 }, { limit: '2' }]) {
    assert.equal((await json(await f.call('tools/call', { name: 'get_recent_calls', arguments: args }))).error.code, -32602);
  }
  assert.equal((await json(await f.call('tools/call', { name: 'add_distributor', arguments: { company: 'Test', phoneNumber: '+12025550123', consentTimestamp: 'bad' } }))).error.code, -32602);
  assert.equal(f.accesses(), 0);
});
test('tool failures do not leak runtime details or credentials', async () => {
  const handler = createMcpHandler({ bindings: async () => { throw new Error('private-test-secret'); } });
  const r = await handler(new Request('https://relay.example/mcp', { method: 'POST', headers: identity, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_relay_status' } }) }));
  const payload = await json(r);
  assert.equal(payload.result.isError, true);
  assert.doesNotMatch(JSON.stringify(payload), /private-test-secret/);
});
