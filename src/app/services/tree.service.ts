import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import { TreeNode } from '../models/tree-node.model';
import { CadBody } from '../models/cad-body.model';
import { generateId } from '../utils/id-generator.util';

@Injectable({ providedIn: 'root' })
export class TreeService {
  readonly nodes = signal<TreeNode[]>([]);

  private readonly meshToNodeId = new Map<THREE.Object3D, string>();
  private readonly nodeIdToBody = new Map<string, CadBody>();
  /** Per-import raw source (a fetchable URL, or a retained File for user-picked imports), so a later cut can re-read the exact original STEP bytes. Kept off TreeNode itself (a File isn't plain cloneable data) — parallel side map, same shape as nodeIdToBody. */
  private readonly importSource = new Map<string, string | File>();
  private rootId: string | null = null;
  private importId: string | null = null;

  reset(): void {
    this.nodes.set([]);
    this.meshToNodeId.clear();
    this.nodeIdToBody.clear();
    this.importSource.clear();
    this.rootId = null;
    this.importId = null;
  }

  /**
   * Registers a new STEP import. If an assembly root already exists (a prior import wasn't
   * `reset()`), the new import is appended as a sibling under it instead of replacing the
   * tree — this is what lets a user add a second part file without losing the first.
   * `source` (a static asset URL, or the picked File for a user import) is retained so a later
   * cut into one of this import's bodies can re-read the original STEP bytes.
   */
  registerImport(fileName: string, source: string | File): string {
    const importId = generateId('import');
    this.importId = importId;
    this.importSource.set(importId, source);

    const importNode: TreeNode = {
      id: importId,
      label: fileName,
      type: 'import',
      children: [],
      parentId: this.rootId,
      bodyId: null,
      expanded: true,
      visible: true,
      hasStepSource: false,
      featureId: null
    };

    if (this.rootId) {
      this.nodes.update((current) => {
        const clone = structuredClone_(current);
        const assemblyNode = findNode(clone, this.rootId!);
        assemblyNode?.children.push({ ...importNode });
        return clone;
      });
      return importId;
    }

    const assemblyId = generateId('assembly');
    this.rootId = assemblyId;
    importNode.parentId = assemblyId;

    const assemblyNode: TreeNode = {
      id: assemblyId,
      label: 'Assembly',
      type: 'assembly',
      children: [importNode],
      parentId: null,
      bodyId: null,
      expanded: true,
      visible: true,
      hasStepSource: false,
      featureId: null
    };

    this.nodes.set([assemblyNode]);
    return importId;
  }

  /**
   * Lazily creates an assembly root plus one import-less "Modeling" import node, used only by
   * `registerBody` when a body is registered before any STEP import has ever run (see the
   * 2026-08-24 bug-fix note on `registerBody`). Deliberately not folded into `registerImport`
   * itself — that method always creates a real STEP-backed import node; this one creates a
   * placeholder import node with no `importSource` entry, so `getImportSource` correctly still
   * reports "no source" for anything registered under it (consistent with `hasStepSource: false`
   * on every body this holds).
   */
  private ensureRoot(): void {
    const assemblyId = generateId('assembly');
    const importId = generateId('import');
    this.rootId = assemblyId;
    this.importId = importId;

    const importNode: TreeNode = {
      id: importId,
      label: 'Modeling',
      type: 'import',
      children: [],
      parentId: assemblyId,
      bodyId: null,
      expanded: true,
      visible: true,
      hasStepSource: false,
      featureId: null
    };

    const assemblyNode: TreeNode = {
      id: assemblyId,
      label: 'Assembly',
      type: 'assembly',
      children: [importNode],
      parentId: null,
      bodyId: null,
      expanded: true,
      visible: true,
      hasStepSource: false,
      featureId: null
    };

    this.nodes.set([assemblyNode]);
  }

  /**
   * `hasStepSource` must be `true` only when `body.solidIndex` is a real, currently-valid index
   * into the current import's retained STEP source bytes — i.e. only for bodies registered
   * straight from a STEP import (`Viewport.addLoadedBodies`, the sole caller that passes `true`).
   * Every other caller (primitive creation, sketch/extrude, Duplicate) registers a body that sits
   * under the same import node for tree organization but has no such source, and must leave this
   * `false` (the default) — see `TreeNode.hasStepSource`'s docstring for why this can't be
   * inferred from tree position alone.
   *
   * Bug fix (2026-08-24): if this is the very first thing registered in a fresh/empty scene
   * (no STEP import has ever run, so `rootId`/`importId` are still `null` from `reset()`/initial
   * construction), lazily creates an assembly root plus one import-less "Modeling" import node to
   * parent under — mirroring `registerImport`'s own root-creation branch, minus a real STEP
   * source (there is none for a standalone primitive/sketch/Duplicate). Before this fix, a
   * primitive/sketch created as the first action in an empty scene (newly reachable once the
   * 2026-08-13 pass removed the always-present startup auto-load) added the mesh to the 3D scene
   * and `nodeIdToBody`/`meshToNodeId` correctly, but silently never appeared in `nodes` at all —
   * `findNode(clone, this.importId!)` with `importId === null` matches nothing, so the
   * `importNode?.children.push(node)` was a silent no-op with no error surfaced anywhere.
   */
  registerBody(body: CadBody, hasStepSource = false): string {
    if (!this.importId) this.ensureRoot();
    const nodeId = generateId('node');
    const node: TreeNode = {
      id: nodeId,
      label: body.name,
      type: 'body',
      children: [],
      parentId: this.importId,
      bodyId: body.id,
      expanded: true,
      visible: true,
      hasStepSource,
      featureId: null
    };

    this.meshToNodeId.set(body.mesh, nodeId);
    this.nodeIdToBody.set(nodeId, body);

    this.nodes.update((current) => {
      const clone = structuredClone_(current);
      const importNode = findNode(clone, this.importId!);
      importNode?.children.push(node);
      return clone;
    });

    return nodeId;
  }

  getNodeIdForMesh(mesh: THREE.Object3D): string | undefined {
    let current: THREE.Object3D | null = mesh;
    while (current) {
      const id = this.meshToNodeId.get(current);
      if (id) return id;
      current = current.parent;
    }
    return undefined;
  }

  getBodyForNodeId(nodeId: string): CadBody | undefined {
    return this.nodeIdToBody.get(nodeId);
  }

  findNode(nodeId: string): TreeNode | undefined {
    return findNode(this.nodes(), nodeId);
  }

  /**
   * Returns the STEP source bytes/URL a body's `solidIndex` can actually be re-read from, or
   * `undefined` if it can't. Two things must both hold: the body node itself must have
   * `hasStepSource: true` (real STEP-import bodies only — see `TreeNode.hasStepSource`'s
   * docstring for why a primitive/sketch/Duplicate body sitting under the same import node does
   * NOT qualify just because of where it sits in the tree), and that import must still have a
   * retained source in `importSource` (climbed via `parentId`, unchanged from before).
   */
  getImportSource(nodeId: string): string | File | undefined {
    const bodyNode = findNode(this.nodes(), nodeId);
    if (!bodyNode || bodyNode.type !== 'body' || !bodyNode.hasStepSource) return undefined;

    let node: TreeNode | undefined = bodyNode;
    while (node) {
      if (node.type === 'import') return this.importSource.get(node.id);
      node = node.parentId ? findNode(this.nodes(), node.parentId) : undefined;
    }
    return undefined;
  }

  /**
   * Links a body node to the `FeatureRecord` (parametric feature tree, Slice 1) that produced its
   * current geometry — called once, right after `registerBody`/`replaceBody`, by whichever
   * service built the feature (today: `SketchService`'s feature-tree-aware extrude path only).
   * Mirrors `getImportSource`'s existing lookup shape via `getFeatureId` below.
   */
  linkFeature(nodeId: string, featureId: string): void {
    this.nodes.update((current) => {
      const clone = structuredClone_(current);
      const node = findNode(clone, nodeId);
      if (node) node.featureId = featureId;
      return clone;
    });
  }

  getFeatureId(nodeId: string): string | null {
    return findNode(this.nodes(), nodeId)?.featureId ?? null;
  }

  /**
   * Centralizes the "resolve a body id to its re-readable STEP source bytes + solidIndex" chain
   * that was previously duplicated near-verbatim across `SketchService`, `FilletChamferToolService`,
   * `ShellToolService`, `DraftToolService`, and `HoleWizardService` (each with its own copy named
   * `resolveTargetBody`/`resolveCutTarget`). Only `SketchService`'s copy has been switched to
   * delegate here so far (Extrude is the only tool this slice touches) — the other four keep their
   * own copies for now, deliberately, so a follow-up migration pass can switch them over one at a
   * time rather than needing to re-derive this extraction. Returns `undefined` under the exact
   * same conditions the duplicated copies did: body not found, no owning node, or the node/import
   * doesn't qualify per `getImportSource`'s own rules.
   */
  async resolveFeatureCutTarget(bodyId: string): Promise<{ bytes: Uint8Array; solidIndex: number } | undefined> {
    const body = this.allBodies().find((b) => b.id === bodyId);
    if (!body) return undefined;
    const nodeId = this.getNodeIdForMesh(body.mesh);
    const source = nodeId ? this.getImportSource(nodeId) : undefined;
    if (!source) return undefined;
    const buffer = typeof source === 'string' ? await (await fetch(source)).arrayBuffer() : await source.arrayBuffer();
    return { bytes: new Uint8Array(buffer), solidIndex: body.solidIndex };
  }

  setNodeVisibility(nodeId: string, visible: boolean): void {
    const body = this.nodeIdToBody.get(nodeId);
    if (body) body.mesh.visible = visible;
    this.nodes.update((current) => {
      const clone = structuredClone_(current);
      const node = findNode(clone, nodeId);
      if (node) node.visible = visible;
      return clone;
    });
  }

  toggleExpanded(nodeId: string): void {
    this.nodes.update((current) => {
      const clone = structuredClone_(current);
      const node = findNode(clone, nodeId);
      if (node) node.expanded = !node.expanded;
      return clone;
    });
  }

  renameNode(nodeId: string, label: string): void {
    const trimmed = label.trim();
    if (!trimmed) return;

    const body = this.nodeIdToBody.get(nodeId);
    if (body) body.name = trimmed;

    this.nodes.update((current) => {
      const clone = structuredClone_(current);
      const node = findNode(clone, nodeId);
      if (node) node.label = trimmed;
      return clone;
    });
  }

  /** Removes a body node from the tree and its lookup maps. Caller is responsible for disposing the body's mesh in the scene. */
  deleteBody(nodeId: string): CadBody | undefined {
    const body = this.nodeIdToBody.get(nodeId);
    if (!body) return undefined;

    this.nodeIdToBody.delete(nodeId);
    this.meshToNodeId.delete(body.mesh);

    this.nodes.update((current) => {
      const clone = structuredClone_(current);
      removeNode(clone, nodeId);
      return clone;
    });

    return body;
  }

  /**
   * Replaces an existing body node's underlying CadBody in place — same node id, same parent,
   * same position in the tree — as opposed to `deleteBody`+`registerBody`, which would re-parent
   * the replacement under `this.importId` (the *last-registered* import), silently moving it out
   * from under its original import in a multi-import assembly. Caller is responsible for
   * disposing the old body's mesh from the scene and adding the new one (mirrors `deleteBody`'s
   * existing "caller owns scene mutation" contract).
   *
   * Always clears `hasStepSource` to `false` on the node: whatever produced this replacement (a
   * face-sketch cut, a Fillet/Chamfer) derived it via a boolean/fillet operation against the
   * ORIGINAL solid at this index — the replacement itself is no longer that original untouched
   * solid, so re-reading the import's STEP source at this same `solidIndex` would no longer
   * reproduce it. A second Fillet/Chamfer (or an export) on this node must not treat it as
   * STEP-sourced again.
   *
   * Deliberately does NOT touch `featureId` (parametric feature tree, Slice 1) — unlike
   * `hasStepSource`, a feature-produced body is SUPPOSED to keep pointing at the same feature
   * record across a replace, since a feature edit's whole purpose is to replace a body's geometry
   * in place while staying the "same" editable feature. See `TreeNode.featureId`'s own docstring.
   */
  replaceBody(nodeId: string, newBody: CadBody): void {
    const oldBody = this.nodeIdToBody.get(nodeId);
    if (!oldBody) return;

    // Carry the old mesh's placement over. Kernel results always come back in the solid's ORIGINAL
    // frame (the worker never sees the gizmo's view-level transform), so without this a body that
    // was moved/rotated/scaled snaps back to its pre-move position after any replace-in-place
    // operation (fillet, shell, cut, feature edit, ...).
    newBody.mesh.position.copy(oldBody.mesh.position);
    newBody.mesh.quaternion.copy(oldBody.mesh.quaternion);
    newBody.mesh.scale.copy(oldBody.mesh.scale);
    newBody.mesh.updateMatrixWorld(true);
    if (newBody.geometry.boundingBox) {
      newBody.boundingBox = newBody.geometry.boundingBox.clone().applyMatrix4(newBody.mesh.matrixWorld);
    }

    this.meshToNodeId.delete(oldBody.mesh);
    this.nodeIdToBody.set(nodeId, newBody);
    this.meshToNodeId.set(newBody.mesh, nodeId);

    this.nodes.update((current) => {
      const clone = structuredClone_(current);
      const node = findNode(clone, nodeId);
      if (node) {
        node.label = newBody.name;
        node.bodyId = newBody.id;
        node.hasStepSource = false;
      }
      return clone;
    });
  }

  allBodies(): CadBody[] {
    return [...this.nodeIdToBody.values()];
  }
}

function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

function removeNode(nodes: TreeNode[], id: string): boolean {
  const index = nodes.findIndex((n) => n.id === id);
  if (index !== -1) {
    nodes.splice(index, 1);
    return true;
  }
  return nodes.some((node) => removeNode(node.children, id));
}

// structuredClone would deep-clone THREE refs held elsewhere in the app; here TreeNode is plain data only
// (bodyId is a string reference, not a THREE object), so a plain structuredClone is safe.
function structuredClone_(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((n) => ({ ...n, children: structuredClone_(n.children) }));
}
