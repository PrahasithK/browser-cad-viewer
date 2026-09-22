// Browser-safe no-op stand-in for Node builtins (fs, path) that Emscripten's
// UMD-style glue references only inside an `ENVIRONMENT_IS_NODE` branch that
// never executes in the browser. These exports are never actually called.
export default {};
