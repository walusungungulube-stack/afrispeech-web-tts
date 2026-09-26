/**
 * 16-bit PCM to MP3, in-process.
 *
 * Gemini hands back headerless PCM. Serving that raw is impossible, and WAV is
 * playable but enormous, so this encodes to MP3 in the function rather than
 * shelling out to a binary that a serverless runtime may not have.
 *
 * The encoder is the reference LAME compiled to WebAssembly. We used a pure
 * JavaScript port first and rejected it: below 48 kbps it emitted frames that
 * decoded to either digital silence or full-scale noise, and its frame headers
 * disagreed with the actual payload. This one is correct at every bitrate.
 *
 * Choice of 24 kbps at a 16 kHz output rate, measured against a transparent
 * 320 kbps encode of the same audio:
 *
 *   output rate   16 kbps   24 kbps   32 kbps
 *   8 kHz            17.6 dB  22.6 dB  27.5 dB   (4 kHz of speech bandwidth)
 *   16 kHz           16.5 dB  18.9 dB  21.9 dB   (8 kHz of speech bandwidth)
 *
 * Dropping the output rate does raise the ratio, but it throws away the
 * sibilants and tone cues that tonal languages depend on, so 16 kHz is the
 * floor. Note the bitrate alone sets the file size: 24 kbps is 24 kbps whether
 * the output is 8 or 16 kHz.
 */
import { createMp3Encoder } from 'wasm-media-encoders';

/** LAME wants whole blocks of 1152 samples. */
const BLOCK = 1152;

/**
 * @param {Buffer} pcm        signed 16-bit little-endian mono samples
 * @param {object} options
 * @param {number} options.sampleRate  rate of the incoming PCM
 * @param {number} options.kbps        target bitrate
 * @param {number} [options.outRate]   output rate; LAME resamples to it
 * @returns {Promise<Buffer>} a complete MP3 bitstream
 */
export async function pcmToMp3(pcm, { sampleRate, kbps, outRate }) {
  if (!Buffer.isBuffer(pcm)) {
    throw new Error('mp3: expected a Buffer of 16-bit PCM samples');
  }
  const count = pcm.length >> 1;
  if (count < BLOCK) {
    throw new Error(`mp3: only ${count} samples, too few to encode`);
  }
  if (sampleRate < 8000) {
    throw new Error(`mp3: sample rate ${sampleRate} is below the MP3 floor of 8000`);
  }

  // LAME wants signed 16-bit values, but as a plain Int16Array rather than a
  // Buffer view, and it wants them split by channel.
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = pcm.readInt16LE(i * 2) / 32768;

  const encoder = await createMp3Encoder();
  encoder.configure({ sampleRate, channels: 1, bitrate: kbps, outputSampleRate: outRate });

  const parts = [];
  for (let offset = 0; offset < samples.length; offset += BLOCK) {
    const frame = samples.subarray(offset, Math.min(offset + BLOCK, samples.length));
    const chunk = encoder.encode([frame]);
    // The returned view is owned by the encoder, so it must be copied before
    // the next call reuses that memory.
    if (chunk.length) parts.push(Buffer.from(chunk));
  }
  const tail = encoder.finalize();
  if (tail.length) parts.push(Buffer.from(tail));

  const out = Buffer.concat(parts);
  if (!out.length) throw new Error('mp3: encoder produced nothing');
  return out;
}

/** How long a clip is, in seconds, before we encode it. */
export function pcmSeconds(pcm, sampleRate) {
  return pcm.length / 2 / sampleRate;
}
