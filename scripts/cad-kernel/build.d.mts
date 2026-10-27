export const cadKernelBuild: {
  id: string;
  config: string;
  image: string;
  js: string;
  wasm: string;
  wasmSha256: string;
};
export const cadKernelPrevious: {
  id: string;
  js: string;
  wasm: string;
  wasmSha256: string;
  substitute?: boolean;
  revoked?: boolean;
}[];
