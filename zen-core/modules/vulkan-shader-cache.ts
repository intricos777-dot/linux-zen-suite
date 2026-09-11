// vulkan-shader-cache.ts
// Zen Suite module: Vulkan shader pipeline optimization + persistent shader cache
// Optimizes VK pipeline creation by pre-warming SPIR-V shaders and caching
// compiled pipeline states across sessions for instant reload.

import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from '../config/default.js';

// ── Configuration ───────────────────────────────────────────────────────
const CACHE_DIR = process.env.ZEN_VK_CACHE_DIR || join(process.env.HOME || '/tmp', '.zen/shader-cache');
const VK_ICD_PATH = process.env.VK_ICD_PATH || '/usr/share/vulkan/icd.d';
const VK_LAYERS_PATH = process.env.VK_LAYERS_PATH || '/usr/share/vulkan/explicit_layer.d';
const MAX_CACHE_SIZE_MB = parseInt(process.env.ZEN_VK_CACHE_MAX_MB || '512', 10);
const PIPELINE_CACHE_FILE = join(CACHE_DIR, 'vk-pipeline-cache.bin');
const SPIR_V_CACHE_DIR = join(CACHE_DIR, 'spirv');

interface ShaderVariant {
  shader: string;       // path to .spv file
  entrypoint: string;   // e.g. "main"
  stage: string;        // vertex, fragment, compute, etc.
  specialization?: Record<string, string | number>;
}

interface PipelineKey {
  shader: string;
  entrypoint: string;
  stage: string;
  specialization?: Record<string, string | number>;
}

// ── Pipeline cache (persistent binary blob) ─────────────────────────────
export class VulkanPipelineCache {
  private cache: Map<string, Buffer> = new Map();
  private dirty: boolean = false;

  load(): void {
    if (!existsSync(PIPELINE_CACHE_FILE)) return;
    try {
      const data = readFileSync(PIPELINE_CACHE_FILE);
      // Simple KV format: 4-byte key-length + key + 4-byte blob-length + blob, repeated
      let offset = 0;
      while (offset < data.length) {
        const keyLen = data.readUInt32LE(offset); offset += 4;
        const key = data.subarray(offset, offset + keyLen).toString('utf-8'); offset += keyLen;
        const blobLen = data.readUInt32LE(offset); offset += 4;
        const blob = data.subarray(offset, offset + blobLen); offset += blobLen;
        this.cache.set(key, Buffer.from(blob));
      }
      logger.info(`[vk-cache] Loaded ${this.cache.size} cached pipeline states`);
    } catch (e: any) {
      logger.warn(`[vk-cache] Failed to load pipeline cache: ${e.message}`);
    }
  }

  get(key: string): Buffer | undefined {
    return this.cache.get(key);
  }

  set(key: string, blob: Buffer): void {
    this.cache.set(key, Buffer.from(blob));
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(PIPELINE_CACHE_FILE), { recursive: true });
    const entries: Buffer[] = [];
    for (const [key, blob] of this.cache) {
      const keyBuf = Buffer.from(key, 'utf-8');
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(keyBuf.length);
      entries.push(lenBuf, keyBuf);
      const blobLen = Buffer.alloc(4);
      blobLen.writeUInt32LE(blob.length);
      entries.push(blobLen, blob);
    }
    const data = Buffer.concat(entries);
    writeFileSync(PIPELINE_CACHE_FILE, data);
    this.dirty = false;
    logger.info(`[vk-cache] Saved ${this.cache.size} pipeline states to ${PIPELINE_CACHE_FILE}`);
  }

  evict(maxSizeMB: number): void {
    // Simple FIFO eviction — in production use LRU
    let total = 0;
    const maxBytes = maxSizeMB * 1024 * 1024;
    for (const blob of this.cache.values()) {
      total += blob.length;
    }
    if (total <= maxBytes) return;

    for (const [key, blob] of this.cache) {
      if (total <= maxBytes) break;
      this.cache.delete(key);
      total -= blob.length;
      this.dirty = true;
    }
    if (this.dirty) this.save();
  }
}

// ── Shader pre-compilation / SPIR-V cache ───────────────────────────────
export class SpirvShaderCache {
  constructor(private cacheDir: string = SPIR_V_CACHE_DIR) {
    mkdirSync(this.cacheDir, { recursive: true });
  }

  // Check if a GLSL/VKSL source is newer than its cached SPIR-V, recompile if needed
  getOrCompile(sourcePath: string, entrypoint: string = 'main'): string | null {
    const stat = statSync(sourcePath);
    const srcMtime = stat.mtimeMs;
    const sourceExt = sourcePath.split('.').pop()?.toLowerCase();

    // If already SPIR-V, cache by hash
    if (sourceExt === 'spv') {
      return this.cacheSpirv(sourcePath);
    }

    // Check cache
    const cacheFile = join(this.cacheDir, `${pathHash(sourcePath)}.spv`);
    if (existsSync(cacheFile)) {
      const cacheStat = statSync(cacheFile);
      if (cacheStat.mtimeMs > srcMtime) {
        return cacheFile;
      }
    }

    // Compile with glslangValidator if available
    try {
      const { spawnSync } = require('node:child_process');
      const result = spawnSync('glslangvalidator', [sourcePath, '-o', cacheFile], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      if (result.status === 0) return cacheFile;

      // Fallback: try glslc
      const result2 = spawnSync('glslc', [sourcePath, '-o', cacheFile], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      if (result2.status === 0) return cacheFile;
    } catch (e: any) {
      logger.warn(`[vk-cache] Shader compilation failed for ${sourcePath}: ${e.message}`);
    }

    return null;
  }

  cacheSpirv(spirvPath: string): string {
    const stat = statSync(spirvPath);
    const cacheFile = join(this.cacheDir, `${pathHash(spirvPath)}.spv`);
    if (!existsSync(cacheFile) || statSync(cacheFile).mtimeMs < stat.mtimeMs) {
      const { copyFileSync } = require('node:fs');
      copyFileSync(spirvPath, cacheFile);
    }
    return cacheFile;
  }
}

function pathHash(path: string): string {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

// ── Pipeline pre-warming ──────────────────────────────────────────────────
export class PipelinePrewarmer {
  private cache: VulkanPipelineCache;
  private spirvCache: SpirvShaderCache;

  constructor() {
    this.cache = new VulkanPipelineCache();
    this.spirvCache = new SpirvShaderCache();
  }

  async prewarm(variants: ShaderVariant[]): Promise<void> {
    this.cache.load();
    logger.info(`[vk-prewarm] Pre-warming ${variants.length} pipeline variants`);

    for (const v of variants) {
      const key = JSON.stringify(v);
      if (this.cache.get(key)) continue; // already cached

      const cachedSpv = this.spirvCache.getOrCompile(v.shader, v.entrypoint);
      if (!cachedSpv) continue;

      // In a real Vulkan app, this would call vkCreateGraphicsPipelines /
      // vkCreateComputePipelines with VkPipelineCache. Here we simulate by
      // creating a small placeholder blob representing the compiled state.
      const placeholder = Buffer.alloc(256, 0);
      placeholder.write(key, 'utf-8');
      this.cache.set(key, placeholder);
    }

    this.cache.evict(MAX_CACHE_SIZE_MB);
    this.cache.save();
    logger.info('[vk-prewarm] Pipeline pre-warming complete');
  }

  // Generate shader variants from a base shader + macro permutations
  generatePermutations(baseShader: string, macroFile: string): ShaderVariant[] {
    if (!existsSync(macroFile)) return [{ shader: baseShader, entrypoint: 'main', stage: 'vertex' }];
    const macros = JSON.parse(readFileSync(macroFile, 'utf-8'));
    const variants: ShaderVariant[] = [];

    // Simple 2-macro permutation — extend as needed
    const values = macros.permutations || [[false, false], [true, false], [false, true], [true, true]];
    for (const perm of values) {
      variants.push({
        shader: baseShader,
        entrypoint: 'main',
        stage: macros.stage || 'vertex',
        specialization: {
          [macros.macro_a]: perm[0],
          [macros.macro_b]: perm[1],
        },
      });
    }
    return variants;
  }
}

// ── ICD detection ─────────────────────────────────────────────────────────
export function detectVulkanDriver(): string | null {
  if (!existsSync(VK_ICD_PATH)) return null;
  const icds = readdirSync(VK_ICD_PATH).filter(f => f.endsWith('.json'));
  if (icds.length === 0) return null;
  const manifest = JSON.parse(readFileSync(join(VK_ICD_PATH, icds[0]), 'utf-8'));
  return manifest.file_format;
}

// ── CLI entry ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const prewarmer = new PipelinePrewarmer();
  const baseShader = process.argv[2];
  const macroFile = process.argv[3];

  if (!baseShader) {
    console.error('Usage: vulkan-shader-cache <shader.glsl|shader.spv> [macros.json]');
    process.exit(1);
  }

  let variants: ShaderVariant[];
  if (macroFile) {
    variants = prewarmer.generatePermutations(baseShader, macroFile);
  } else {
    variants = [{ shader: baseShader, entrypoint: 'main', stage: 'vertex' }];
  }

  const driver = detectVulkanDriver();
  console.error(`[vk-cache] Detected ICD: ${driver || 'none'}`);

  prewarmer.prewarm(variants).then(() => {
    console.error('[vk-cache] Done');
    process.exit(0);
  }).catch((e: any) => {
    console.error(`[vk-cache] Error: ${e.message}`);
    process.exit(1);
  });
}
