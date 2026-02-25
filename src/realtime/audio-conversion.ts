import { ConverterType, create } from "@alexanderolsen/libsamplerate-js";

const MU_LAW_BIAS = 0x84;
const MU_LAW_CLIP = 32635;
const PCM_SAMPLE_BYTES = 2;
const INT16_MAX = 32767;

export type LibSampleRateInstance = {
  simple: (data: Float32Array) => Float32Array;
  full: (data: Float32Array) => Float32Array;
  destroy: () => void;
};

type ConverterTypeEnum = (typeof ConverterType)[keyof typeof ConverterType];

export async function createResampler(
  inputSampleRate: number,
  outputSampleRate: number,
  options: { converterType?: ConverterTypeEnum } = {},
): Promise<LibSampleRateInstance> {
  const resampler = await create(1, inputSampleRate, outputSampleRate, {
    converterType: options.converterType ?? ConverterType.SRC_SINC_FASTEST,
  });
  return resampler as LibSampleRateInstance;
}

export function muLawToFloat32(buffer: Buffer): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    out[i] = muLawDecodeSample(buffer[i]) / 32768;
  }
  return out;
}

export function float32ToMuLaw(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const pcm = floatToInt16(samples[i]);
    out[i] = muLawEncodeSample(pcm);
  }
  return out;
}

export function pcm16BufferToFloat32(buffer: Buffer): Float32Array {
  const length = Math.floor(buffer.length / PCM_SAMPLE_BYTES);
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    length * PCM_SAMPLE_BYTES,
  );
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = view.getInt16(i * PCM_SAMPLE_BYTES, true) / 32768;
  }
  return out;
}

export function float32ToPcm16Buffer(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * PCM_SAMPLE_BYTES);
  for (let i = 0; i < samples.length; i++) {
    out.writeInt16LE(floatToInt16(samples[i]), i * PCM_SAMPLE_BYTES);
  }
  return out;
}

export function parseSampleRateFromMimeType(mimeType?: string): number | null {
  if (!mimeType) return null;

  const rateMatch = mimeType.match(/(?:^|;)\s*rate\s*=\s*(\d+)/i);
  const sampleRateMatch = mimeType.match(
    /(?:^|;)\s*sample_rate\s*=\s*(\d+)/i,
  );
  const match = rateMatch ?? sampleRateMatch;
  if (!match) return null;

  const rate = Number(match[1]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate;
}

function muLawEncodeSample(sample: number): number {
  let sign = 0;
  let pcm = sample;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
    if (pcm < 0) {
      pcm = INT16_MAX;
    }
  }

  if (pcm > MU_LAW_CLIP) {
    pcm = MU_LAW_CLIP;
  }

  pcm += MU_LAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  const muLaw = ~(sign | (exponent << 4) | mantissa);
  return muLaw & 0xff;
}

function muLawDecodeSample(muLaw: number): number {
  const ulaw = (~muLaw) & 0xff;
  const sign = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  let sample = ((mantissa << 3) + MU_LAW_BIAS) << exponent;
  sample -= MU_LAW_BIAS;
  return sign ? -sample : sample;
}

function floatToInt16(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0
    ? Math.round(clamped * 32768)
    : Math.round(clamped * INT16_MAX);
}
