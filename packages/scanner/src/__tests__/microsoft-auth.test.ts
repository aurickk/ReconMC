import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { getCachedTokenValidity, setCachedTokenValidity, clearTokenValidityCache } from '../microsoft-auth.js';

describe('Token Validity Cache', () => {
  beforeEach(() => {
    clearTokenValidityCache();
  });

  it('returns null for uncached token', () => {
    const result = getCachedTokenValidity('nonexistent-token');
    assert.strictEqual(result, null);
  });

  it('stores and retrieves valid token', () => {
    const token = 'test-access-token-12345';
    const profile = { id: 'uuid-here', name: 'TestPlayer' };
    
    setCachedTokenValidity(token, true, profile);
    const result = getCachedTokenValidity(token);
    
    assert.ok(result);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.profile, profile);
  });

  it('stores invalid token result', () => {
    const token = 'invalid-token-xyz';
    
    setCachedTokenValidity(token, false);
    const result = getCachedTokenValidity(token);
    
    assert.ok(result);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.profile, undefined);
  });

  it('handles different tokens independently', () => {
    const token1 = 'token-one';
    const token2 = 'token-two';
    const profile1 = { id: 'id1', name: 'Player1' };
    const profile2 = { id: 'id2', name: 'Player2' };
    
    setCachedTokenValidity(token1, true, profile1);
    setCachedTokenValidity(token2, true, profile2);
    
    const result1 = getCachedTokenValidity(token1);
    const result2 = getCachedTokenValidity(token2);
    
    assert.strictEqual(result1?.profile?.name, 'Player1');
    assert.strictEqual(result2?.profile?.name, 'Player2');
  });

  it('clears all cached tokens', () => {
    setCachedTokenValidity('token-a', true, { id: 'a', name: 'A' });
    setCachedTokenValidity('token-b', true, { id: 'b', name: 'B' });
    
    clearTokenValidityCache();
    
    assert.strictEqual(getCachedTokenValidity('token-a'), null);
    assert.strictEqual(getCachedTokenValidity('token-b'), null);
  });

  it('handles same token with different hash positions', () => {
    const token = 'a'.repeat(100);
    const profile = { id: 'id', name: 'Test' };
    
    setCachedTokenValidity(token, true, profile);
    const result = getCachedTokenValidity(token);
    
    assert.strictEqual(result?.valid, true);
  });
});
