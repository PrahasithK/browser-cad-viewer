import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { TreeService } from './tree.service';
import { ViewerService } from './viewer.service';
import { SelectionService } from './selection.service';
import { PropertyService } from './property.service';
import { ObjectTransformService } from './object-transform.service';
import { FeatureTreeService } from './feature-tree.service';
import { HistoryService } from './history.service';
import { ModelingSessionService } from './modeling-session.service';
import { ExplodedViewService } from './exploded-view.service';
import { RenderService } from './render.service';
import { CameraService } from './camera.service';
import { downloadBlob } from './export.service';
import { sha256Hex } from '../utils/hash.util';
import { CadBody } from '../models/cad-body.model';
import { BinaryRef, PROJECT_FORMAT, PROJECT_VERSION, ProjectBody, ProjectFile, ProjectGeometry, ProjectImport } from '../models/project.model';

const MAGIC = 'CADPROJ1';
export const PROJECT_EXTENSION = '.cadproj';

/**
 * Save / Open / New for the whole modeling document.
 *
 * A project stores two things, because the model lives in two places:
 * - **The client scene, as a snapshot**: the tree, every body's render mesh, and its name, color,
 *   material, transform and visibility, plus the Feature Tree rows. Opening restores these
 *   exactly, with no kernel work, so every kind of body (imported, feature-built, primitive,
 *   Shell/Draft result, Pattern/Mirror copy) comes back as it was.
 * - **The worker's feature history, as a replay log** (`ModelingSessionService.exportLog`).
 *   Opening feeds it into a fresh session, so features stay editable and feature-built parts stay
 *   valid cut targets. The original STEP files are stored too (once each, keyed by SHA-256): they
 *   back re-reads of imported parts and any logged feature that targeted one.
 *
 * File layout: the ASCII magic `CADPROJ1`, a little-endian uint32 JSON length, the JSON header
 * (`ProjectFile`), then a binary section that the header points into with `BinaryRef`s. The whole
 * file is gzip-compressed where the browser supports `CompressionStream`; open accepts both.
 *
 * Not saved in v1: reference planes, the structural model, measurements, section planes, and Mesh
 * View overlays (the fine triangulation isn't kept client-side).
 */
@Injectable({ providedIn: 'root' })
export class ProjectService {
  /** Shown as a blocking overlay while a project opens or its feature history rebuilds. */
  readonly busyMessage = signal<string | null>(null);

  constructor(
    private readonly tree: TreeService,
    private readonly viewer: ViewerService,
    private readonly selection: SelectionService,
    private readonly property: PropertyService,
    private readonly objectTransform: ObjectTransformService,
    private readonly featureTree: FeatureTreeService,
    private readonly history: HistoryService,
    private readonly session: ModelingSessionService,
    private readonly exploded: ExplodedViewService,
    private readonly render: RenderService,
    private readonly camera: CameraService
  ) {}

  /**
   * Clears the whole document: scene, tree, Feature Tree, undo stack and the modeling session.
   * Shared by New, Open Project and Open STEP — the undo stack and session must go too, or an old
   * Undo could put a part from the previous document into the new one.
   */
  resetDocument(): void {
    this.selection.clearSelection();
    this.property.showProperties(null);
    this.objectTransform.setAttachedBody(null);
    this.exploded.reset();
    this.viewer.clearBodies();
    this.tree.reset();
    this.featureTree.reset();
    this.history.clear();
    this.session.dispose();
  }

  newDocument(): void {
    this.resetDocument();
    this.camera.resetCamera();
  }

  /** Downloads the current document as a `.cadproj` file. */
  async save(): Promise<void> {
    if (this.busyMessage()) return;
    this.busyMessage.set('Saving project…');
    try {
      // A save mid-operation would record an unfinished history, so let it finish first (a
      // Feature Tree edit that re-reads a large STEP file can take several seconds).
      await this.session.whenIdle();
      const { blob, fileName } = await this.serialize();
      downloadBlob(blob, fileName);
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Could not save the project: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busyMessage.set(null);
    }
  }

  async serialize(): Promise<{ blob: Blob; fileName: string }> {
    if (this.session.hasPendingWork()) throw new Error('an operation is still running — try again once it finishes.');

    const binary = new BinaryWriter();
    const treeState = this.tree.exportState();

    // Original STEP files, one blob each.
    const blobs: Record<string, BinaryRef> = {};
    const imports: ProjectImport[] = [];
    for (const [nodeId, source] of treeState.importSources) {
      const bytes = new Uint8Array(typeof source === 'string' ? await (await fetch(source)).arrayBuffer() : await source.arrayBuffer());
      const hash = await sha256Hex(bytes);
      if (!blobs[hash]) blobs[hash] = binary.add(bytes);
      const label = findLabel(treeState.nodes, nodeId) ?? 'model.step';
      imports.push({ nodeId, fileName: label, blob: hash });
    }

    // Bodies; copies that share a geometry (Pattern/Mirror/Duplicate) share one entry.
    const geometries: Record<string, ProjectGeometry> = {};
    const bodies: ProjectBody[] = [];
    for (const { nodeId, body } of this.tree.bodyEntries()) {
      const mesh = body.mesh;
      const geometry = mesh.geometry;
      if (!geometries[geometry.uuid]) {
        const index = geometry.index;
        if (!index) throw new Error(`${body.name} has no triangle index`);
        geometries[geometry.uuid] = {
          positions: binary.add(geometry.getAttribute('position').array as Float32Array),
          indices: binary.add(index.array instanceof Uint32Array ? index.array : Uint32Array.from(index.array))
        };
      }
      const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      bodies.push({
        nodeId,
        id: body.id,
        name: body.name,
        solidIndex: body.solidIndex,
        geometryId: geometry.uuid,
        faceIdMap: binary.add(body.faceIdMap),
        edges: body.edges.map((e) => ({ index: e.index, points: binary.add(Float32Array.from(e.points.flatMap((p) => [p.x, p.y, p.z]))) })),
        // body.color/opacity, not the material's: the global "Transparent" shading mode
        // temporarily overrides every material's opacity.
        color: body.color,
        opacity: body.opacity,
        metalness: material.metalness,
        roughness: material.roughness,
        polygonOffset: material.polygonOffset,
        materialId: body.materialId,
        visible: mesh.visible,
        position: mesh.position.toArray() as [number, number, number],
        quaternion: mesh.quaternion.toArray() as [number, number, number, number],
        scale: mesh.scale.toArray() as [number, number, number],
        volume: body.volume,
        surfaceArea: body.surfaceArea,
        faceCount: body.faceCount,
        edgeCount: body.edgeCount
      });
    }

    // The session log is only faithful if every STEP file it targets is stored above.
    const sessionLog = this.session.exportLog();
    const missingBlob = sessionLog.some((e) => e.kind === 'create' && e.request.targetBody?.kind === 'imported' && !blobs[e.request.targetBody.blob]);

    const header: ProjectFile = {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      savedAt: new Date().toISOString(),
      tree: { nodes: treeState.nodes, rootId: treeState.rootId, importId: treeState.importId },
      imports,
      blobs,
      geometries,
      bodies,
      features: this.featureTree.entries().map((f) => structuredClone(f)),
      sessionLog: missingBlob ? null : sessionLog
    };

    const json = new TextEncoder().encode(JSON.stringify(header));
    const lengthBytes = new Uint8Array(4);
    new DataView(lengthBytes.buffer).setUint32(0, json.byteLength, true);
    const raw = new Blob([new TextEncoder().encode(MAGIC), lengthBytes, json, ...binary.chunks]);
    const blob = typeof CompressionStream === 'undefined' ? raw : await new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob();

    const baseName = (imports[0]?.fileName ?? 'untitled').replace(/\.(step|stp)$/i, '');
    return { blob, fileName: `${baseName}${PROJECT_EXTENSION}` };
  }

  /** Replaces the current document with a saved project. */
  async open(file: File): Promise<void> {
    this.busyMessage.set('Opening project…');
    try {
      const { header, binary } = await readContainer(file);
      if (header.format !== PROJECT_FORMAT) throw new Error('this is not a project file.');
      if (header.version > PROJECT_VERSION) throw new Error(`it was saved by a newer version of this app (format v${header.version}).`);

      const slice = (ref: BinaryRef) => binary.slice(ref.offset, ref.offset + ref.length);
      const blobs = new Map<string, Uint8Array>(Object.entries(header.blobs).map(([hash, ref]) => [hash, new Uint8Array(slice(ref))]));

      this.resetDocument();

      const importSources = new Map<string, File>();
      for (const imp of header.imports) {
        const bytes = blobs.get(imp.blob);
        if (bytes) importSources.set(imp.nodeId, new File([bytes as Uint8Array<ArrayBuffer>], imp.fileName));
      }

      const geometries = new Map<string, THREE.BufferGeometry>();
      const geometryFor = (id: string): THREE.BufferGeometry => {
        let geometry = geometries.get(id);
        if (!geometry) {
          const g = header.geometries[id];
          geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(slice(g.positions)), 3));
          geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(slice(g.indices)), 1));
          geometry.computeVertexNormals();
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();
          geometries.set(id, geometry);
        }
        return geometry;
      };

      const bodies = new Map<string, CadBody>();
      for (const saved of header.bodies) bodies.set(saved.nodeId, this.buildBody(saved, geometryFor(saved.geometryId), slice));

      this.tree.restoreState(header.tree, bodies, importSources);
      for (const body of bodies.values()) this.viewer.addBody(body.mesh);
      this.featureTree.restore(header.features);
      // Carry a global Wireframe/Transparent view over to the new bodies. Solid is skipped: it
      // resets every material's opacity to 1, which would drop each part's own saved opacity.
      if (this.render.shadingMode() !== 'solid') this.render.setShadingMode(this.render.shadingMode());
      this.camera.fitAll();

      if (header.sessionLog === null) {
        if (header.features.length > 0) {
          // eslint-disable-next-line no-alert
          alert('The parts opened, but this project\'s feature history couldn\'t be saved with it, so Feature Tree edits and cuts into feature-built parts won\'t work.');
        }
      } else if (header.sessionLog.length > 0) {
        this.busyMessage.set('Rebuilding feature history…');
        try {
          await this.session.replay(header.sessionLog, blobs);
        } catch (err) {
          this.session.dispose();
          // eslint-disable-next-line no-alert
          alert(`The parts opened, but their feature history couldn't be rebuilt, so Feature Tree edits and cuts into feature-built parts won't work: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-alert
      alert(`Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busyMessage.set(null);
    }
  }

  private buildBody(saved: ProjectBody, geometry: THREE.BufferGeometry, slice: (ref: BinaryRef) => ArrayBuffer): CadBody {
    const material = new THREE.MeshStandardMaterial({
      color: saved.color,
      metalness: saved.metalness,
      roughness: saved.roughness,
      side: THREE.DoubleSide,
      opacity: saved.opacity,
      transparent: saved.opacity < 1,
      polygonOffset: saved.polygonOffset,
      polygonOffsetFactor: saved.polygonOffset ? 1 : 0,
      polygonOffsetUnits: saved.polygonOffset ? 1 : 0
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const faceIdMap = new Uint32Array(slice(saved.faceIdMap));
    mesh.userData['bodyId'] = saved.id;
    mesh.userData['faceIdMap'] = faceIdMap;
    mesh.position.fromArray(saved.position);
    mesh.quaternion.fromArray(saved.quaternion);
    mesh.scale.fromArray(saved.scale);
    mesh.visible = saved.visible;
    mesh.updateMatrixWorld(true);

    return {
      id: saved.id,
      name: saved.name,
      solidIndex: saved.solidIndex,
      mesh,
      geometry,
      visible: saved.visible,
      color: saved.color,
      opacity: saved.opacity,
      materialId: saved.materialId,
      boundingBox: geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      volume: saved.volume,
      surfaceArea: saved.surfaceArea,
      faceCount: saved.faceCount,
      edgeCount: saved.edgeCount,
      faceIdMap,
      edges: saved.edges.map((e) => {
        const flat = new Float32Array(slice(e.points));
        const points: THREE.Vector3[] = [];
        for (let i = 0; i < flat.length; i += 3) points.push(new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]));
        return { index: e.index, points };
      })
    };
  }
}

/** Collects the binary section: each `add` appends bytes and returns where they landed. */
class BinaryWriter {
  readonly chunks: Uint8Array<ArrayBuffer>[] = [];
  private length = 0;

  add(view: ArrayBufferView): BinaryRef {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    const ref = { offset: this.length, length: bytes.byteLength };
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    return ref;
  }
}

async function readContainer(file: File): Promise<{ header: ProjectFile; binary: ArrayBuffer }> {
  let buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  if (buffer.byteLength < MAGIC.length + 4 || new TextDecoder().decode(buffer.slice(0, MAGIC.length)) !== MAGIC) {
    throw new Error('this is not a project file.');
  }
  const jsonLength = new DataView(buffer).getUint32(MAGIC.length, true);
  const jsonStart = MAGIC.length + 4;
  const header = JSON.parse(new TextDecoder().decode(buffer.slice(jsonStart, jsonStart + jsonLength))) as ProjectFile;
  return { header, binary: buffer.slice(jsonStart + jsonLength) };
}

function findLabel(nodes: { id: string; label: string; children: { id: string; label: string; children: unknown[] }[] }[], id: string): string | undefined {
  for (const node of nodes) {
    if (node.id === id) return node.label;
    const found = findLabel(node.children as typeof nodes, id);
    if (found) return found;
  }
  return undefined;
}
