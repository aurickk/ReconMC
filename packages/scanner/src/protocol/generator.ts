import * as varint from './varint.js';

/**
 * Craft a Minecraft handshake packet
 */
export async function craftHandshake(
  hostname: string,
  port: number,
  protocolVersion: number
): Promise<Uint8Array> {
  const packetBody = await craftHandshakeBody(hostname, port, protocolVersion);

  // Field 1: Length of the entire object (VarInt)
  // Field 2: PacketID (VarInt)
  // Field 3: The body of the request
  const packetID = 0;

  const packetLengthBuffer = varint.encode(varint.encodingLength(packetID) + packetBody.length);
  const packetIDBuffer = varint.encode(packetID);

  return varint.concatUI8([
    packetLengthBuffer,
    packetIDBuffer,
    packetBody
  ]);
}

/**
 * Craft the handshake packet body
 */
async function craftHandshakeBody(
  hostname: string,
  port: number,
  protocolVersion: number
): Promise<Uint8Array> {
  // Field 1: The Protocol Version (VarInt)
  // Field 2: The hostname of the server (String) prefixed with its length (VarInt)
  // Field 3: The port of the server (UInt16)
  // Field 4: Next expected state - 1 for status, 2 for login (VarInt)

  const protocolVersionBuffer = varint.encode(protocolVersion);
  const hostnamePrefixBuffer = varint.encode(hostname.length);
  const hostnameBuffer = new TextEncoder().encode(hostname);
  const portBuffer = varint.craftUInt16BE(port);
  const nextStateBuffer = varint.encode(1); // 1 = status

  return varint.concatUI8([
    protocolVersionBuffer,
    hostnamePrefixBuffer,
    hostnameBuffer,
    portBuffer,
    nextStateBuffer
  ]);
}

/**
 * Craft an empty packet (used for status request)
 */
export async function craftEmptyPacket(packetID: number): Promise<Uint8Array> {
  const packetLengthBuffer = varint.encode(varint.encodingLength(packetID));
  const packetIDBuffer = varint.encode(packetID);

  return varint.concatUI8([
    packetLengthBuffer,
    packetIDBuffer
  ]);
}

/**
 * Craft a ping packet for latency measurement
 */
export async function craftPingPacket(): Promise<Uint8Array> {
  // Field 1: Length of the entire object (VarInt)
  // Field 2: PacketID (VarInt)
  // Field 3: Payload (Int64/Long)

  // The payload is the current time, but it doesn't matter
  // The server should return the same value back
  const packetID = 1;

  const longBuffer = varint.craftInt64BE(BigInt(Date.now()));

  const packetLengthBuffer = varint.encode(varint.encodingLength(packetID) + longBuffer.length);
  const packetIDBuffer = varint.encode(packetID);

  return varint.concatUI8([
    packetLengthBuffer,
    packetIDBuffer,
    longBuffer
  ]);
}
