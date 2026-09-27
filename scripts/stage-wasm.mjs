/**
 * Stage the MP3 encoder so the Worker bundle can compile it ahead of time.
 *
 * The encoder is LAME in WebAssembly, and there are three ways to reach it, of
 * which only one works on Workers. workerd refuses to generate code from a
 * WebAssembly binary at runtime, so the copy wasm-media-encoders carries inline
 * as a base64 data URI is unusable there. Cloudflare's wasm_modules binding is
 * rejected outright for module-based Workers, which is what an ES module entry
 * point is. What does work is importing the .wasm as a module under a
 * CompiledWasm rule: wrangler compiles it during the build and hands it over as
 * an already-built WebAssembly.Module, and WebAssembly.instantiate takes a
 * Module as readily as bytes.
 *
 * The catch is that the rule does not reach inside node_modules, so the file
 * has to be somewhere in the project tree when the bundle is built. It is copied
 * from the installed dependency rather than committed, so the encoder is always
 * the version the lockfile pins and the repository carries no binary that can
 * drift away from it. Node never sees this file: it encodes through the bundled
 * copy, and only src/worker.mjs imports the staged one.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'node_modules/wasm-media-encoders/wasm/mp3.wasm');
const to = resolve(root, 'src/lib/mp3.wasm');

const MAGIC = [0x00, 0x61, 0x73, 0x6d];

let bytes;
try {
  bytes = await readFile(from);
} catch {
  console.error(`mp3 encoder not found at ${from}\nRun npm install first.`);
  process.exit(1);
}

// A .wasm that is not a core module compiles to nothing useful, and the failure
// would otherwise surface as a baffling bundler error much later on.
if (!MAGIC.every((byte, i) => bytes[i] === byte)) {
  console.error(`${from} is not a WebAssembly module.`);
  process.exit(1);
}

await mkdir(dirname(to), { recursive: true });
await copyFile(from, to);
console.log(`staged mp3 encoder: ${(bytes.length / 1024).toFixed(1)} KB -> src/lib/mp3.wasm`);
