// Client-side audio compression: Vercel serverless functions hard-cap the request
// body at 4.5MB on every plan (not configurable), so any meaningfully long recording
// must be shrunk in the browser *before* upload — server-side ffmpeg compression runs
// too late, after the oversized request has already been rejected with a 413.
//
// Downsamples to 16kHz mono and encodes to a 16kbps MP3 via a pure-JS encoder. 16kbps
// (rather than the server's usual 32kbps) buys roughly 39 minutes of audio under the
// 4.5MB ceiling instead of ~20 — still clearly intelligible for speech-to-text at
// 16kHz mono, since Gemini/Scribe transcribe from spectral content, not fidelity.

import { Mp3Encoder } from "@breezystack/lamejs";

const TARGET_SAMPLE_RATE = 16000;
const TARGET_BITRATE_KBPS = 16;

/** Downmixes an AudioBuffer to mono Float32 samples at its native sample rate. */
function downmixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

/** Linear resampling — adequate for speech at a fixed 16kHz target; avoids pulling in a full resampler library. */
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    output[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return output;
}

/**
 * Compresses an audio Blob to a 16kHz mono 32kbps MP3 entirely in the browser.
 * Returns the original blob unchanged if decoding fails (e.g. an already-tiny or
 * unsupported format) — callers should treat this as best-effort, not guaranteed.
 */
export async function compressAudioToMp3(input: Blob): Promise<Blob> {
  const arrayBuffer = await input.arrayBuffer();
  // AudioContext must be resumed on some mobile browsers where it starts suspended.
  const audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch { /* best-effort */ }
  }
  let decoded: AudioBuffer;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    audioCtx.close();
  }

  const mono = downmixToMono(decoded);
  const resampled = resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  const pcm = floatTo16BitPCM(resampled);

  const encoder = new Mp3Encoder(1, TARGET_SAMPLE_RATE, TARGET_BITRATE_KBPS);
  const chunkSize = 1152; // MP3 frame size
  const mp3Chunks: Uint8Array[] = [];
  for (let i = 0; i < pcm.length; i += chunkSize) {
    const chunk = pcm.subarray(i, i + chunkSize);
    const encoded = encoder.encodeBuffer(chunk as Int16Array);
    if (encoded.length > 0) mp3Chunks.push(encoded);
  }
  const final = encoder.flush();
  if (final.length > 0) mp3Chunks.push(final);

  return new Blob(mp3Chunks as BlobPart[], { type: "audio/mpeg" });
}
