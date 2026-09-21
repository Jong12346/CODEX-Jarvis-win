// Read-only, offline inspection; no credentials, playback or uploads.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readWav, toMonoPcm16, measurePcm16 } from './wav-audio.mjs'

const input = process.argv[2] ?? fileURLToPath(new URL('../.tmp/reply.wav', import.meta.url))
try {
  const wav = readWav(readFileSync(input))
  const pcm = toMonoPcm16(wav, wav.sampleRate)
  console.log(JSON.stringify({
    format: wav.format, channels: wav.channels, bits: wav.bits,
    ...measurePcm16(pcm, wav.sampleRate),
    listeningCheck: 'manual',
  }, null, 2))
} catch (error) {
  console.error(error.code === 'ENOENT' ? '找不到输入 WAV 文件。' : error.message)
  process.exitCode = 2
}
