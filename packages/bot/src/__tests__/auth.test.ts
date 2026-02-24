import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateCrackedAccount, createCrackedAccount, getUsername, getAuthString } from '../auth/index.js';
import type { CrackedAccount, MicrosoftTokenAccount } from '../auth/types.js';

describe('Cracked Account Validation', () => {
  it('validates correct cracked account', () => {
    const account: CrackedAccount = { type: 'cracked', username: 'TestPlayer' };
    assert.strictEqual(validateCrackedAccount(account), true);
  });

  it('rejects empty username', () => {
    const account: CrackedAccount = { type: 'cracked', username: '' };
    assert.strictEqual(validateCrackedAccount(account), false);
  });

  it('rejects username over 16 chars', () => {
    const account: CrackedAccount = { type: 'cracked', username: 'ThisUsernameIsWayTooLong' };
    assert.strictEqual(validateCrackedAccount(account), false);
  });

  it('rejects non-cracked type', () => {
    const account = { type: 'microsoft', username: 'Test' } as any;
    assert.strictEqual(validateCrackedAccount(account), false);
  });
});

describe('Create Cracked Account', () => {
  it('creates account with valid username', () => {
    const account = createCrackedAccount('TestPlayer');
    assert.strictEqual(account.type, 'cracked');
    assert.strictEqual(account.username, 'TestPlayer');
  });

  it('truncates long username to 16 chars', () => {
    const account = createCrackedAccount('ThisUsernameIsWayTooLong');
    assert.strictEqual(account.username.length, 16);
  });
});

describe('Get Username', () => {
  it('returns username for cracked account', () => {
    const account: CrackedAccount = { type: 'cracked', username: 'Steve' };
    assert.strictEqual(getUsername(account), 'Steve');
  });

  it('returns placeholder for Microsoft account', () => {
    const account: MicrosoftTokenAccount = { 
      type: 'microsoft', 
      accessToken: 'test-token' 
    };
    assert.strictEqual(getUsername(account), 'Player');
  });
});

describe('Get Auth String', () => {
  it('returns offline for cracked account', () => {
    const account: CrackedAccount = { type: 'cracked', username: 'Steve' };
    assert.strictEqual(getAuthString(account), 'offline');
  });

  it('returns microsoft for Microsoft account', () => {
    const account: MicrosoftTokenAccount = { 
      type: 'microsoft', 
      accessToken: 'test-token' 
    };
    assert.strictEqual(getAuthString(account), 'microsoft');
  });
});
