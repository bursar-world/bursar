export type ShieldedCircuitFiles = { readonly wasm: string; readonly zkey: string; readonly vkey: string };

/** Paths to the official Privacy Pools v1.3.0 artifacts. Node only. */
export declare const shieldedArtifacts: {
  readonly withdraw: ShieldedCircuitFiles;
  readonly commitment: ShieldedCircuitFiles;
};
