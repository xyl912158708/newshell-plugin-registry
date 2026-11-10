/* 开发者工具箱 · 纯 JS 算法库（无 DOM 依赖，可在 node 自测）
 * 插件页非安全上下文，crypto.subtle 不可用，哈希/加密均为手写实现。 */
'use strict'
const DT = {}

/* ============ 字节工具 ============ */
DT.utf8Encode = function (str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i)
      const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff)
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return new Uint8Array(out)
}
DT.utf8Decode = function (bytes) {
  let s = '', i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b < 0x80) { s += String.fromCharCode(b); i += 1 }
    else if (b >= 0xc0 && b < 0xe0) { s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2 }
    else if (b >= 0xe0 && b < 0xf0) { s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3 }
    else { let cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); i += 4 }
  }
  return s
}
DT.toHex = function (bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('') }
DT.fromHex = function (hex) {
  const h = String(hex).replace(/[^0-9a-fA-F]/g, '')
  if (h.length % 2) throw new Error('Hex 长度必须为偶数')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16)
  return out
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
DT.b64Encode = function (bytes, urlSafe) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] || 0, c = bytes[i + 2] || 0
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < bytes.length ? B64[c & 63] : '=')
  }
  return urlSafe ? s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : s
}
DT.b64Decode = function (str) {
  const rev = {}; for (let i = 0; i < 64; i++) rev[B64[i]] = i
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '')
  const out = []
  for (let i = 0; i < s.length; i += 4) {
    const a = rev[s[i]] || 0, b = rev[s[i + 1]] || 0, c = s[i + 2] === '=' ? 0 : (rev[s[i + 2]] || 0), d = s[i + 3] === '=' ? 0 : (rev[s[i + 3]] || 0)
    out.push((a << 2) | (b >> 4))
    if (s[i + 2] !== '=') out.push(((b & 15) << 4) | (c >> 2))
    if (s[i + 3] !== '=') out.push(((c & 3) << 6) | d)
  }
  return new Uint8Array(out)
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
DT.b32Encode = function (bytes) {
  let s = '', buf = 0, bits = 0
  for (const b of bytes) { buf = (buf << 8) | b; bits += 8; while (bits >= 5) { s += B32[(buf >> (bits - 5)) & 31]; bits -= 5 } }
  if (bits > 0) s += B32[(buf << (5 - bits)) & 31]
  while (s.length % 8) s += '='
  return s
}
DT.b32Decode = function (str) {
  const rev = {}; for (let i = 0; i < 32; i++) rev[B32[i]] = i
  const out = []; let buf = 0, bits = 0
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) { buf = (buf << 5) | rev[ch]; bits += 5; if (bits >= 8) { out.push((buf >> (bits - 8)) & 0xff); bits -= 8 } }
  return new Uint8Array(out)
}

/* ============ MD5 ============ */
DT.md5 = function (bytes) {
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
  const K = []; for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0
  const bitLen = bytes.length * 8
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
  padded.set(bytes); padded[bytes.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, bitLen >>> 0, true); dv.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  const M = new Uint32Array(16)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true)
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let f, g
      if (i < 16) { f = (b & c) | (~b & d); g = i } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 } else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 } else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      const tmp = d; d = c; c = b
      const sum = (a + f + K[i] + M[g]) >>> 0
      b = (b + (((sum << S[i]) | (sum >>> (32 - S[i]))) >>> 0)) >>> 0
      a = tmp
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0
  }
  const out = new Uint8Array(16); const od = new DataView(out.buffer)
  od.setUint32(0, a0, true); od.setUint32(4, b0, true); od.setUint32(8, c0, true); od.setUint32(12, d0, true)
  return out
}

/* ============ SHA-1 ============ */
DT.sha1 = function (bytes) {
  const bitLen = bytes.length * 8
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
  padded.set(bytes); padded[bytes.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 4, bitLen >>> 0); dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296))
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = ((x << 1) | (x >>> 31)) >>> 0 }
    let a = h0, b = h1, c = h2, d = h3, e = h4
    for (let i = 0; i < 80; i++) {
      let f, k
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999 } else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc } else { f = b ^ c ^ d; k = 0xca62c1d6 }
      const t = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + w[i]) >>> 0
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20); const od = new DataView(out.buffer)
  od.setUint32(0, h0); od.setUint32(4, h1); od.setUint32(8, h2); od.setUint32(12, h3); od.setUint32(16, h4)
  return out
}

/* ============ SHA-256 ============ */
const SHA256K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]
DT.sha256 = function (bytes) {
  const bitLen = bytes.length * 8
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
  padded.set(bytes); padded[bytes.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 4, bitLen >>> 0); dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296))
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Uint32Array(64)
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + SHA256K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h = h.map((x, i) => (x + [a, b, c, d, e, f, g, hh][i]) >>> 0)
  }
  const out = new Uint8Array(32); const od = new DataView(out.buffer)
  h.forEach((x, i) => od.setUint32(i * 4, x))
  return out
}

/* ============ SHA-512（BigInt 实现） ============ */
DT.sha512 = function (bytes) {
  const M64 = (1n << 64n) - 1n
  const K = ('428a2f98d728ae22 7137449123ef65cd b5c0fbcfec4d3b2f e9b5dba58189dbbc 3956c25bf348b538 59f111f1b605d019 923f82a4af194f9b ab1c5ed5da6d8118 d807aa98a3030242 12835b0145706fbe 243185be4ee4b28c 550c7dc3d5ffb4e2 72be5d74f27b896f 80deb1fe3b1696b1 9bdc06a725c71235 c19bf174cf692694 e49b69c19ef14ad2 efbe4786384f25e3 0fc19dc68b8cd5b5 240ca1cc77ac9c65 2de92c6f592b0275 4a7484aa6ea6e483 5cb0a9dcbd41fbd4 76f988da831153b5 983e5152ee66dfab a831c66d2db43210 b00327c898fb213f bf597fc7beef0ee4 c6e00bf33da88fc2 d5a79147930aa725 06ca6351e003826f 142929670a0e6e70 27b70a8546d22ffc 2e1b21385c26c926 4d2c6dfc5ac42aed 53380d139d95b3df 650a73548baf63de 766a0abb3c77b2a8 81c2c92e47edaee6 92722c851482353b a2bfe8a14cf10364 a81a664bbc423001 c24b8b70d0f89791 c76c51a30654be30 d192e819d6ef5218 d69906245565a910 f40e35855771202a 106aa07032bbd1b8 19a4c116b8d2d0c8 1e376c085141ab53 2748774cdf8eeb99 34b0bcb5e19b48a8 391c0cb3c5c95a63 4ed8aa4ae3418acb 5b9cca4f7763e373 682e6ff3d6b2b8a3 748f82ee5defb2fc 78a5636f43172f60 84c87814a1f0ab72 8cc702081a6439ec 90befffa23631e28 a4506cebde82bde9 bef9a3f7b2c67915 c67178f2e372532b ca273eceea26619c d186b8c721c0c207 eada7dd6cde0eb1e f57d4f7fee6ed178 06f067aa72176fba 0a637dc5a2c898a6 113f9804bef90dae 1b710b35131c471b 28db77f523047d84 32caab7b40c72493 3c9ebe0a15c9bebc 431d67c49c100d4c 4cc5d4becb3e42b6 597f299cfc657e2a 5fcb6fab3ad6faec 6c44198c4a475817').split(' ').map((x) => BigInt('0x' + x))
  const H0 = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'].map((x) => BigInt('0x' + x))
  const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64
  const bitLen = BigInt(bytes.length) * 8n
  const total = Math.ceil((bytes.length + 17) / 128) * 128
  const padded = new Uint8Array(total)
  padded.set(bytes); padded[bytes.length] = 0x80
  for (let i = 0; i < 16; i++) padded[total - 1 - i] = Number((bitLen >> BigInt(i * 8)) & 0xffn)
  const w = new Array(80)
  const getW = (off, i) => { let v = 0n; for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(padded[off + i * 8 + j]); return v }
  let h = H0.slice()
  for (let off = 0; off < total; off += 128) {
    for (let i = 0; i < 16; i++) w[i] = getW(off, i)
    for (let i = 16; i < 80; i++) {
      const s0 = rotr(w[i - 15], 1) ^ rotr(w[i - 15], 8) ^ (w[i - 15] >> 7n)
      const s1 = rotr(w[i - 2], 19) ^ rotr(w[i - 2], 61) ^ (w[i - 2] >> 6n)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41)
      const ch = (e & f) ^ (~e & M64 & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) & M64
      const S0 = rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) & M64
      hh = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64
    }
    const cur = [a, b, c, d, e, f, g, hh]
    h = h.map((x, i) => (x + cur[i]) & M64)
  }
  const out = new Uint8Array(64)
  h.forEach((x, i) => { for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((x >> BigInt((7 - j) * 8)) & 0xffn) })
  return out
}

/* ============ HMAC ============ */
DT.hashFns = { md5: DT.md5, sha1: DT.sha1, sha256: DT.sha256, sha512: DT.sha512 }
DT.hashBlockSize = { md5: 64, sha1: 64, sha256: 64, sha512: 128 }
DT.hash = function (algo, bytes) { const f = DT.hashFns[algo]; if (!f) throw new Error('不支持的算法：' + algo); return f(bytes) }
DT.hmac = function (algo, keyBytes, msgBytes) {
  const bs = DT.hashBlockSize[algo]
  let key = keyBytes
  if (key.length > bs) key = DT.hash(algo, key)
  const k = new Uint8Array(bs); k.set(key)
  const ipad = new Uint8Array(bs), opad = new Uint8Array(bs)
  for (let i = 0; i < bs; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c }
  const inner = new Uint8Array(bs + msgBytes.length); inner.set(ipad); inner.set(msgBytes, bs)
  const innerHash = DT.hash(algo, inner)
  const outer = new Uint8Array(bs + innerHash.length); outer.set(opad); outer.set(innerHash, bs)
  return DT.hash(algo, outer)
}

/* ============ AES（FIPS-197，纯 JS） ============ */
const AES_SBOX = (() => {
  const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = ((a << 1) & 0xff) ^ ((a & 0x80) ? 0x1b : 0); b >>= 1 } return r }
  const exp = new Uint8Array(255), log = new Uint8Array(256)
  exp[0] = 1
  for (let i = 1; i < 255; i++) exp[i] = mul(exp[i - 1], 3)
  for (let i = 0; i < 255; i++) log[exp[i]] = i
  const sbox = new Uint8Array(256), inv = new Uint8Array(256)
  const rotl = (v, n) => ((v << n) | (v >> (8 - n))) & 0xff
  for (let i = 0; i < 256; i++) {
    const inverse = i === 0 ? 0 : exp[(255 - log[i]) % 255]
    const s = (inverse ^ rotl(inverse, 1) ^ rotl(inverse, 2) ^ rotl(inverse, 3) ^ rotl(inverse, 4) ^ 0x63) & 0xff
    sbox[i] = s; inv[s] = i
  }
  return { sbox, inv }
})()
function aesExpandKey(key) {
  const Nk = key.length / 4, Nr = Nk + 6
  const w = new Uint8Array(16 * (Nr + 1))
  w.set(key)
  const rcon = [1, 2, 4, 8, 16, 32, 64, 128, 27, 54, 108, 216, 171, 77]
  const tmp = new Uint8Array(4)
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    tmp.set(w.subarray((i - 1) * 4, i * 4))
    if (i % Nk === 0) { const t = tmp[0]; tmp[0] = AES_SBOX.sbox[tmp[1]] ^ rcon[i / Nk - 1]; tmp[1] = AES_SBOX.sbox[tmp[2]]; tmp[2] = AES_SBOX.sbox[tmp[3]]; tmp[3] = AES_SBOX.sbox[t] }
    else if (Nk > 6 && i % Nk === 4) { for (let j = 0; j < 4; j++) tmp[j] = AES_SBOX.sbox[tmp[j]] }
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - Nk) * 4 + j] ^ tmp[j]
  }
  return { roundKeys: w, Nr }
}
function aesXtime(a) { return ((a << 1) & 0xff) ^ ((a & 0x80) ? 0x1b : 0) }
function aesMul(a, b) { let r = 0; while (b) { if (b & 1) r ^= a; a = aesXtime(a); b >>= 1 } return r }
function aesEncryptBlock(rk, Nr, input) {
  const s = new Uint8Array(input)
  const addRK = (round) => { for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i] }
  const sub = () => { for (let i = 0; i < 16; i++) s[i] = AES_SBOX.sbox[s[i]] }
  const shift = () => { const t = new Uint8Array(s); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) s[c * 4 + r] = t[((c + r) % 4) * 4 + r] }
  const mix = () => { for (let c = 0; c < 4; c++) { const i = c * 4, a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3]; s[i] = aesMul(a0, 2) ^ aesMul(a1, 3) ^ a2 ^ a3; s[i + 1] = a0 ^ aesMul(a1, 2) ^ aesMul(a2, 3) ^ a3; s[i + 2] = a0 ^ a1 ^ aesMul(a2, 2) ^ aesMul(a3, 3); s[i + 3] = aesMul(a0, 3) ^ a1 ^ a2 ^ aesMul(a3, 2) } }
  addRK(0)
  for (let round = 1; round < Nr; round++) { sub(); shift(); mix(); addRK(round) }
  sub(); shift(); addRK(Nr)
  return s
}
function aesDecryptBlock(rk, Nr, input) {
  const s = new Uint8Array(input)
  const addRK = (round) => { for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i] }
  const invSub = () => { for (let i = 0; i < 16; i++) s[i] = AES_SBOX.inv[s[i]] }
  const invShift = () => { const t = new Uint8Array(s); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) s[c * 4 + r] = t[((c - r + 4) % 4) * 4 + r] }
  const invMix = () => { for (let c = 0; c < 4; c++) { const i = c * 4, a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3]; s[i] = aesMul(a0, 14) ^ aesMul(a1, 11) ^ aesMul(a2, 13) ^ aesMul(a3, 9); s[i + 1] = aesMul(a0, 9) ^ aesMul(a1, 14) ^ aesMul(a2, 11) ^ aesMul(a3, 13); s[i + 2] = aesMul(a0, 13) ^ aesMul(a1, 9) ^ aesMul(a2, 14) ^ aesMul(a3, 11); s[i + 3] = aesMul(a0, 11) ^ aesMul(a1, 13) ^ aesMul(a2, 9) ^ aesMul(a3, 14) } }
  addRK(Nr)
  for (let round = Nr - 1; round >= 1; round--) { invShift(); invSub(); addRK(round); invMix() }
  invShift(); invSub(); addRK(0)
  return s
}
DT.aes = function (encrypt, data, key, mode, iv, pkcs7) {
  if (![16, 24, 32].includes(key.length)) throw new Error('密钥长度必须为 16/24/32 字节（AES-128/192/256），当前 ' + key.length + ' 字节')
  const { roundKeys, Nr } = aesExpandKey(key)
  let input = data
  if (encrypt && pkcs7) {
    const pad = 16 - (data.length % 16)
    input = new Uint8Array(data.length + pad); input.set(data); input.fill(pad, data.length)
  }
  if (input.length % 16 !== 0) throw new Error('数据长度必须是 16 的倍数（或启用 PKCS7 填充）')
  const out = new Uint8Array(input.length)
  let prev = iv ? new Uint8Array(iv) : new Uint8Array(16)
  for (let off = 0; off < input.length; off += 16) {
    const block = input.subarray(off, off + 16)
    if (encrypt) {
      const x = new Uint8Array(16)
      for (let i = 0; i < 16; i++) x[i] = block[i] ^ (mode === 'CBC' ? prev[i] : 0)
      const enc = aesEncryptBlock(roundKeys, Nr, x)
      out.set(enc, off); prev = enc
    } else {
      const dec = aesDecryptBlock(roundKeys, Nr, block)
      for (let i = 0; i < 16; i++) out[off + i] = dec[i] ^ (mode === 'CBC' ? prev[i] : 0)
      prev = new Uint8Array(block)
    }
  }
  if (!encrypt && pkcs7) {
    const pad = out[out.length - 1]
    if (pad < 1 || pad > 16) throw new Error('PKCS7 填充无效（密钥或 IV 可能不正确）')
    return out.subarray(0, out.length - pad)
  }
  return out
}

/* ============ 文本/数据小工具 ============ */
DT.humanBytes = function (n) {
  if (!isFinite(n)) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0, v = Math.abs(n)
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return (n < 0 ? '-' : '') + (i === 0 ? v : v.toFixed(2)) + ' ' + units[i]
}
DT.parseBytes = function (str) {
  const m = String(str).trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB|PB|KIB|MIB|GIB)?$/i)
  if (!m) throw new Error('格式示例：1024、1.5 MB、2 GiB')
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3 }
  return parseFloat(m[1]) * (mult[(m[2] || 'B').toUpperCase()])
}
DT.convertBase = function (str, from, to) {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'
  let v
  if (from === 10) { if (!/^-?\d+$/.test(str.trim())) throw new Error('请输入整数'); v = BigInt(str.trim()) }
  else {
    const s = str.trim().toLowerCase(); let neg = false
    let body = s; if (body.startsWith('-')) { neg = true; body = body.slice(1) }
    v = 0n
    for (const ch of body) { const d = digits.indexOf(ch); if (d < 0 || d >= from) throw new Error('包含超出进制的字符：' + ch); v = v * BigInt(from) + BigInt(d) }
    if (neg) v = -v
  }
  if (to === 10) return v.toString()
  return v.toString(to)
}

/* ============ Cron ============ */
const CRON_FIELDS = [
  { name: '分钟', min: 0, max: 59 }, { name: '小时', min: 0, max: 23 }, { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 }, { name: '星期', min: 0, max: 7 }
]
function cronParseField(expr, field) {
  const values = new Set()
  for (const part of expr.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart ? parseInt(stepPart, 10) : 1
    if (!Number.isInteger(step) || step < 1) throw new Error(field.name + '步长无效：' + part)
    let lo, hi
    if (rangePart === '*') { lo = field.min; hi = field.max }
    else if (rangePart.includes('-')) { const [a, b] = rangePart.split('-').map((x) => parseInt(x, 10)); lo = a; hi = b }
    else { lo = parseInt(rangePart, 10); hi = stepPart ? field.max : lo }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < field.min || hi > field.max || lo > hi) throw new Error(field.name + '取值无效：' + part + '（允许 ' + field.min + '-' + field.max + '）')
    for (let v = lo; v <= hi; v += step) values.add(field.name === '星期' && v === 7 ? 0 : v)
  }
  return [...values].sort((a, b) => a - b)
}
DT.cronExplain = function (expr) {
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('需要 5 段标准 cron：分 时 日 月 周')
  const sets = parts.map((p, i) => cronParseField(p, CRON_FIELDS[i]))
  const fmt = (i) => parts[i] === '*' ? '每' + CRON_FIELDS[i].name : CRON_FIELDS[i].name + ' ∈ {' + sets[i].join(', ') + '}'
  const desc = parts.map((_, i) => fmt(i)).join('；')
  return { sets, desc }
}
DT.cronNext = function (expr, count, from) {
  const { sets } = DT.cronExplain(expr)
  const [mins, hours, doms, months, dows] = sets
  const out = []
  const d = new Date(from || Date.now())
  d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1)
  let guard = 0
  while (out.length < count && guard++ < 525600) {
    if (months.includes(d.getMonth() + 1) && doms.includes(d.getDate()) && dows.includes(d.getDay()) && hours.includes(d.getHours()) && mins.includes(d.getMinutes())) out.push(new Date(d))
    d.setMinutes(d.getMinutes() + 1)
  }
  return out
}

/* ============ 子网计算 ============ */
DT.subnetCalc = function (input) {
  const m = String(input).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/)
  if (!m) throw new Error('格式示例：192.168.1.10/24')
  const oct = m.slice(1, 5).map(Number)
  if (oct.some((x) => x > 255)) throw new Error('IP 段超出 255')
  const prefix = m[5] !== undefined ? parseInt(m[5], 10) : 24
  if (prefix < 0 || prefix > 32) throw new Error('前缀长度 0-32')
  const ip = ((oct[0] << 24) | (oct[1] << 16) | (oct[2] << 8) | oct[3]) >>> 0
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const network = (ip & mask) >>> 0
  const broadcast = (network | (~mask >>> 0)) >>> 0
  const toStr = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.')
  const total = 2 ** (32 - prefix)
  return {
    ip: toStr(ip), prefix, mask: toStr(mask), maskBinary: mask.toString(2).padStart(32, '0').replace(/(.{8})(?=.)/g, '$1.'),
    network: toStr(network), broadcast: toStr(broadcast),
    firstHost: prefix >= 31 ? toStr(network) : toStr((network + 1) >>> 0),
    lastHost: prefix >= 31 ? toStr(broadcast) : toStr((broadcast - 1) >>> 0),
    total, hosts: prefix >= 31 ? total : total - 2, wildcard: toStr((~mask) >>> 0)
  }
}

/* ============ YAML 子集（JSON 互转） ============ */
DT.jsonToYaml = function (value, indent) {
  const pad = ' '.repeat(indent || 0)
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    return value.map((v) => {
      if (typeof v === 'object' && v !== null) {
        const inner = DT.jsonToYaml(v, (indent || 0) + 2)
        const lines = inner.split('\n')
        return pad + '- ' + lines[0].trimStart() + (lines.length > 1 ? '\n' + lines.slice(1).join('\n') : '')
      }
      return pad + '- ' + DT.jsonToYaml(v, 0)
    }).join('\n')
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (!keys.length) return '{}'
    return keys.map((k) => {
      const v = value[k]
      if (typeof v === 'object' && v !== null && (Array.isArray(v) ? v.length : Object.keys(v).length)) return pad + k + ':\n' + DT.jsonToYaml(v, (indent || 0) + 2)
      return pad + k + ': ' + DT.jsonToYaml(v, 0)
    }).join('\n')
  }
  if (typeof value === 'string') return /[:#\n[\]{}&*!|>'"%@`,]/.test(value) || value === '' ? JSON.stringify(value) : value
  return String(value)
}
DT.yamlToJson = function (text) {
  const lines = String(text).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
  let pos = 0
  const indentOf = (l) => l.length - l.trimStart().length
  function scalar(s) {
    s = s.trim()
    if (s === 'null' || s === '~') return null
    if (s === 'true') return true
    if (s === 'false') return false
    if (/^-?\d+$/.test(s)) return parseInt(s, 10)
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s)
    if (s.startsWith('"') || s.startsWith("'")) { try { return JSON.parse(s.startsWith("'") ? '"' + s.slice(1, -1).replace(/"/g, '\\"') + '"' : s) } catch { return s.slice(1, -1) } }
    if (s === '[]') return []
    if (s === '{}') return {}
    return s
  }
  function parseBlock(indent) {
    if (pos >= lines.length) return null
    const isList = lines[pos].trimStart().startsWith('- ')
    if (isList) {
      const arr = []
      while (pos < lines.length && indentOf(lines[pos]) === indent && lines[pos].trimStart().startsWith('- ')) {
        const content = lines[pos].trimStart().slice(2)
        if (content.includes(': ') || content.endsWith(':')) {
          lines[pos] = ' '.repeat(indent + 2) + content
          arr.push(parseBlock(indent + 2))
        } else { arr.push(scalar(content)); pos++ }
      }
      return arr
    }
    const obj = {}
    while (pos < lines.length && indentOf(lines[pos]) === indent && !lines[pos].trimStart().startsWith('- ')) {
      const t = lines[pos].trim()
      const ci = t.indexOf(':')
      if (ci < 0) throw new Error('无法解析行：' + t)
      const key = t.slice(0, ci).trim()
      const rest = t.slice(ci + 1).trim()
      pos++
      if (rest) obj[key] = scalar(rest)
      else if (pos < lines.length && indentOf(lines[pos]) > indent) obj[key] = parseBlock(indentOf(lines[pos]))
      else obj[key] = null
    }
    return obj
  }
  return parseBlock(lines.length ? indentOf(lines[0]) : 0)
}

/* ============ CSV ============ */
DT.csvToJson = function (text) {
  const rows = []
  let cur = [''], inQ = false, field = 0
  const src = String(text).replace(/\r\n/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { cur[field] += '"'; i++ } else inQ = false }
      else cur[field] += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { cur.push(''); field++ }
    else if (ch === '\n') { rows.push(cur); cur = ['']; field = 0 }
    else cur[field] += ch
  }
  if (cur.length > 1 || cur[0] !== '') rows.push(cur)
  if (!rows.length) return []
  const head = rows[0]
  return rows.slice(1).filter((r) => r.length > 1 || r[0] !== '').map((r) => { const o = {}; head.forEach((h, i) => { o[h] = r[i] !== undefined ? r[i] : '' }); return o })
}
DT.jsonToCsv = function (arr) {
  if (!Array.isArray(arr) || !arr.length) throw new Error('需要非空 JSON 数组')
  const keys = [...new Set(arr.flatMap((o) => Object.keys(o || {})))]
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  return [keys.join(','), ...arr.map((o) => keys.map((k) => esc(o ? o[k] : '')).join(','))].join('\n')
}

/* ============ 格式化 ============ */
DT.formatXml = function (text) {
  const src = String(text).replace(/>\s+</g, '><').trim()
  let out = '', indent = 0
  for (const part of src.split(/(<[^>]+>)/).filter(Boolean)) {
    if (part.startsWith('</')) { indent = Math.max(0, indent - 1); out += '  '.repeat(indent) + part + '\n' }
    else if (part.startsWith('<')) {
      out += '  '.repeat(indent) + part + '\n'
      if (!part.endsWith('/>') && !part.startsWith('<?') && !part.startsWith('<!')) indent++
    } else out += '  '.repeat(indent) + part.trim() + '\n'
  }
  return out.trim()
}
DT.formatSql = function (sql) {
  const keywords = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'JOIN', 'ON', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'UNION ALL', 'UNION']
  let s = ' ' + String(sql).replace(/\s+/g, ' ').trim() + ' '
  for (const kw of keywords) s = s.replace(new RegExp('\\s' + kw.replace(/ /g, '\\s+') + '\\s', 'gi'), '\n' + kw + ' ')
  return s.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(AND|OR)\s/i)
    return m ? '  ' + l : l
  }).join('\n').replace(/, /g, ',\n  ').replace(/\n\s*\n/g, '\n')
}

/* ============ 二维码（字节模式，纠错等级 M，版本 1-10） ============ */
const QR_EC_M = [ // [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]
  [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
  [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]
]
const QR_ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]
function qrBchRemainder(data, gen, genDeg, shift) {
  let d = data << shift
  const deg = () => 31 - Math.clz32(d)
  while (d && deg() >= genDeg) d ^= gen << (deg() - genDeg)
  return d
}
DT.qrEncode = function (text) {
  const data = DT.utf8Encode(text)
  let version = 0, capacity = 0
  for (let v = 1; v <= 10; v++) {
    const total = QR_EC_M[v - 1][1].reduce((a, [n, c]) => a + n * c, 0)
    const countBits = v <= 9 ? 8 : 16
    if ((4 + countBits + data.length * 8) <= total * 8) { version = v; capacity = total; break }
  }
  if (!version) throw new Error('内容过长（纠错等级 M 最多约 271 字节）')
  const countBits = version <= 9 ? 8 : 16
  const bits = []
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1) }
  push(0b0100, 4); push(data.length, countBits)
  for (const b of data) push(b, 8)
  const capBits = capacity * 8
  if (bits.length > capBits) bits.length = capBits
  while (bits.length % 8) bits.push(0)
  const dataCw = []
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; dataCw.push(v) }
  const pads = [0xec, 0x11]
  for (let i = 0; dataCw.length < capacity; i++) dataCw.push(pads[i % 2])
  // GF(256) Reed-Solomon 分块纠错
  const gfExp = new Uint8Array(512), gfLog = new Uint8Array(256)
  let gx = 1
  for (let i = 0; i < 255; i++) { gfExp[i] = gx; gfLog[gx] = i; gx <<= 1; if (gx & 0x100) gx ^= 0x11d }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255]
  const gfMul = (a, b) => (a && b) ? gfExp[gfLog[a] + gfLog[b]] : 0
  const [ecLen, groups] = QR_EC_M[version - 1]
  const blocks = []
  let offset = 0
  for (const [count, perBlock] of groups) {
    for (let k = 0; k < count; k++) {
      const block = dataCw.slice(offset, offset + perBlock); offset += perBlock
      let gen = [1]
      for (let i = 0; i < ecLen; i++) { const ng = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { ng[j] ^= gfMul(gen[j], gfExp[i]); ng[j + 1] ^= gen[j] } gen = ng }
      const ec = new Array(ecLen).fill(0)
      for (const b of block) { const factor = b ^ ec.shift(); ec.push(0); if (factor) for (let i = 0; i < ecLen; i++) ec[i] ^= gfMul(gen[ecLen - 1 - i], factor) }
      blocks.push({ data: block, ec })
    }
  }
  const finalBits = []
  const maxData = Math.max(...blocks.map((b) => b.data.length))
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) for (let j = 7; j >= 0; j--) finalBits.push((b.data[i] >> j) & 1)
  for (let i = 0; i < ecLen; i++) for (const b of blocks) for (let j = 7; j >= 0; j--) finalBits.push((b.ec[i] >> j) & 1)
  // 矩阵
  const size = version * 4 + 17
  const mod = Array.from({ length: size }, () => new Array(size).fill(-1))
  function finder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy
      if (x < 0 || x >= size || y < 0 || y >= size) continue
      const d = Math.max(Math.abs(dx), Math.abs(dy))
      mod[y][x] = d === 4 ? 0 : d === 3 ? 1 : d === 2 ? 0 : 1
    }
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4)
  for (let i = 8; i < size - 8; i++) { if (mod[6][i] < 0) mod[6][i] = i % 2 === 0 ? 1 : 0; if (mod[i][6] < 0) mod[i][6] = i % 2 === 0 ? 1 : 0 }
  for (const cy of QR_ALIGN[version - 1]) for (const cx of QR_ALIGN[version - 1]) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); mod[cy + dy][cx + dx] = d === 1 ? 0 : 1 }
  }
  // 预留格式信息位（值 2 = 保留）
  for (let i = 0; i <= 5; i++) mod[i][8] = 2
  mod[7][8] = 2; mod[8][8] = 2; mod[8][7] = 2
  for (let i = 9; i < 15; i++) mod[8][14 - i] = 2
  for (let i = 0; i < 8; i++) mod[8][size - 1 - i] = 2
  for (let i = 8; i < 15; i++) mod[size - 15 + i][8] = 2
  mod[size - 8][8] = 1
  if (version >= 7) {
    const bits18 = (version << 12) | qrBchRemainder(version, 0x1f25, 12, 12)
    for (let i = 0; i < 18; i++) {
      const v = (bits18 >> i) & 1
      mod[Math.floor(i / 3)][size - 11 + (i % 3)] = v
      mod[size - 11 + (i % 3)][Math.floor(i / 3)] = v
    }
  }
  // 数据放置（mask 0: (x+y) 偶数翻转）
  let bitIdx = 0, dir = -1, px = size - 1, py = size - 1
  while (px > 0) {
    if (px === 6) px--
    while (py >= 0 && py < size) {
      for (let j = 0; j < 2; j++) {
        const x = px - j
        if (mod[py][x] === -1) {
          let v = bitIdx < finalBits.length ? finalBits[bitIdx++] : 0
          if ((x + py) % 2 === 0) v ^= 1
          mod[py][x] = v
        }
      }
      py += dir
    }
    dir = -dir; py += dir; px -= 2
  }
  // 格式信息（等级 M=00, mask 0=000）
  {
    const data5 = 0
    const formatBits = ((data5 << 10) | qrBchRemainder(data5, 0x537, 10, 10)) ^ 0x5412
    const bit = (i) => (formatBits >> i) & 1
    for (let i = 0; i <= 5; i++) mod[i][8] = bit(i)
    mod[7][8] = bit(6); mod[8][8] = bit(7); mod[8][7] = bit(8)
    for (let i = 9; i < 15; i++) mod[8][14 - i] = bit(i)
    for (let i = 0; i < 8; i++) mod[8][size - 1 - i] = bit(i)
    for (let i = 8; i < 15; i++) mod[size - 15 + i][8] = bit(i)
    mod[size - 8][8] = 1
  }
  return { size, modules: mod.map((row) => row.map((v) => (v === 1 ? 1 : 0))) }
}

if (typeof module !== 'undefined' && module.exports) module.exports = DT
