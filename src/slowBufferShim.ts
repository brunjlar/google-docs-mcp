// src/slowBufferShim.ts
// Ensure compatibility with dependencies that still reference buffer.SlowBuffer
// (removed in newer Node releases like v25).
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const buffer = require('buffer');

if (!buffer.SlowBuffer) {
  buffer.SlowBuffer = buffer.Buffer;
}
