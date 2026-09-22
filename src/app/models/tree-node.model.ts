export type TreeNodeType = 'assembly' | 'import' | 'body';

export interface TreeNode {
  id: string;
  label: string;
  type: TreeNodeType;
  children: TreeNode[];
  parentId: string | null;
  bodyId: string | null;
  expanded: boolean;
  visible: boolean;
  /**
   * `type: 'body'` nodes only: true when this body's `CadBody.solidIndex` is a real, currently-
   * valid index into its owning import's retained STEP source bytes — i.e. re-reading that
   * source and exploding it would actually produce this body's solid. Only ever true for bodies
   * registered straight from a STEP import (`Viewport.addLoadedBodies`). A body added later under
   * the same import node — a primitive, a sketch/extrude result, a Duplicate, or a Fillet/Chamfer
   * replacement — is a tree SIBLING of the real STEP bodies but has no such source, even though
   * `TreeNode.parentId` alone can't tell the two apart (both sit under the same `import` node).
   * `TreeService.getImportSource` checks this flag before returning anything, so callers
   * (`ExportService`, `SketchService`'s cut-target resolution, `FilletChamferToolService`) don't
   * misidentify a primitive/sketch body as STEP-sourced just because of where it happens to sit
   * in the tree. Irrelevant (always `false`) on `assembly`/`import` type nodes.
   */
  hasStepSource: boolean;
  /**
   * `type: 'body'` nodes only: the id of the `FeatureRecord` (parametric feature tree, Slice 1 —
   * see `services/feature-tree.service.ts`) that produced this body's current geometry, or `null`
   * for a body with no feature-tree entry (every pre-existing creation path: STEP import,
   * primitives, Duplicate, Pattern/Mirror, and any Extrude call that didn't opt into the
   * feature-tree flow via `producesBodyId`). Unlike `hasStepSource`, this is NOT cleared by
   * `TreeService.replaceBody` — a feature-produced body keeps pointing at the same feature record
   * across an edit, since editing is exactly what's supposed to happen to it (the whole point of
   * this field existing).
   */
  featureId: string | null;
}
