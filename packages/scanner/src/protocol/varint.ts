/**
 * VarInt encoding/decoding utilities for Minecraft protocol
 * Adapted from MinecraftStatusPinger reference implementation
 */

/**
 * Encode a number as a VarInt
 */
export function encode(num: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let byte = num & 0x7f;
    num = num >> 7;
    if (num > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (num > 0);
  return new Uint8Array(bytes);
}

/**
 * Decode a VarInt from a byte array
 */
export function decode(varint: Uint8Array, offset = 0): number {
  let result = 0;
  let shift = 0;
  for (let i = offset; i < varint.length; i++) {
    const byte = varint[i];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  return result;
}

/**
 * Calculate the byte length of a VarInt encoded number
 */
export function encodingLength(num: number, offset = 0): number {
  let length = offset;
  do {
    length++;
    num = num >> 7;
  } while (num > 0);
  return length - offset;
}

/**
 * Concatenate multiple Uint8Arrays efficiently
 */
export function concatUI8(arrayOfArrays: Array<Uint8Array | number[]>): Uint8Array {
  // Convert any number arrays to Uint8Array
  for (let e = 0; e < arrayOfArrays.length; e++) {
    if (!(arrayOfArrays[e] instanceof Uint8Array)) {
      arrayOfArrays[e] = new Uint8Array(arrayOfArrays[e]);
    }
  }

  const fullLength = arrayOfArrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(fullLength);

  let offset = 0;
  for (let i = 0; i < arrayOfArrays.length; i++) {
    const elem = arrayOfArrays[i] as Uint8Array;
    result.set(elem, offset);
    offset += elem.byteLength;
  }

  return result;
}

/**
 * Craft a big-endian Int64 (8 bytes)
 */
export function craftInt64BE(value: bigint): Uint8Array {
  value = BigInt(value);

  const array = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    array[i] = Number(value & 0xFFn);
    value >>= 8n;
  }
  return array;
}

/**
 * Craft a big-endian UInt16 (2 bytes)
 */
export function craftUInt16BE(value: number): Uint8Array {
  const array = new Uint8Array(2);
  array[0] = (value >> 8) & 0xFF; // High byte
  array[1] = value & 0xFF; // Low byte
  return array;
}
