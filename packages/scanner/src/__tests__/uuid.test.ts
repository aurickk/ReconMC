import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isValidUUIDFormatSync, detectServerModeSync } from '../uuid.js';

describe('UUID Format Validation', () => {
  it('validates correct UUID format', () => {
    const validUUID = '550e8400-e29b-41d4-a716-446655440000';
    assert.strictEqual(isValidUUIDFormatSync(validUUID), true);
  });

  it('rejects invalid UUID format - too short', () => {
    const invalidUUID = '550e8400-e29b-41d4-a716';
    assert.strictEqual(isValidUUIDFormatSync(invalidUUID), false);
  });

  it('rejects invalid UUID format - no dashes', () => {
    const invalidUUID = '550e8400e29b41d4a716446655440000';
    assert.strictEqual(isValidUUIDFormatSync(invalidUUID), false);
  });

  it('rejects invalid UUID format - wrong characters', () => {
    const invalidUUID = '550e8400-e29b-41d4-a716-44665544ZZZZ';
    assert.strictEqual(isValidUUIDFormatSync(invalidUUID), false);
  });

  it('rejects empty string', () => {
    assert.strictEqual(isValidUUIDFormatSync(''), false);
  });

  it('rejects null/undefined', () => {
    assert.strictEqual(isValidUUIDFormatSync(null as any), false);
    assert.strictEqual(isValidUUIDFormatSync(undefined as any), false);
  });

  it('accepts uppercase UUID', () => {
    const uppercaseUUID = '550E8400-E29B-41D4-A716-446655440000';
    assert.strictEqual(isValidUUIDFormatSync(uppercaseUUID), true);
  });

  it('accepts mixed case UUID', () => {
    const mixedUUID = '550e8400-E29B-41d4-A716-446655440000';
    assert.strictEqual(isValidUUIDFormatSync(mixedUUID), true);
  });
});

describe('Server Mode Detection (Sync)', () => {
  it('returns unknown for empty player list', () => {
    const result = detectServerModeSync([]);
    assert.strictEqual(result, 'unknown');
  });

  it('returns online for valid UUID format', () => {
    const players = [
      { id: '550e8400-e29b-41d4-a716-446655440000', name: 'Player1' },
      { id: '660e8400-e29b-41d4-a716-446655440001', name: 'Player2' },
    ];
    const result = detectServerModeSync(players);
    assert.strictEqual(result, 'online');
  });

  it('returns unknown for mixed valid/invalid UUIDs', () => {
    const players = [
      { id: '550e8400-e29b-41d4-a716-446655440000', name: 'Player1' },
      { id: 'invalid-uuid', name: 'Player2' },
    ];
    const result = detectServerModeSync(players);
    assert.strictEqual(result, 'unknown');
  });

  it('returns unknown for invalid UUID format', () => {
    const players = [
      { id: 'not-a-uuid', name: 'Player1' },
    ];
    const result = detectServerModeSync(players);
    assert.strictEqual(result, 'unknown');
  });

  it('handles players without id', () => {
    const players = [
      { name: 'NoIDPlayer' } as any,
    ];
    const result = detectServerModeSync(players);
    assert.strictEqual(result, 'unknown');
  });
});
