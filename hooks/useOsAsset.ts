import { useState, useEffect } from 'react';

// Defines the shape of the returned asset information.
interface AssetInfo {
  osName: string;
  architecture?: string;
  downloadUrl?: string;
  // Safety-net download, only set when the architecture couldn't be
  // detected: on macOS with WebGL blocked the main download defaults to
  // arm64 and this holds the Intel (x64) build.
  alternativeDownloadUrl?: string;
  version?: string; // We'll add a version property
  isLoading: boolean;
}

type MacArchitecture = 'arm64' | 'x64' | 'unknown';

// Cached so that multiple DownloadButton instances on one page probe WebGL
// only once instead of each creating their own GL context.
let cachedMacArchitecture: MacArchitecture | undefined;

// Detects whether a Mac runs Apple Silicon or Intel. The user agent cannot
// tell them apart (both report 'MacIntel'), but the GPU can: Apple Silicon
// Macs only ever have Apple GPUs, while Intel Macs only ever have
// Intel/AMD/NVIDIA GPUs, so the WebGL renderer string is conclusive when it
// names a vendor. Safari masks the string as plain 'Apple GPU' on BOTH
// architectures, so on a masked string we fall back to a capability probe:
// ETC texture compression is native to Apple Silicon GPUs and absent on
// Intel-Mac GPUs (the same probe DuckDuckGo's privacy scripts rely on).
const detectMacArchitecture = (): MacArchitecture => {
  if (cachedMacArchitecture !== undefined) return cachedMacArchitecture;
  cachedMacArchitecture = 'unknown';
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl') ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (!gl) return cachedMacArchitecture;

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      (debugInfo && gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) ||
        gl.getParameter(gl.RENDERER) ||
        ''
    );

    if (/swiftshader|llvmpipe|software/i.test(renderer)) {
      // Software renderer reveals nothing about the CPU: stay 'unknown'.
    } else if (/intel|amd|radeon|nvidia|geforce/i.test(renderer)) {
      cachedMacArchitecture = 'x64';
    } else if (/apple m\d|angle \(apple/i.test(renderer)) {
      // e.g. Firefox 'Apple M1', Chrome 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, ...)'
      cachedMacArchitecture = 'arm64';
    } else {
      const extensions = gl.getSupportedExtensions() || [];
      if (extensions.includes('WEBGL_compressed_texture_etc')) {
        cachedMacArchitecture = 'arm64';
      } else if (/apple/i.test(renderer)) {
        // Masked 'Apple GPU' without ETC support -> Intel-Mac GPU.
        cachedMacArchitecture = 'x64';
      }
    }

    // Release the context so the probe doesn't count against the browser's
    // limit on live WebGL contexts.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    // WebGL blocked (privacy settings, Lockdown Mode, headless): 'unknown'.
  }
  return cachedMacArchitecture;
};

// A custom hook to detect the user's OS and provide a corresponding download asset.
const useOsAsset = (repository: string): AssetInfo => {
  const [asset, setAsset] = useState<AssetInfo>({
    osName: '',
    isLoading: true, // Initial state is loading
  });

  useEffect(() => {
    // Only run on the client side, where the window object is available.
    if (typeof window === 'undefined') return;

    const fetchLatestVersion = async () => {
      try {
        const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`);
        if (!response.ok) {
          throw new Error('Failed to fetch latest release from GitHub.');
        }
        const data = await response.json();
        const latestVersion = data.tag_name;

        const ua = window.navigator.userAgent;
        let osName = 'Unknown';
        let architecture = 'x64'; // Default to x64
        let needsIntelFallback = false;

        // 1. Detect OS and architecture
        if (ua.includes('Win')) {
          osName = 'Windows';
          architecture = 'x64';
        } else if (ua.includes('Mac')) {
          if (window.navigator.maxTouchPoints > 1) {
            // iPadOS Safari masquerades as a Mac in the user agent; there is
            // no desktop build for it, so don't offer a download at all.
            osName = 'Unknown';
          } else {
            osName = 'macOS';
            const macArchitecture = detectMacArchitecture();
            // When WebGL is blocked the CPU can't be determined; default to
            // arm64 (the vast majority of Macs in use) and additionally
            // surface the Intel build via alternativeDownloadUrl.
            architecture = macArchitecture === 'unknown' ? 'arm64' : macArchitecture;
            needsIntelFallback = macArchitecture === 'unknown';
          }
        } else if (ua.includes('Linux')) {
          osName = 'Linux';
          if (ua.includes('arm64') || ua.includes('aarch64')) {
            architecture = 'arm64';
          }
        }

        // 2. Map detected OS and architecture to the correct asset filename.
        const assetFileName = getAssetName(osName, architecture, latestVersion);

        // 3. Construct the dynamic download URL.
        const downloadUrl = assetFileName
          ? `https://github.com/${repository}/releases/download/${latestVersion}/${assetFileName}`
          : undefined;

        const alternativeDownloadUrl = needsIntelFallback
          ? `https://github.com/${repository}/releases/download/${latestVersion}/${getAssetName(osName, 'x64', latestVersion)}`
          : undefined;

        // 4. Update the state with the final asset information.
        setAsset({ osName, architecture, downloadUrl, alternativeDownloadUrl, version: latestVersion, isLoading: false });

      } catch (error) {
        console.error('Error fetching release assets:', error);
        setAsset({ osName: 'Unknown', isLoading: false });
      }
    };

    fetchLatestVersion();

  }, [repository]);

  return asset;
};

// Helper function to map OS and architecture to the correct asset filename.
const getAssetName = (osName: string, architecture: string, version: string): string => {
  const arch = architecture.toLowerCase();
  const baseName = `Swarm.Desktop-${version.replace(/^v/, '')}`; // Removes leading 'v' if present

  switch (osName) {
    case 'Windows':
      return `${baseName}.Setup.exe`;
    case 'macOS':
      if (arch === 'arm64') {
        return `${baseName}-arm64.dmg`;
      }
      return `${baseName}-x64.dmg`;
    case 'Linux':
      if (arch === 'arm64') {
        return `swarm-desktop_${version.replace(/^v/, '')}_arm64.deb`;
      }
      return `swarm-desktop_${version.replace(/^v/, '')}_amd64.deb`;
    default:
      return '';
  }
};

export { useOsAsset, getAssetName };
export default useOsAsset;
