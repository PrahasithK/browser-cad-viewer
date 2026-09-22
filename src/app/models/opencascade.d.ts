declare module 'opencascade.js/dist/opencascade.wasm.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initOpenCascade: (options?: { locateFile?: (path: string) => string }) => Promise<any>;
  export default initOpenCascade;
}
