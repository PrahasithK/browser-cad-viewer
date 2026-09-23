import { TreeNode } from './tree-node.model';
import { ClientFeatureRecord } from './feature-record.model';
import { PlaneRef, SketchEntity, StepWorkerRequest } from '../workers/step-worker-messages.model';

/** `Omit` applied to each member of a union separately, so discriminants survive. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A cut/fuse target as recorded in the session log. Imported STEP bytes are replaced by the SHA-256
 * of those bytes (`blob`), so the log is plain JSON and each source file is stored once in a
 * saved project, however many features target it.
 */
export type LoggedBodyRef = { kind: 'imported'; blob: string; solidIndex: number } | { kind: 'feature'; featureId: string };

export type FeatureCreateRequest = Extract<
  StepWorkerRequest,
  { type: 'feature.extrude' | 'feature.revolve' | 'feature.sweep' | 'feature.loft' | 'feature.hole' | 'feature.filletChamfer' }
>;
export type FeatureEditRequest = Extract<StepWorkerRequest, { type: 'feature.edit' }>;

export type LoggedFeatureCreate = DistributiveOmit<FeatureCreateRequest, 'sessionId' | 'targetBody'> & { targetBody?: LoggedBodyRef };

/** `pending` until the worker answers. A failed create or sketch left no trace in the worker, so replay skips it; a failed edit may have partly applied (see `handleFeatureEdit`), so replay repeats it and expects it to fail again. */
export type SessionLogStatus = 'pending' | 'ok' | 'failed';

/**
 * One request the modeling session's worker processed, in order. Replaying the log into a fresh
 * session reproduces that worker's feature history exactly — including edits, which matters: a
 * sketch anchored to a face that a later edit moved is stored at its ORIGINAL position, so
 * re-creating features with only their final params would build it in the wrong place.
 */
export type SessionLogEntry =
  | { kind: 'sketch'; sketchId: string; planeRef: PlaneRef; entities: SketchEntity[]; faceAnchorFeatureId?: string; status: SessionLogStatus }
  | { kind: 'create'; request: LoggedFeatureCreate; status: SessionLogStatus }
  | { kind: 'edit'; request: Omit<FeatureEditRequest, 'sessionId'>; status: SessionLogStatus };

/** A byte range in the project file's binary section. */
export interface BinaryRef {
  offset: number;
  length: number;
}

export interface ProjectGeometry {
  positions: BinaryRef;
  indices: BinaryRef;
}

export interface ProjectBody {
  nodeId: string;
  id: string;
  name: string;
  solidIndex: number;
  /** Key into `ProjectFile.geometries` — Pattern/Mirror/Duplicate copies share one entry with their original. */
  geometryId: string;
  faceIdMap: BinaryRef;
  /** One entry per OCCT edge: its explorer index and its flattened sample points. */
  edges: { index: number; points: BinaryRef }[];
  color: string;
  opacity: number;
  metalness: number;
  roughness: number;
  polygonOffset: boolean;
  materialId?: string;
  visible: boolean;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  volume: number | null;
  surfaceArea: number | null;
  faceCount: number;
  edgeCount: number;
}

export interface ProjectImport {
  nodeId: string;
  fileName: string;
  /** SHA-256 of the original STEP file, a key into `ProjectFile.blobs`. */
  blob: string;
}

export const PROJECT_FORMAT = 'browser-cad-project';
export const PROJECT_VERSION = 1;

/**
 * The JSON header of a `.cadproj` file. Large arrays (meshes, STEP sources) live in the file's
 * binary section and are referenced by `BinaryRef`. See `ProjectService` for the container layout.
 */
export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: string;
  tree: { nodes: TreeNode[]; rootId: string | null; importId: string | null };
  imports: ProjectImport[];
  blobs: Record<string, BinaryRef>;
  geometries: Record<string, ProjectGeometry>;
  bodies: ProjectBody[];
  features: ClientFeatureRecord[];
  /** Null when the log couldn't be saved faithfully (a feature targeted STEP bytes that aren't an import of this document) — the parts still open, but their feature history isn't rebuilt. */
  sessionLog: SessionLogEntry[] | null;
}
