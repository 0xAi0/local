declare const LZString: any;

// Combine SDP + Key into a compressed hash string
export function generateLinkHash(sdp: any, key: string): string {
  const payload = JSON.stringify({ s: sdp, k: key });
  return LZString.compressToEncodedURIComponent(payload);
}

// Parse hash back to data
export function parseLinkHash(hash: string): { s: any, k: string } | null {
  try {
    const decompressed = LZString.decompressFromEncodedURIComponent(hash);
    if (!decompressed) return null;
    return JSON.parse(decompressed);
  } catch (e) {
    console.error("Link parse error", e);
    return null;
  }
}