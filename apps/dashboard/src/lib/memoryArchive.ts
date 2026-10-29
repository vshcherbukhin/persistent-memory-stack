import type { MemoryExportEnvelope, MemoryExportOptions } from './types'

export type MemoryArchiveSchema = 'pm.memory-export/1' | 'pm.memory-export/2'
export interface MemoryArchive { schema: MemoryArchiveSchema; memories: unknown[]; exportedAt?: string; exportOptions?: MemoryExportOptions; legacyArray?: boolean }
export interface MemoryArchiveImport { schema: MemoryArchiveSchema; memories: unknown[]; ownerConfirmation: true }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Keep accepted old-format readers explicit; never turn unknown envelopes into generic writes. */
export function readMemoryArchive(value: unknown): MemoryArchive {
  if (Array.isArray(value)) return { schema: 'pm.memory-export/1', memories: value, legacyArray: true }
  if (!record(value) || !['pm.memory-export/1', 'pm.memory-export/2'].includes(String(value.schema)) || !Array.isArray(value.memories)) throw new Error('Unsupported memory archive. Use a supported .pm or JSON export; no records were written.')
  if ('count' in value && value.count !== value.memories.length) throw new Error('The archive count does not match its records. Verify the original export before importing.')
  if (value.schema === 'pm.memory-export/2') {
    for (const [index, item] of value.memories.entries()) {
      if (!record(item) || !Number.isInteger(item.revision) || Number(item.revision) < 1 || !('classification' in item) || !Array.isArray(item.revisionHistory)) throw new Error(`Version 2 row ${index + 1} is missing its revision, classification or history. Use the original archive; metadata was not inferred.`)
    }
  }
  return {
    schema: value.schema as MemoryArchiveSchema, memories: value.memories,
    ...(typeof value.exportedAt === 'string' ? { exportedAt: value.exportedAt } : {}),
    ...(record(value.exportOptions) ? { exportOptions: value.exportOptions as MemoryExportOptions } : {}),
  }
}

/** Encryption wraps the complete versioned payload; the inner format owns revision semantics. */
export function archiveForExport(value: MemoryExportEnvelope): MemoryExportEnvelope {
  readMemoryArchive(value)
  return value
}

export type SecureExportFile = {
  schema: 'pm.secure-memory-export/1'
  exportOptions?: MemoryExportOptions
  crypto: {
    algorithm: 'AES-GCM'
    kdf: 'PBKDF2-SHA256'
    iterations: number
    salt: string
    iv: string
  }
  payload: string
}

const KDF_ITERATIONS = 210_000


export async function encryptMemoryArchive(payload: MemoryExportEnvelope, passphrase: string): Promise<SecureExportFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(passphrase, toArrayBuffer(salt))
  const encoded = new TextEncoder().encode(JSON.stringify(payload))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, encoded))
  return {
    schema: 'pm.secure-memory-export/1',
    exportOptions: payload.exportOptions,
    crypto: {
      algorithm: 'AES-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: KDF_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
    payload: bytesToBase64(cipher),
  }
}

export async function decryptMemoryArchive(file: SecureExportFile, passphrase: string): Promise<MemoryExportEnvelope> {
  if (file.crypto.algorithm !== 'AES-GCM' || file.crypto.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(file.crypto.iterations) || file.crypto.iterations < 100_000 || file.crypto.iterations > 1_000_000) throw new Error('Unsupported secure archive encryption parameters.')
  const salt = base64ToBytes(file.crypto.salt)
  const iv = base64ToBytes(file.crypto.iv)
  if (salt.length !== 16 || iv.length !== 12) throw new Error('Invalid secure archive salt or nonce.')
  const key = await deriveAesKey(passphrase, toArrayBuffer(salt), file.crypto.iterations)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(base64ToBytes(file.payload)))
  return JSON.parse(new TextDecoder().decode(plain)) as MemoryExportEnvelope
}

async function deriveAesKey(passphrase: string, salt: BufferSource, iterations = KDF_ITERATIONS): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function bytesToBase64(bytes: Uint8Array) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.slice(i, i + 0x8000))
  return btoa(out)
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}
