// AudioWorklet PCM tap for live (streaming) transcription (ADR-0014).
//
// Runs on the audio render thread. It receives mic audio (Float32, at the
// AudioContext's native sample rate — typically 48 kHz), buffers ~ every 128-
// sample render quantum, and posts Float32 frames of ~FRAME_MS back to the main
// thread. The main thread downsamples to 16 kHz mono and uploads to the local
// API — no encoding, no MediaRecorder (whose WebM chunks aren't independently
// decodable), no cloud speech service. Raw PCM only, to 127.0.0.1.

const FRAME_MS = 250; // post roughly 4x/second

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate is a global in the AudioWorkletGlobalScope (the context's rate).
    this._target = Math.round((sampleRate * FRAME_MS) / 1000);
    this._buf = new Float32Array(this._target);
    this._n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0]; // mono (we request 1 channel)
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this._buf[this._n++] = channel[i];
      if (this._n >= this._target) {
        // Copy out (the buffer is reused) and hand to the main thread.
        this.port.postMessage(this._buf.slice(0, this._n));
        this._n = 0;
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor("pcm-processor", PCMProcessor);
