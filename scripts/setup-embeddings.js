#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import os from 'os'
import https from 'https'
import { createHash } from 'crypto'
import { exec } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath, pathToFileURL } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const execAsync = promisify(exec)

// Configuration
const ONNX_RUNTIME_VERSION = '1.21.0'
const MODEL_NAME = 'intfloat/multilingual-e5-small'
const MODEL_REVISION = '614241f622f53c4eeff9890bdc4f31cfecc418b3'
const BACKEND_DIR = path.join(__dirname, '..', 'backend')
const MODELS_DIR = path.join(BACKEND_DIR, 'models')
const LIB_DIR = path.join(BACKEND_DIR, 'lib')

// Platform-specific library configurations
const PLATFORMS = {
  'win32-x64': {
    url: `https://github.com/microsoft/onnxruntime/releases/download/v${ONNX_RUNTIME_VERSION}/onnxruntime-win-x64-${ONNX_RUNTIME_VERSION}.zip`,
    sha256: '5c07bb2805cd666dda75fa9bfa60e75f2f90d478b952298dd9d55c00740d81bf',
    libFile: 'onnxruntime.dll',
    extractPath: `onnxruntime-win-x64-${ONNX_RUNTIME_VERSION}/lib/onnxruntime.dll`,
  },
  'linux-x64': {
    url: `https://github.com/microsoft/onnxruntime/releases/download/v${ONNX_RUNTIME_VERSION}/onnxruntime-linux-x64-${ONNX_RUNTIME_VERSION}.tgz`,
    sha256: '7485c7e7aac6501b27e353dcbe068e45c61ab51fbaf598d13970dfae669d20bf',
    libFile: 'libonnxruntime.so',
    extractPath: `onnxruntime-linux-x64-${ONNX_RUNTIME_VERSION}/lib/libonnxruntime.so`,
  },
  'darwin-arm64': {
    url: `https://github.com/microsoft/onnxruntime/releases/download/v${ONNX_RUNTIME_VERSION}/onnxruntime-osx-arm64-${ONNX_RUNTIME_VERSION}.tgz`,
    sha256: '5c3f2064ee97eb7774e87f396735c8eada7287734f1bb7847467ad30d4036115',
    libFile: 'libonnxruntime.dylib',
    extractPath: `onnxruntime-osx-arm64-${ONNX_RUNTIME_VERSION}/lib/libonnxruntime.dylib`,
  },
  'darwin-x64': {
    url: `https://github.com/microsoft/onnxruntime/releases/download/v${ONNX_RUNTIME_VERSION}/onnxruntime-osx-x86_64-${ONNX_RUNTIME_VERSION}.tgz`,
    sha256: '8305afd2d75ee5702844a23b099d41885af30ad3d1b4cf3d8d795e3d8c1f9396',
    libFile: 'libonnxruntime.dylib',
    extractPath: `onnxruntime-osx-x86_64-${ONNX_RUNTIME_VERSION}/lib/libonnxruntime.dylib`,
  },
}

// Utility functions
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    console.log(`Created directory: ${dir}`)
  }
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`Too many redirects while downloading ${url}`))
      return
    }
    console.log(`Downloading ${url}...`)
    https
      .get(url, response => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          response.resume()
          if (!response.headers.location) {
            reject(new Error('Download redirect did not include a location.'))
            return
          }
          return downloadFile(response.headers.location, dest, redirects + 1)
            .then(resolve)
            .catch(reject)
        }

        if (response.statusCode !== 200) {
          reject(
            new Error(`Download failed with status: ${response.statusCode}`)
          )
          response.resume()
          return
        }

        const file = fs.createWriteStream(dest)
        response.pipe(file)

        file.on('finish', () => {
          file.close()
          console.log(`Downloaded: ${dest}`)
          resolve()
        })

        file.on('error', err => {
          response.destroy()
          fs.rm(dest, { force: true }, () => {})
          reject(err)
        })
      })
      .on('error', error => {
        fs.rm(dest, { force: true }, () => {})
        reject(error)
      })
  })
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function extractArchive(archivePath, extractDir) {
  const ext = path.extname(archivePath)

  try {
    if (ext === '.zip') {
      // Use PowerShell on Windows, unzip on Unix
      if (process.platform === 'win32') {
        await execAsync(
          `powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force"`
        )
      } else {
        await execAsync(`unzip -o "${archivePath}" -d "${extractDir}"`)
      }
    } else if (ext === '.tgz' || archivePath.endsWith('.tar.gz')) {
      await execAsync(`tar -xzf "${archivePath}" -C "${extractDir}"`)
    } else {
      throw new Error(`Unsupported archive format: ${ext}`)
    }

    console.log(`Extracted: ${archivePath}`)
  } catch (error) {
    throw new Error(`Failed to extract ${archivePath}: ${error.message}`)
  }
}

async function downloadOnnxRuntime() {
  console.log('Setting up ONNX Runtime libraries...')

  ensureDir(LIB_DIR)
  const tempDir = path.join(LIB_DIR, 'temp')
  ensureDir(tempDir)

  try {
    // 【本地修改 1/3】原版会把 win32/linux/darwin 四个平台的 ONNX Runtime 全部下载
    // （合计 200MB+），但本机开发只会用到当前平台的那一份。
    // 这里改为：默认只下载当前平台，其余直接跳过。
    // 如需恢复原行为（例如 CI 上给多平台打包），设置环境变量 ONNX_ALL_PLATFORMS=1。
    // Set ONNX_ALL_PLATFORMS=1 to download every platform (e.g. for CI packaging).
    const currentPlatform = `${process.platform}-${os.arch()}` // 例如 win32-x64
    const fetchAll = process.env.ONNX_ALL_PLATFORMS === '1'

    for (const [platform, config] of Object.entries(PLATFORMS)) {
      if (!fetchAll && platform !== currentPlatform) {
        console.log(`\nSkipping ONNX Runtime for ${platform} (not needed on this machine)`)
        continue
      }

      console.log(`\nDownloading ONNX Runtime for ${platform}...`)

      const platformDir = path.join(LIB_DIR, platform)
      ensureDir(platformDir)

      const archiveName = path.basename(config.url)
      const archivePath = path.join(tempDir, archiveName)
      const extractDir = path.join(tempDir, platform)
      fs.rmSync(extractDir, { recursive: true, force: true })
      ensureDir(extractDir)

      // 【本地修改 2/3】原版无条件联网下载压缩包。国内访问 GitHub release 经常
      // 被重置(ECONNRESET)，非常慢。这里改为：如果 temp 目录里已经手动放置了
      // 同名压缩包，就跳过下载直接进入 SHA256 校验（校验保证文件正确性），
      // 之后照常解压。这样可以从浏览器/镜像手动下载后放进 temp 复用。
      if (fs.existsSync(archivePath)) {
        console.log(`Found existing archive, skipping download: ${archivePath}`)
      } else {
        await downloadFile(config.url, archivePath)
      }
      const archiveDigest = await sha256File(archivePath)
      if (archiveDigest !== config.sha256) {
        throw new Error(`Checksum mismatch for ${archiveName}`)
      }

      await extractArchive(archivePath, extractDir)

      const sourceLib = path.join(extractDir, config.extractPath)
      const destLib = path.join(platformDir, config.libFile)

      if (!fs.existsSync(sourceLib)) {
        throw new Error(`Library file not found: ${sourceLib}`)
      }
      fs.copyFileSync(sourceLib, destLib)
      console.log(`Copied verified library: ${destLib}`)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
    console.log('Cleaned up temporary files')
  }
}

async function downloadModel({ tokenizerOnly = false } = {}) {
  console.log('\\nSetting up multilingual E5 model...')

  ensureDir(MODELS_DIR)
  const modelDir = path.join(MODELS_DIR, 'minilm')
  ensureDir(modelDir)

  // 【本地修改 3/3】原版写死从 huggingface.co 下载模型，国内直连经常超时。
  // 这里默认改用 hf-mirror.com（HuggingFace 的国内镜像，文件内容与官方
  // 完全一致，下载后仍会做 SHA256 校验，所以不怕镜像被篡改）。
  // 如需用回官方源，设置环境变量 HF_OFFICIAL=1。
  // Set HF_OFFICIAL=1 to use the official huggingface.co instead.
  const hfHost = process.env.HF_OFFICIAL === '1' ? 'huggingface.co' : 'hf-mirror.com'
  const baseUrl = `https://${hfHost}/${MODEL_NAME}/resolve/${MODEL_REVISION}/onnx`
  const artifacts = [
    {
      name: 'multilingual-e5-small.onnx',
      url: `${baseUrl}/model_O4.onnx`,
      sha256:
        '4654c156f3e4171abc9c716cdb771bf9116455d15ac1aab364aeeede0e3205b0',
    },
    {
      name: 'multilingual-e5-small-tokenizer.json',
      url: `${baseUrl}/tokenizer.json`,
      sha256:
        '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
    },
  ]

  const selectedArtifacts = tokenizerOnly
    ? artifacts.filter(artifact => artifact.name.includes('tokenizer'))
    : artifacts

  for (const artifact of selectedArtifacts) {
    const destination = path.join(modelDir, artifact.name)
    if (fs.existsSync(destination)) {
      const existingDigest = await sha256File(destination)
      if (existingDigest === artifact.sha256) {
        console.log(`Keeping existing embedding artifact: ${destination}`)
        continue
      }
      console.warn(`Replacing invalid embedding artifact: ${destination}`)
      fs.rmSync(destination, { force: true })
    }
    await downloadFile(artifact.url, destination)
    const digest = await sha256File(destination)
    if (digest !== artifact.sha256) {
      fs.rmSync(destination, { force: true })
      throw new Error(`Checksum mismatch for ${artifact.name}`)
    }
  }
}

async function main() {
  console.log('Setting up embeddings dependencies...')

  try {
    const tokenizerOnly = process.argv.includes('--tokenizer-only')
    if (!tokenizerOnly) {
      await downloadOnnxRuntime()
    }
    await downloadModel({ tokenizerOnly })

    console.log('\\n✅ Embeddings setup completed!')
    console.log('\\nNext steps:')
    console.log(
      '1. Build the Go backend with the pinned multilingual artifacts'
    )
    console.log('2. Verify electron-builder includes backend/models')
    console.log('3. Run the backend and test Memory/RAG retrieval')
  } catch (error) {
    console.error('\\n❌ Setup failed:', error.message)
    process.exit(1)
  }
}

// Run if this is the main module
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
