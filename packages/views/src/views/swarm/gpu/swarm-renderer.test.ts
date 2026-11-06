// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSwarmRenderer, RENDERER_UNBUILT } from './swarm-renderer.js';

// A RENDERER THAT CANNOT BE BUILT SAYS SO. Past the checks the platform answers plainly (no WebGPU, no adapter, no
// context), a device request refused, a canvas that throws for its context, a shader the driver will not compile and
// a pipeline it will not validate are each a typed failure in the renderer's one sentence, with whatever it made let
// go — never a rejection that leaves the stage blank. The GPU is a fake that fails in each of those four places.

/** Where the fake GPU fails. */
type Failure = 'device' | 'context' | 'compile' | 'pipeline';

/** What a driver reports for a shader it will not compile, at a line and column of the source it was handed. */
const COMPILE_ERROR = { type: 'error', lineNum: 12, linePos: 3, message: 'unresolved identifier' };

function fakeGpu(failure: Failure) {
  const configure = vi.fn();
  const unconfigure = vi.fn();
  const destroy = vi.fn();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const createRenderPipelineAsync = vi.fn(async () => {
    if (failure === 'pipeline') throw new Error('swarm text: the pipeline failed validation');
    return {};
  });
  const device = {
    createShaderModule: ({ label }: { label: string }) => ({
      getCompilationInfo: async () => ({
        messages: failure === 'compile' && label === 'swarm body' ? [COMPILE_ERROR] : [],
      }),
    }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipelineAsync,
    addEventListener: () => {},
    destroy,
  };
  const adapter = {
    limits: { maxTextureDimension2D: 16384 },
    requestDevice: async () => {
      if (failure === 'device') throw new Error('the device request was refused');
      return device;
    },
  };
  vi.stubGlobal('navigator', {
    gpu: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' },
  });
  const canvas = {
    getContext: (kind: string) => {
      // A canvas whose control went to an OffscreenCanvas throws for its context rather than answering null.
      if (failure === 'context') throw new DOMException('the canvas was transferred', 'InvalidStateError');
      return kind === 'webgpu' ? { configure, unconfigure } : null;
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, configure, unconfigure, destroy, warn, createRenderPipelineAsync };
}

beforeEach(() => {
  // What a browser with WebGPU defines beside `navigator.gpu`. The renderer reads these flags as it builds: without
  // them a ReferenceError would fail the build before it reached the pipelines.
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
  vi.stubGlobal('GPUBufferUsage', {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512,
  });
  vi.stubGlobal('GPUTextureUsage', {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a swarm renderer that cannot be built', () => {
  it('answers a shader that will not compile with its sentence, and lets the device and the canvas go', async () => {
    const gpu = fakeGpu('compile');
    await expect(createSwarmRenderer(gpu.canvas)).resolves.toEqual({ ok: false, reason: RENDERER_UNBUILT });
    expect(gpu.configure).toHaveBeenCalledTimes(1);
    expect(gpu.unconfigure).toHaveBeenCalledTimes(1);
    expect(gpu.destroy).toHaveBeenCalledTimes(1);
    // The GPU's own words, line numbers and all, go to the console; the stage gets the sentence.
    expect(gpu.warn).toHaveBeenCalledWith(
      expect.stringContaining('[swarm]'),
      expect.objectContaining({ message: expect.stringContaining('swarm body: 12:3 unresolved identifier') }),
    );
  });

  it('answers a pipeline the driver will not validate the same way', async () => {
    const gpu = fakeGpu('pipeline');
    await expect(createSwarmRenderer(gpu.canvas)).resolves.toEqual({ ok: false, reason: RENDERER_UNBUILT });
    // The build reached the pipelines: the failure is theirs, never a missing global's on the way there.
    expect(gpu.createRenderPipelineAsync).toHaveBeenCalled();
    expect(gpu.unconfigure).toHaveBeenCalledTimes(1);
    expect(gpu.destroy).toHaveBeenCalledTimes(1);
  });

  it('answers a canvas that throws for its context the same way, and lets the device go', async () => {
    const gpu = fakeGpu('context');
    await expect(createSwarmRenderer(gpu.canvas)).resolves.toEqual({ ok: false, reason: RENDERER_UNBUILT });
    expect(gpu.configure).not.toHaveBeenCalled();
    expect(gpu.unconfigure).not.toHaveBeenCalled();
    expect(gpu.destroy).toHaveBeenCalledTimes(1);
  });

  it('answers a refused device request the same way, with nothing made to let go', async () => {
    const gpu = fakeGpu('device');
    await expect(createSwarmRenderer(gpu.canvas)).resolves.toEqual({ ok: false, reason: RENDERER_UNBUILT });
    expect(gpu.configure).not.toHaveBeenCalled();
    expect(gpu.unconfigure).not.toHaveBeenCalled();
    expect(gpu.destroy).not.toHaveBeenCalled();
  });
});
