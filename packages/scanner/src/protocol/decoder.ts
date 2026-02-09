import * as varint from './varint.js';
import type { Packet } from '../types.js';

/**
 * Process incoming packet data chunks
 * Handles packet parsing, state management, and latency calculation
 */
export function packetPipeline(chunk: Uint8Array, packet: Packet): Packet {
  // If ping was sent, the next packet should be the pong response
  // The pong is a NEW packet, not a continuation of the status response
  if (packet.status.pingSent && !packet.status.pingBaked) {
    // Pong packets are typically 9-10 bytes (length varint + packet ID 1 + 8 byte payload)
    // The chunk should be a complete packet by itself
    if (chunk.length >= 9) {
      // Parse the pong packet directly
      return handlePongPacket(chunk, packet);
    }
  }

  // Append new chunk to buffer
  packet.dataBuffer = varint.concatUI8([
    packet.dataBuffer,
    chunk
  ]);

  // Prevent buffer overflow attacks
  if (packet.dataBuffer.length > 102400) {
    packet.error = new Error('Maximum buffer size of 100 Kilobytes reached. The status packet should be smaller than 20 Kilobytes.');
    return packet;
  }

  // Initialize packet metadata if not done
  if (!packet.meta.packetInitialized) {
    packet = craftPacketMeta(packet);
  }

  // Check if we have received the full packet
  if (packet.dataBuffer.length !== packet.meta.fullLength) {
    return packet;
  }

  // Parse packet data
  if (!packet.meta.fieldsCrafted) {
    packet = craftData(packet);
  }

  return packet;
}

/**
 * Handle the pong packet separately from status response
 * The pong is a new packet with packet ID 1
 */
function handlePongPacket(chunk: Uint8Array, packet: Packet): Packet {
  // Pong packet format: [varint length] [varint packet ID=1] [8 bytes payload]
  // The first varint is the packet length (should be 9: 1 for packet ID + 8 for payload)
  const length = varint.decode(chunk);
  if (length !== 9) {
    // Not a pong packet, process normally
    packet.dataBuffer = varint.concatUI8([packet.dataBuffer, chunk]);
    return packet;
  }

  const lengthBytes = varint.encodingLength(length);
  const packetID = varint.decode(chunk, lengthBytes);

  if (packetID !== 1) {
    // Not a pong packet, process normally
    packet.dataBuffer = varint.concatUI8([packet.dataBuffer, chunk]);
    return packet;
  }

  // This is a pong packet! Calculate latency
  packet.crafted.latency = Date.now() - packet.status.pingSentTime!;
  packet.status.pingBaked = true;

  return packet;
}

/**
 * Extract and decode packet data
 */
function craftData(packet: Packet): Packet {
  // Slice off the metadata fields to get the data
  packet.fieldsBuffer = packet.dataBuffer.slice(packet.meta.metaLength!);

  // First field is the string length (VarInt)
  const fieldLength = varint.decode(packet.fieldsBuffer);

  // Extract the actual JSON data
  packet.fieldsBuffer = packet.fieldsBuffer.slice(
    varint.encodingLength(fieldLength),
    fieldLength + varint.encodingLength(fieldLength)
  );

  // Decode UTF-8 string
  packet.crafted.data = new TextDecoder().decode(packet.fieldsBuffer);
  packet.status.handshakeBaked = true;

  return packet;
}

/**
 * Parse packet metadata (length, packet ID)
 */
function craftPacketMeta(packet: Packet): Packet {
  // Field 1: Length of the packet (VarInt)
  // Field 2: Packet ID (VarInt)
  // Field 3: Data fields

  packet.meta.dataLength = varint.decode(packet.dataBuffer);
  packet.meta.fullLength = varint.encodingLength(packet.meta.dataLength) + packet.meta.dataLength;
  packet.meta.packetID = varint.decode(packet.dataBuffer, varint.encodingLength(packet.meta.dataLength));
  packet.meta.metaLength = varint.encodingLength(packet.meta.dataLength) + varint.encodingLength(packet.meta.packetID);

  packet.meta.packetInitialized = true;

  if (packet.meta.dataLength === null ||
      packet.meta.fullLength === null ||
      packet.meta.packetID === null) {
    packet.error = new Error('Invalid packet was received.');
  }

  return packet;
}
