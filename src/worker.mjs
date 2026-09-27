/**
 * The Worker's entry point, and the only file in the project that knows the
 * encoder is WebAssembly.
 *
 * Everything else is shared with the Node server, which cannot import a .wasm
 * and does not need to: Node compiles the same encoder at runtime, which is
 * allowed there. Splitting the entry point keeps that import from being hoisted
 * into a runtime that would fail on it, rather than hiding it behind a
 * conditional that has to be guessed at.
 */
import mp3Wasm from './lib/mp3.wasm';
import { useEncoderModule } from './lib/mp3.mjs';
import worker from './index.mjs';

/* Once per isolate, which is enough. A workflow step executes inside the request
   that woke it, and every request runs in an isolate that has evaluated this
   module on the way in. */
useEncoderModule(mp3Wasm);

export default worker;
