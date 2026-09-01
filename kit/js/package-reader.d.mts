/**
 * Types for the shared World Hub package reader.
 *
 * Package JSON is inherently untyped — it is data authored elsewhere and
 * validated structurally by loadPackage, so the catalog shapes are described
 * loosely on purpose. What is typed precisely is the part an application
 * actually calls.
 */

export type JsonObject = Record<string, any>

export interface AssetIndexEntry extends JsonObject {
  assetId: string
  versionId: string
  path: string
  recipeId: string
  setId?: string | null
  entityId?: string | null
  roles?: string[]
}

/** A published connection kind: what a canonical fact between two records means. */
export interface ConnectionKind extends JsonObject {
  id: string
  category: string
  forwardLabel: string
  inverseLabel: string
  forwardSection: string
  inverseSection: string
  symmetric: boolean
  builtin: boolean
  /** Ordered [sourceType, targetType] pairs this kind may join. */
  pairs: [string, string][]
}

/** A connection read from one record's side. */
export interface ConnectionFromHere extends JsonObject {
  id: string
  sourceId: string
  targetId: string
  kindId?: string
  /** "from" when the record asked about is the source, "to" when it is the target. */
  direction: 'from' | 'to'
  /** The record at the other end, whichever column it occupies. */
  otherId: string
  /** The label that record wears, resolved through the kind. */
  label: string
}

export interface RenamedFrom {
  recipes: Record<string, string[]>
  roles: Record<string, string[]>
}

export interface LoadOptions {
  /** The art vocabulary this application was built against. */
  supportedVocabularyVersion?: number
  /** What the application knows about renames, merged with the package's own. */
  renamedFrom?: RenamedFrom | null
}

export declare class PackageError extends Error {
  code: string
}

export declare class PackageInfo {
  readonly root: string
  readonly manifest: JsonObject
  readonly contract: JsonObject
  readonly content: JsonObject
  readonly entities: JsonObject[]
  readonly worlds: JsonObject[]
  readonly characters: JsonObject[]
  readonly relationships: JsonObject[]
  /** Empty for packages published before kinds were carried. */
  readonly connectionKinds: ConnectionKind[]
  readonly documents: JsonObject[]
  readonly assetIndex: AssetIndexEntry[]
  readonly checksums: Record<string, string>
  readonly tags: JsonObject[]
  readonly protocolVersion: number
  readonly renamedFrom: RenamedFrom

  get publicationId(): string
  get productionId(): string
  entitiesById(): Map<string, JsonObject>
  absolute(packagePath: string): string
  assetEntries(assetId: string): AssetIndexEntry[]

  /** The recipes this package's own contract declares for a set, best first. */
  recipesFor(setId: string): string[]

  /** The asset set carrying one of these roles, first match wins. */
  setForRole(...roles: string[]): string | null

  /** Every published connection kind, by its stable id. */
  connectionKindsById(): Map<string, ConnectionKind>

  /** The label one end of a connection wears, resolved through its kind. */
  connectionLabel(connection: JsonObject, direction: 'from' | 'to'): string

  /** Every connection touching a record, written from that record's side. */
  connectionsFor(entityId: string): ConnectionFromHere[]

  /** Connections running out of a record, optionally of one kind only. */
  connectionsFrom(entityId: string, kindId?: string | null): JsonObject[]

  /** Connections running into a record, optionally of one kind only. */
  connectionsTo(entityId: string, kindId?: string | null): JsonObject[]

  /** The best index entry for an asset given a recipe preference order. */
  assetFile(assetId: string, preferredRecipes?: readonly string[]): AssetIndexEntry | null
}

export declare const SUPPORTED_PROTOCOL_VERSIONS: Set<number>
export declare const SUPPORTED_CONTRACT_FORMAT_VERSIONS: Set<number>
export declare const PACKAGE_FORMAT: string
export declare const CONTRACT_FORMAT: string

/** Validate a package directory completely; throw PackageError otherwise. */
export declare function loadPackage(
  root: string,
  expectedAppType: string,
  options?: LoadOptions
): PackageInfo

/** Read current.json from a linked World Hub production folder. */
export declare function readCurrentPointer(productionDir: string): JsonObject | null
