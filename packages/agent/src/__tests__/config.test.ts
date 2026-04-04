import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('Agent Config Constants', () => {
  it('exports AGENT_ID', async () => {
    const mod = await import('../config.js');
    assert.ok(mod.AGENT_ID);
    assert.strictEqual(typeof mod.AGENT_ID, 'string');
    assert.ok(mod.AGENT_ID.length > 0);
  });

  it('exports COORDINATOR_URL', async () => {
    const mod = await import('../config.js');
    assert.ok(mod.COORDINATOR_URL);
    assert.strictEqual(typeof mod.COORDINATOR_URL, 'string');
    assert.ok(mod.COORDINATOR_URL.startsWith('http'));
  });
});
