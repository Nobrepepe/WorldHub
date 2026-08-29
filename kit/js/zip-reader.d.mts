import { PackageError } from './package-reader.mjs'

/** An archive that cannot be safely extracted is a package that cannot be read. */
export declare class ZipError extends PackageError {}

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  externalAttr: number
}

export declare function listZipEntries(buffer: Buffer): ZipEntry[]

/** Extract a package ZIP safely; refuses hostile names outright. */
export declare function extractZipSafely(zipPath: string, destination: string): void

/** The same, for callers that already hold the bytes. */
export declare function extractZipBuffer(buffer: Buffer, destination: string): void
