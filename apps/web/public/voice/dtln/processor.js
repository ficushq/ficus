import dtln from './dtln.js?v=3'

const DTLN_FIXED_BUFFER_SIZE = 512

function hasValidAudioPort(ports) {
  return Boolean(ports && ports.length && ports[0] && ports[0].length)
}

class TauDtlnDenoiser extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.handle = undefined
    this.isModuleReady = false
    this.inputBuffer = new Float32Array(DTLN_FIXED_BUFFER_SIZE)
    this.outputBuffer = new Float32Array(DTLN_FIXED_BUFFER_SIZE)
    this.inputIndex = 0
    this.outputBytes = 0
    this.disableMetrics = Boolean(options?.processorOptions?.disableMetrics)

    const markReady = () => {
      this.isModuleReady = true
      this.port.postMessage('ready')
    }
    if (dtln.ready) markReady()
    else dtln.postRun.push(markReady)
  }

  process(inputs, outputs) {
    if (!hasValidAudioPort(inputs) || !hasValidAudioPort(outputs)) return true

    const input = inputs[0][0]
    const output = outputs[0][0]

    if (!this.isModuleReady) {
      // Pass raw audio through until WASM finishes initializing so connecting
      // voice does not create an artificial silence window.
      output.set(input.subarray(0, output.length))
      return true
    }

    try {
      if (!this.handle) this.handle = dtln.dtln_create()
      this.processFrame(input, output)
    } catch (error) {
      this.port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      output.set(input.subarray(0, output.length))
      // A frame that threw part-way leaves inputIndex past the buffer; the next
      // frame would then fail on inputBuffer.set forever. Start the frame over.
      this.inputIndex = 0
      this.outputBytes = 0
    }

    return true
  }

  processFrame(input, output) {
    this.inputBuffer.set(input, this.inputIndex)
    this.inputIndex += input.length

    if (this.inputIndex >= DTLN_FIXED_BUFFER_SIZE) {
      dtln.dtln_denoise(this.handle, this.inputBuffer, this.outputBuffer)
      this.inputIndex = 0
      this.outputBytes = DTLN_FIXED_BUFFER_SIZE
    }

    if (this.outputBytes > 0) {
      output.set(this.outputBuffer.subarray(0, input.length))
      this.outputBuffer.copyWithin(0, input.length)
      this.outputBytes = Math.max(0, this.outputBytes - input.length)
    } else {
      // DTLN needs the first 512-sample frame before it can output enhanced
      // speech. Avoid forwarding a partial unfiltered frame.
      output.fill(0)
    }
  }
}

registerProcessor('ficus-dtln-denoiser', TauDtlnDenoiser)
