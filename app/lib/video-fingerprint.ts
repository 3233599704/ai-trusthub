export type VideoFingerprint = {
  version: "ta-video-v1";
  duration: number;
  width: number;
  height: number;
  size: number;
  digest: string;
  frameHashes: string[];
  colors: number[][];
  transitions: number[];
};

function waitFor(target: EventTarget, eventName: string, timeout = 12000) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`等待 ${eventName} 超时`));
    }, timeout);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("浏览器无法解码该视频，请使用 MP4 或 WebM"));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function toHex(bits: number[]) {
  let value = "";
  for (let index = 0; index < bits.length; index += 4) {
    const nibble = bits.slice(index, index + 4).reduce((sum, bit) => sum * 2 + bit, 0);
    value += nibble.toString(16);
  }
  return value.padEnd(16, "0");
}

function hamming(left: string, right: string) {
  let distance = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const xor = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    distance += ((xor >> 3) & 1) + ((xor >> 2) & 1) + ((xor >> 1) & 1) + (xor & 1);
  }
  return distance + Math.abs(left.length - right.length) * 4;
}

async function fileDigest(file: File) {
  const sampleSize = 1024 * 1024;
  const first = await file.slice(0, sampleSize).arrayBuffer();
  const last = file.size > sampleSize ? await file.slice(Math.max(0, file.size - sampleSize)).arrayBuffer() : new ArrayBuffer(0);
  const meta = new TextEncoder().encode(`${file.name}|${file.size}|${file.type}`);
  const joined = new Uint8Array(first.byteLength + last.byteLength + meta.byteLength);
  joined.set(new Uint8Array(first), 0);
  joined.set(new Uint8Array(last), first.byteLength);
  joined.set(meta, first.byteLength + last.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", joined);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintVideo(file: File, onProgress?: (progress: number, message: string) => void): Promise<VideoFingerprint> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.playsInline = true;
  const objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;

  try {
    onProgress?.(5, "读取视频元数据");
    await waitFor(video, "loadedmetadata");
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const frameCount = Math.max(6, Math.min(18, Math.round(duration / 2) + 5));
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器不支持 Canvas 视频分析");

    const frameHashes: string[] = [];
    const colors: number[][] = [];
    for (let index = 0; index < frameCount; index += 1) {
      const time = Math.min(Math.max(0.01, duration * ((index + 0.5) / frameCount)), Math.max(0.01, duration - 0.03));
      video.currentTime = time;
      await waitFor(video, "seeked");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;

      const gray: number[] = [];
      const rgb = [0, 0, 0];
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 9; x += 1) {
          const px = Math.min(31, x * 4);
          const py = Math.min(31, y * 4);
          const offset = (py * 32 + px) * 4;
          gray.push(pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114);
        }
      }
      for (let offset = 0; offset < pixels.length; offset += 4) {
        rgb[0] += pixels[offset];
        rgb[1] += pixels[offset + 1];
        rgb[2] += pixels[offset + 2];
      }
      const bits: number[] = [];
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) bits.push(gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
      }
      frameHashes.push(toHex(bits));
      colors.push(rgb.map((value) => Math.round(value / (32 * 32))));
      onProgress?.(10 + Math.round(((index + 1) / frameCount) * 72), `提取关键帧 ${index + 1}/${frameCount}`);
    }

    const transitions = frameHashes.slice(1).map((hash, index) => hamming(frameHashes[index], hash));
    onProgress?.(88, "生成文件摘要与时序特征");
    const digest = await fileDigest(file);
    onProgress?.(96, "视频指纹生成完成");
    return {
      version: "ta-video-v1",
      duration: Number(duration.toFixed(3)),
      width: video.videoWidth,
      height: video.videoHeight,
      size: file.size,
      digest,
      frameHashes,
      colors,
      transitions,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute("src");
    video.load();
  }
}
