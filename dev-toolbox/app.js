/* 开发者工具箱 · 页面应用（Vue render 函数） */
const { createApp, ref, reactive, computed, h, watch, nextTick, onMounted, onUnmounted} = Vue

const storeBridge = {
req(action, payload) {
return new Promise((resolve, reject) => {
const requestId = Math.floor(Math.random() * 1e9) + 1
const handler = (ev) => {
const d = ev.data
if (!d || d.type!== 'newshell:plugin-action-response' || d.requestId!== requestId) return
window.removeEventListener('message', handler)
if (d.error) reject(new Error(d.error)); else resolve(d.result)
}
window.addEventListener('message', handler)
parent.postMessage({ type: 'newshell:plugin-action', action, payload: Object.assign({}, payload), requestId}, '*')
setTimeout(() => { window.removeEventListener('message', handler); reject(new Error('宿主响应超时'))}, 8000)
})
},
get: (key) => storeBridge.req('storage-get', { key}),
set: (key, value) => storeBridge.req('storage-set', { key, value})
}

/* ---------- 通用小组件 ---------- */
const S = reactive({})
function st(id, defaults) { if (!S[id]) S[id] = reactive(Object.assign({}, defaults)); return S[id]}
let toastFn = null
function toast(msg) { if (toastFn) toastFn(msg)}
function copyText(text) {
const done = () => toast('已复制')
if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
else fallbackCopy(text, done)
}
function fallbackCopy(text, done) {
const ta = document.createElement('textarea')
ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
document.body.appendChild(ta); ta.select()
try { document.execCommand('copy'); done()} catch { toast('复制失败，请手动复制')}
ta.remove()
}
function download(name, blob) {
const a = document.createElement('a')
a.href = URL.createObjectURL(blob); a.download = name; a.click()
setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}
function field(label, control, width) {
return h('div', { class: 'form-row', style: width? { width}: null}, [h('label', label), control])
}
function sel(s, key, options, width) {
return h('select', { value: s[key], style: width? { width}: null, onChange: (e) => { s[key] = e.target.value}},
options.map(([v, t]) => h('option', { value: v}, t)))
}
function txt(s, key, opts) {
opts = opts || {}
return h('input', { value: s[key], placeholder: opts.ph || '', style: opts.width? { width: opts.width}: null, type: opts.type || 'text', onInput: (e) => { s[key] = e.target.value}})
}
function num(s, key, opts) { opts = opts || {}; return h('input', { value: s[key], type: 'number', min: opts.min, max: opts.max, style: { width: opts.width || '90px'}, onInput: (e) => { s[key] = e.target.value}})}
function chk(s, key, label) {
return h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12.5px', cursor: 'pointer'}}, [
h('input', { type: 'checkbox', checked:!!s[key], style: { width: 'auto', margin: 0}, onChange: (e) => { s[key] = e.target.checked}}), label
])
}
function area(s, key, opts) {
opts = opts || {}
return h('textarea', { class: 'io', value: s[key], placeholder: opts.ph || '', style: opts.h? { minHeight: opts.h + 'px'}: null, spellcheck: false, onInput: (e) => { s[key] = e.target.value}})
}
function outArea(s, opts) {
opts = opts || {}
return h('div', [
h('div', { class: 'io-label'}, [h('span', opts.label || '输出'), h('span', { class: 'ops'}, [
h('span', { style: { color: 'var(--text-secondary)', fontWeight: 400}}, s.output? s.output.length + ' 字符': ''),
h('button', { class: ['btn', 'ghost', 'small'], onClick: () => { if (s.output) copyText(s.output)}}, '复制')
])]),
h('textarea', { class: 'io', value: s.output, readonly: true, spellcheck: false, style: opts.h? { minHeight: opts.h + 'px'}: null, placeholder: '结果显示在这里'}),
s.error? h('div', { class: 'err-text', style: { marginTop: '6px'}}, s.error): null
])
}
/* 标准 IO 工具布局：输入 + 选项 + 转换 + 输出 */
function ioTool(def, s) {
const run = () => {
try { s.output = def.run(s); s.error = ''} catch (e) { s.error = e.message;}
}
if (s.auto) { try { s.output = def.run(s); s.error = ''} catch (e) { s.error = e.message}}
return h('div', [
h('div', { class: 'io-label'}, [h('span', '输入'), h('span', { class: 'ops'}, [
h('button', { class: ['btn', 'ghost', 'small'], onClick: () => { s.input = ''; s.output = ''; s.error = ''}}, '清空')
])]),
area(s, 'input', { ph: def.ph || '在此输入…'}),
def.options? h('div', { class: 'opt-row'}, def.options(s)): null,
h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', margin: '10px 0'}}, [
h('button', { class: 'btn', onClick: run}, def.action || '转换'),
chk(s, 'auto', '输入时自动转换'),
def.note? h('span', { style: { color: 'var(--text-secondary)', fontSize: '12px'}}, def.note): null
]),
outArea(s)
])
}

/* ---------- 工具定义 ---------- */
const enc = DT.utf8Encode, dec = DT.utf8Decode
const TOOLS = []
function tool(def) { TOOLS.push(def)}

/* ===== 加解密 ===== */
tool({ id: 'hash', cat: '加解密', name: '哈希计算', desc: 'MD5 / SHA-1 / SHA-256 / SHA-512，纯 JS 实现，文本按 UTF-8 编码。',
defaults: { input: '', output: '', error: '', auto: true, algo: 'all'},
options: (s) => [field('算法', sel(s, 'algo', [['all', '全部'], ['md5', 'MD5'], ['sha1', 'SHA-1'], ['sha256', 'SHA-256'], ['sha512', 'SHA-512']]))],
run(s) {
const b = enc(s.input)
const one = (a) => DT.toHex(DT.hash(a, b))
if (s.algo!== 'all') return one(s.algo)
return ['md5', 'sha1', 'sha256', 'sha512'].map((a) => a.toUpperCase().replace('SHA', 'SHA-') + ' ' + one(a)).join('\n')
}})
tool({ id: 'hmac', cat: '加解密', name: 'HMAC 计算', desc: 'HMAC-MD5 / SHA-1 / SHA-256 / SHA-512，密钥与消息均按 UTF-8 文本。',
defaults: { input: '', output: '', error: '', auto: true, algo: 'sha256', key: ''},
options: (s) => [field('密钥', txt(s, 'key', { ph: 'secret', width: '200px'})), field('算法', sel(s, 'algo', [['md5', 'MD5'], ['sha1', 'SHA-1'], ['sha256', 'SHA-256'], ['sha512', 'SHA-512']]))],
run(s) { return DT.toHex(DT.hmac(s.algo, enc(s.key), enc(s.input)))}})
tool({ id: 'aes', cat: '加解密', name: 'AES 加解密', desc: 'AES-128/192/256（由密钥长度决定），CBC/ECB + PKCS7。密钥/IV 可用文本或 Hex。',
defaults: { input: '', output: '', error: '', auto: false, mode: 'CBC', key: '', keyFmt: 'text', iv: '', ivFmt: 'text', inFmt: 'text', outFmt: 'base64', pkcs7: true, dir: 'enc'},
options: (s) => [
field('方向', sel(s, 'dir', [['enc', '加密'], ['dec', '解密']])),
field('模式', sel(s, 'mode', [['CBC', 'CBC'], ['ECB', 'ECB']])),
field('密钥', txt(s, 'key', { ph: '16/24/32 字节', width: '190px'})),
field('密钥格式', sel(s, 'keyFmt', [['text', '文本'], ['hex', 'Hex']])),
field('IV（CBC）', txt(s, 'iv', { ph: '16 字节', width: '150px'})),
field('IV 格式', sel(s, 'ivFmt', [['text', '文本'], ['hex', 'Hex']])),
field('输入格式', sel(s, 'inFmt', [['text', '文本'], ['base64', 'Base64'], ['hex', 'Hex']])),
field('输出格式', sel(s, 'outFmt', [['base64', 'Base64'], ['hex', 'Hex'], ['text', '文本']])),
chk(s, 'pkcs7', 'PKCS7 填充')
],
action: '执行',
run(s) {
const parse = (v, fmt) => fmt === 'hex'? DT.fromHex(v): enc(v)
const key = parse(s.key, s.keyFmt)
const iv = s.mode === 'CBC'? parse(s.iv || '', s.ivFmt): null
if (s.mode === 'CBC' && iv.length!== 16) throw new Error('CBC 模式 IV 必须为 16 字节')
let data
if (s.dir === 'enc') data = s.inFmt === 'text'? enc(s.input): s.inFmt === 'hex'? DT.fromHex(s.input): DT.b64Decode(s.input)
else data = s.inFmt === 'base64'? DT.b64Decode(s.input): s.inFmt === 'hex'? DT.fromHex(s.input): enc(s.input)
const out = DT.aes(s.dir === 'enc', data, key, s.mode, iv, s.pkcs7)
return s.outFmt === 'hex'? DT.toHex(out): s.outFmt === 'text'? dec(out): DT.b64Encode(out)
}})
tool({ id: 'password', cat: '加解密', name: '随机密码生成', desc: '用 crypto.getRandomValues 生成，强度以熵估算。',
defaults: { len: 20, count: 5, lower: true, upper: true, digit: true, symbol: true, output: '', error: ''},
custom(s) {
const gen = () => {
let set = ''
if (s.lower) set += 'abcdefghijkmnopqrstuvwxyz'
if (s.upper) set += 'ABCDEFGHJKLMNPQRSTUVWXYZ'
if (s.digit) set += '23456789'
if (s.symbol) set += '!@#$%^&*()-_=+[]{}<>?'
if (!set) { s.error = '至少选择一种字符集'; return}
const buf = new Uint32Array(1)
const pick = () => { crypto.getRandomValues(buf); return set[buf[0] % set.length]}
const lines = []
for (let i = 0; i < Math.min(50, Number(s.count) || 1); i++) lines.push(Array.from({ length: Math.max(4, Number(s.len) || 20)}, pick).join(''))
s.output = lines.join('\n')
s.error = ''
s.entropy = Math.round((Number(s.len) || 20) * Math.log2(set.length))
}
return h('div', [
h('div', { class: 'opt-row'}, [
field('长度', num(s, 'len', { min: 4, max: 128, width: '76px'})),
field('数量', num(s, 'count', { min: 1, max: 50, width: '76px'})),
chk(s, 'lower', '小写'), chk(s, 'upper', '大写'), chk(s, 'digit', '数字'), chk(s, 'symbol', '符号'),
h('button', { class: 'btn', onClick: gen}, '生成'),
s.entropy? h('span', { style: { color: 'var(--text-secondary)', fontSize: '12px'}}, '单条熵约 ' + s.entropy + ' bit'): null
]),
outArea(s, { label: '生成的密码'})
])
}})

/* ===== 编解码 ===== */
function codecTool(id, name, desc, encodeFn, decodeFn, extra) {
tool(Object.assign({ id, cat: '编解码', name, desc,
defaults: { input: '', output: '', error: '', auto: true, dir: 'enc'},
options: (s) => [field('方向', sel(s, 'dir', [['enc', '编码'], ['dec', '解码']]))],
run(s) { return s.dir === 'enc'? encodeFn(s): decodeFn(s)}}, extra || {}))
}
codecTool('base64', 'Base64', '标准 Base64 编解码（UTF-8 文本），可选用 URL 安全变体（无填充）。',
(s) => DT.b64Encode(enc(s.input), s.urlsafe), (s) => dec(DT.b64Decode(s.input)),
{ defaults: { input: '', output: '', error: '', auto: true, dir: 'enc', urlsafe: false},
options: (s) => [field('方向', sel(s, 'dir', [['enc', '编码'], ['dec', '解码']])), chk(s, 'urlsafe', 'URL 安全（-_ 且去填充）')]})
codecTool('base32', 'Base32', 'RFC 4648 Base32 编解码。', (s) => DT.b32Encode(enc(s.input)), (s) => dec(DT.b32Decode(s.input)))
codecTool('hex', 'Hex 十六进制', '文本（UTF-8）与 Hex 互转。',
(s) => { const x = DT.toHex(enc(s.input)); return s.upper? x.toUpperCase(): x}, (s) => dec(DT.fromHex(s.input)),
{ defaults: { input: '', output: '', error: '', auto: true, dir: 'enc', upper: false},
options: (s) => [field('方向', sel(s, 'dir', [['enc', '编码'], ['dec', '解码']])), chk(s, 'upper', '大写输出')]})
codecTool('url', 'URL 编码', 'encodeURIComponent / encodeURI 两种范围。',
(s) => s.comp? encodeURIComponent(s.input): encodeURI(s.input), (s) => decodeURIComponent(s.input),
{ defaults: { input: '', output: '', error: '', auto: true, dir: 'enc', comp: true},
options: (s) => [field('方向', sel(s, 'dir', [['enc', '编码'], ['dec', '解码']])), chk(s, 'comp', '组件模式（编码全部保留字符）')]})
codecTool('unicode', 'Unicode 转义', '文本与 \\uXXXX 转义互转（代理对输出 \\uXXXX\\uXXXX 两段）。',
(s) => s.input.split('').map((ch) => {
const cp = ch.codePointAt(0)
if (!s.nonAsciiOnly && cp < 0x10000) return '\\u' + cp.toString(16).padStart(4, '0')
if (cp > 0xffff) { const v = cp - 0x10000; return '\\u' + (0xd800 + (v >> 10)).toString(16) + '\\u' + (0xdc00 + (v & 0x3ff)).toString(16)}
return s.nonAsciiOnly && cp < 128? ch: '\\u' + cp.toString(16).padStart(4, '0')
}).join(''),
(s) => s.input.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
{ defaults: { input: '', output: '', error: '', auto: true, dir: 'enc', nonAsciiOnly: true},
options: (s) => [field('方向', sel(s, 'dir', [['enc', '转义'], ['dec', '反转义']])), chk(s, 'nonAsciiOnly', '仅转义非 ASCII')]})
codecTool('htmlent', 'HTML 实体', 'HTML 实体编码/解码（& < > " \' 与数字实体）。',
(s) => s.input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
(s) => { const ta = document.createElement('textarea'); ta.innerHTML = s.input; return ta.value})
tool({ id: 'jwt', cat: '编解码', name: 'JWT 解码', desc: '解码 JWT 的 Header/Payload 并给出过期状态（不验签，验签请用 HMAC 工具比对）。',
defaults: { input: '', output: '', error: '', auto: true},
run(s) {
const parts = s.input.trim().split('.')
if (parts.length!== 3) throw new Error('JWT 应为三段：header.payload.signature')
const parse = (p) => JSON.parse(dec(DT.b64Decode(p)))
const header = parse(parts[0]); const payload = parse(parts[1])
const lines = ['', JSON.stringify(header, null, 2), '', '', JSON.stringify(payload, null, 2), '', '', parts[2]]
const now = Math.floor(Date.now() / 1000)
if (payload.exp) lines.push('', '过期时间 exp：' + new Date(payload.exp * 1000).toLocaleString('zh-CN', { hour12: false}) + (payload.exp < now? '（已过期）': '（未过期）'))
if (payload.iat) lines.push('签发时间 iat：' + new Date(payload.iat * 1000).toLocaleString('zh-CN', { hour12: false}))
if (payload.nbf) lines.push('生效时间 nbf：' + new Date(payload.nbf * 1000).toLocaleString('zh-CN', { hour12: false}) + (payload.nbf > now? '（尚未生效）': ''))
return lines.join('\n')
}})

/* ===== 文本处理 ===== */
tool({ id: 'case', cat: '文本处理', name: '命名风格转换', desc: 'camelCase / PascalCase / snake_case / kebab-case / CONSTANT_CASE / Title Case 等互转。',
  defaults: { input: '', output: '', error: '', auto: true, mode: 'camel' },
  options: (s) => [field('目标风格', sel(s, 'mode', [['camel', 'camelCase'], ['pascal', 'PascalCase'], ['snake', 'snake_case'], ['kebab', 'kebab-case'], ['constant', 'CONSTANT_CASE'], ['title', 'Title Case'], ['sentence', 'Sentence case'], ['upper', 'UPPERCASE'], ['lower', 'lowercase'], ['dot', 'dot.case'], ['path', 'path/case']]))],
  run(s) {
    const words = s.input.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^a-zA-Z0-9]+/).filter(Boolean).map((w) => w.toLowerCase())
    if (!words.length) return ''
    const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1)
    switch (s.mode) {
      case 'camel': return words.map((w, i) => i === 0 ? w : cap(w)).join('')
      case 'pascal': return words.map(cap).join('')
      case 'snake': return words.join('_')
      case 'kebab': return words.join('-')
      case 'constant': return words.join('_').toUpperCase()
      case 'title': return words.map(cap).join(' ')
      case 'sentence': { const r = words.join(' '); return r.charAt(0).toUpperCase() + r.slice(1) }
      case 'upper': return s.input.toUpperCase()
      case 'lower': return s.input.toLowerCase()
      case 'dot': return words.join('.')
      case 'path': return words.join('/')
    }
    return ''
  } })
tool({ id: 'lines', cat: '文本处理', name: '行处理', desc: '按行排序、去重、反转、去空行、逐行修剪等。',
  defaults: { input: '', output: '', error: '', auto: true, mode: 'sortAsc' },
  options: (s) => [field('操作', sel(s, 'mode', [['sortAsc', '升序排序'], ['sortDesc', '降序排序'], ['dedupe', '去重（保序）'], ['dedupeSort', '去重并排序'], ['reverse', '反转行序'], ['noEmpty', '删除空行'], ['trim', '逐行去首尾空格'], ['number', '添加行号'], ['shuffle', '随机打乱']]))],
  run(s) {
    let lines = s.input.split('\n')
    switch (s.mode) {
      case 'sortAsc': lines = [...lines].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })); break
      case 'sortDesc': lines = [...lines].sort((a, b) => b.localeCompare(a, 'zh-CN', { numeric: true })); break
      case 'dedupe': lines = [...new Set(lines)]; break
      case 'dedupeSort': lines = [...new Set(lines)].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })); break
      case 'reverse': lines = [...lines].reverse(); break
      case 'noEmpty': lines = lines.filter((l) => l.trim() !== ''); break
      case 'trim': lines = lines.map((l) => l.trim()); break
      case 'number': lines = lines.map((l, i) => (i + 1) + '. ' + l); break
      case 'shuffle': { const b = new Uint32Array(1); for (let i = lines.length - 1; i > 0; i--) { crypto.getRandomValues(b); const j = b[0] % (i + 1); [lines[i], lines[j]] = [lines[j], lines[i]] } break }
    }
    return lines.join('\n')
  } })
tool({ id: 'stats', cat: '文本处理', name: '文本统计', desc: '字符、单词、行数、字节等实时统计。',
  defaults: { input: '' },
  custom(s) {
    const t = s.input
    const bytes = enc(t).length
    const words = (t.match(/[\p{L}\p{N}]+/gu) || []).length
    const cjk = (t.match(/[一-鿿]/g) || []).length
    const stats = [
      ['字符数', t.length], ['不含空格', t.replace(/\s/g, '').length], ['字节（UTF-8）', bytes],
      ['单词数', words], ['汉字数', cjk], ['行数', t ? t.split('\n').length : 0],
      ['段落数', t ? t.split(/\n\s*\n/).filter((x) => x.trim()).length : 0], ['预计阅读', Math.max(1, Math.ceil(words / 300)) + ' 分钟']
    ]
    return h('div', [area(s, 'input', { ph: '粘贴文本，实时统计…', h: 190 }),
      h('div', { class: 'stat-grid' }, stats.map(([k, v]) => h('div', { class: 'stat-card' }, [h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k)])))])
  } })
tool({ id: 'slug', cat: '文本处理', name: 'Slug 生成', desc: '标题转 URL 友好的 slug（拼音不转写，汉字可保留或剔除）。',
  defaults: { input: '', output: '', error: '', auto: true, keepCjk: false },
  options: (s) => [chk(s, 'keepCjk', '保留汉字')],
  run(s) {
    let r = s.input.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    if (!s.keepCjk) r = r.replace(/[^\x00-\x7f]/g, '')
    return r.replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '')
  } })
tool({ id: 'regex', cat: '文本处理', name: '正则测试', desc: '匹配高亮、捕获组列表与替换预览（JS 正则引擎）。',
  defaults: { pattern: '', flags: 'g', test: '', replace: '', error: '' },
  custom(s) {
    let re = null, matches = [], err = ''
    try { re = new RegExp(s.pattern, s.flags.includes('g') ? s.flags : s.flags + 'g') } catch (e) { err = '正则错误：' + e.message }
    if (re && s.pattern) {
      let m, guard = 0
      while ((m = re.exec(s.test)) && guard++ < 500) { matches.push(m); if (m[0] === '') re.lastIndex++ }
    }
    let replaced = ''
    if (re && s.pattern) { try { replaced = s.test.replace(new RegExp(s.pattern, s.flags), s.replace) } catch { replaced = '' } }
    const highlight = () => {
      if (!matches.length) return [s.test || h('span', { style: { color: 'var(--text-secondary)' } }, '（无匹配）')]
      const nodes = []; let last = 0
      for (const m of matches) { if (m.index > last) nodes.push(s.test.slice(last, m.index)); nodes.push(h('mark', m[0])); last = m.index + m[0].length }
      if (last < s.test.length) nodes.push(s.test.slice(last))
      return nodes
    }
    return h('div', [
      h('div', { class: 'opt-row' }, [
        field('正则表达式', txt(s, 'pattern', { ph: '\\d+', width: '300px' })),
        field('标志', txt(s, 'flags', { ph: 'gim', width: '70px' })),
        field('替换为', txt(s, 'replace', { ph: '$1', width: '130px' }))
      ]),
      err ? h('div', { class: 'err-text' }, err) : null,
      h('div', { class: 'io-label' }, [h('span', '测试文本')]),
      area(s, 'test', { ph: '在此输入测试文本…', h: 120 }),
      h('div', { class: 'io-label', style: { marginTop: '12px' } }, [h('span', '匹配高亮（' + matches.length + ' 处）')]),
      h('div', { class: 'regex-marks' }, highlight()),
      matches.length ? h('table', { class: 'kv-table', style: { marginTop: '10px' } }, [
        h('tr', [h('th', '位置'), h('th', '匹配'), h('th', '捕获组')]),
        ...matches.slice(0, 50).map((m) => h('tr', [h('td', String(m.index)), h('td', { class: 'mono' }, m[0]), h('td', { class: 'mono' }, m.slice(1).map((g, i) => '$' + (i + 1) + '=' + (g === undefined ? '∅' : g)).join('  ') || '-')]))
      ]) : null,
      s.replace ? h('div', [h('div', { class: 'io-label', style: { marginTop: '12px' } }, [h('span', '替换结果'), h('button', { class: ['btn', 'ghost', 'small'], onClick: () => copyText(replaced) }, '复制')]), h('div', { class: 'regex-marks' }, replaced)]) : null
    ])
  } })

/* ===== 数据转换 ===== */
tool({ id: 'base', cat: '数据转换', name: '进制转换', desc: '2/8/10/16/36 进制互转（BigInt，支持大整数）。',
  defaults: { input: '', output: '', error: '', auto: true, from: '10', to: '16' },
  options: (s) => [field('源进制', sel(s, 'from', [['2', '二进制'], ['8', '八进制'], ['10', '十进制'], ['16', '十六进制'], ['36', '36 进制']])), field('目标进制', sel(s, 'to', [['2', '二进制'], ['8', '八进制'], ['10', '十进制'], ['16', '十六进制'], ['36', '36 进制']]))],
  run(s) {
    const one = DT.convertBase(s.input, Number(s.from), Number(s.to))
    const all = [2, 8, 10, 16].map((b) => b + ' 进制  ' + DT.convertBase(s.input, Number(s.from), b)).join('\n')
    return '结果（' + s.to + ' 进制）：' + one + '\n\n' + all
  } })
tool({ id: 'bytes', cat: '数据转换', name: '字节大小换算', desc: '字节数与 KB/MB/GB（1000）及 KiB/MiB/GiB（1024）互换。',
  defaults: { input: '', output: '', error: '', auto: true },
  run(s) {
    const n = DT.parseBytes(s.input)
    const rows = ['字节  ' + Math.round(n) + ' B']
    for (const [name, base] of [['KB', 1e3], ['MB', 1e6], ['GB', 1e9], ['TB', 1e12], ['KiB', 1024], ['MiB', 1024 ** 2], ['GiB', 1024 ** 3], ['TiB', 1024 ** 4]]) rows.push(name + '  ' + (n / base).toFixed(4).replace(/\.?0+$/, ''))
    return rows.join('\n')
  }, note: '输入如 1024、1.5 MB、2 GiB' })
tool({ id: 'jsonyaml', cat: '数据转换', name: 'JSON ↔ YAML', desc: 'JSON 与 YAML 互转（YAML 为常用子集：嵌套对象/数组/标量；锚点、多行块等不支持）。',
  defaults: { input: '', output: '', error: '', auto: false, dir: 'j2y' },
  options: (s) => [field('方向', sel(s, 'dir', [['j2y', 'JSON → YAML'], ['y2j', 'YAML → JSON']]))],
  action: '转换',
  run(s) {
    if (s.dir === 'j2y') return DT.jsonToYaml(JSON.parse(s.input))
    return JSON.stringify(DT.yamlToJson(s.input), null, 2)
  } })
tool({ id: 'csvjson', cat: '数据转换', name: 'CSV ↔ JSON', desc: 'CSV 与 JSON 数组互转（支持引号转义）。',
  defaults: { input: '', output: '', error: '', auto: false, dir: 'c2j' },
  options: (s) => [field('方向', sel(s, 'dir', [['c2j', 'CSV → JSON'], ['j2c', 'JSON → CSV']]))],
  action: '转换',
  run(s) { return s.dir === 'c2j' ? JSON.stringify(DT.csvToJson(s.input), null, 2) : DT.jsonToCsv(JSON.parse(s.input)) } })
tool({ id: 'query', cat: '数据转换', name: 'URL 参数解析', desc: '查询字符串解析为 JSON / JSON 对象构建查询字符串。',
  defaults: { input: '', output: '', error: '', auto: true, dir: 'parse' },
  options: (s) => [field('方向', sel(s, 'dir', [['parse', '解析 → JSON'], ['build', 'JSON → 查询串']]))],
  run(s) {
    if (s.dir === 'parse') {
      const q = s.input.trim().replace(/^\?/, '').split('#')[0]
      const full = q.includes('://') ? q.slice(q.indexOf('?') + 1) : q
      const obj = {}
      for (const [k, v] of new URLSearchParams(full)) { if (obj[k] === undefined) obj[k] = v; else if (Array.isArray(obj[k])) obj[k].push(v); else obj[k] = [obj[k], v] }
      return JSON.stringify(obj, null, 2)
    }
    const obj = JSON.parse(s.input)
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(obj)) { if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x))); else p.set(k, String(v)) }
    return p.toString()
  } })

/* ===== 格式化 ===== */
tool({ id: 'jsonfmt', cat: '格式化', name: 'JSON 格式化', desc: '格式化/压缩/校验，报错给出大致位置。',
  defaults: { input: '', output: '', error: '', auto: false, indent: '2', mode: 'fmt' },
  options: (s) => [field('操作', sel(s, 'mode', [['fmt', '格式化'], ['min', '压缩'], ['check', '仅校验']])), field('缩进', sel(s, 'indent', [['2', '2 空格'], ['4', '4 空格'], ['tab', 'Tab']]))],
  action: '执行',
  run(s) {
    let v
    try { v = JSON.parse(s.input) } catch (e) {
      const m = /position (\d+)/i.exec(e.message)
      let hint = ''
      if (m) { const pos = Number(m[1]); const before = s.input.slice(0, pos); const line = before.split('\n').length; const col = pos - before.lastIndexOf('\n'); hint = '（第 ' + line + ' 行第 ' + col + ' 列附近）' }
      throw new Error('JSON 语法错误：' + e.message + hint)
    }
    if (s.mode === 'check') return '✓ 合法 JSON（' + (Array.isArray(v) ? '数组，' + v.length + ' 项' : typeof v === 'object' && v ? '对象，' + Object.keys(v).length + ' 个键' : typeof v) + '）'
    return s.mode === 'min' ? JSON.stringify(v) : JSON.stringify(v, null, s.indent === 'tab' ? '\t' : Number(s.indent))
  } })
tool({ id: 'xmlfmt', cat: '格式化', name: 'XML 格式化', desc: 'XML 缩进排版 + 良构校验。',
  defaults: { input: '', output: '', error: '', auto: false },
  action: '格式化',
  run(s) {
    const doc = new DOMParser().parseFromString(s.input, 'text/xml')
    if (doc.querySelector('parsererror')) throw new Error('XML 不良构：' + (doc.querySelector('parsererror').textContent || '').split('\n')[0])
    return DT.formatXml(s.input)
  } })
tool({ id: 'sqlfmt', cat: '格式化', name: 'SQL 格式化', desc: '关键字大写换行的基础排版（复杂语句仅供参考）。',
  defaults: { input: '', output: '', error: '', auto: true },
  run(s) { return DT.formatSql(s.input) } })
tool({ id: 'jsonesc', cat: '格式化', name: 'JSON 字符串转义', desc: '文本与 JSON 字符串字面量互转。',
  defaults: { input: '', output: '', error: '', auto: true, dir: 'esc' },
  options: (s) => [field('方向', sel(s, 'dir', [['esc', '转义'], ['unesc', '反转义']]))],
  run(s) { return s.dir === 'esc' ? JSON.stringify(s.input) : JSON.parse(s.input.startsWith('"') ? s.input : '"' + s.input + '"') } })

/* ===== 时间 ===== */
tool({ id: 'timestamp', cat: '时间计算', name: '时间戳转换', desc: 'Unix 时间戳（秒/毫秒自动判别）与日期时间互转，多时区显示。',
  defaults: { ts: '', date: '', tz: 'local', nowText: '' },
  custom(s) {
    const zones = [['local', '本地'], ['UTC', 'UTC'], ['Asia/Shanghai', '上海'], ['Asia/Tokyo', '东京'], ['Europe/London', '伦敦'], ['America/New_York', '纽约'], ['America/Los_Angeles', '洛杉矶']]
    const fmtIn = (d) => {
      try {
        return new Intl.DateTimeFormat('zh-CN', { timeZone: s.tz === 'local' ? undefined : s.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d)
      } catch { return d.toLocaleString('zh-CN', { hour12: false }) }
    }
    let conv = []
    const tsNum = Number(String(s.ts).trim())
    if (s.ts && isFinite(tsNum)) {
      const ms = String(Math.trunc(tsNum)).length >= 13 ? tsNum : tsNum * 1000
      const d = new Date(ms)
      if (!isNaN(d)) conv = [['毫秒时间戳', String(Math.trunc(ms))], ['秒时间戳', String(Math.floor(ms / 1000))], ['日期时间（所选时区）', fmtIn(d)], ['ISO 8601', d.toISOString()]]
    }
    let fromDate = []
    if (s.date) { const d = new Date(s.date); if (!isNaN(d)) fromDate = [['秒时间戳', String(Math.floor(d.getTime() / 1000))], ['毫秒时间戳', String(d.getTime())]] }
    return h('div', [
      h('div', { class: 'opt-row' }, [field('显示时区', sel(s, 'tz', zones)), h('span', { style: { fontSize: '12.5px', color: 'var(--text-secondary)' } }, '当前时间戳：' + s.nowText)]),
      h('div', { class: 'tool-cols' }, [
        h('div', [h('div', { class: 'io-label' }, [h('span', '时间戳 → 日期')]), txt(s, 'ts', { ph: '如 1793000000 或毫秒', width: '100%' }),
          conv.length ? h('table', { class: 'kv-table' }, conv.map(([k, v]) => h('tr', [h('td', k), h('td', { class: 'mono' }, v)]))) : null]),
        h('div', [h('div', { class: 'io-label' }, [h('span', '日期 → 时间戳（本地时区解析）')]), h('input', { type: 'datetime-local', value: s.date, step: '1', style: { width: '100%' }, onInput: (e) => { s.date = e.target.value } }),
          fromDate.length ? h('table', { class: 'kv-table' }, fromDate.map(([k, v]) => h('tr', [h('td', k), h('td', { class: 'mono' }, v)]))) : null])
      ])
    ])
  } })
tool({ id: 'datediff', cat: '时间计算', name: '日期差计算', desc: '两个日期之间的间隔分解，以及日期加减天数。',
  defaults: { a: '', b: '', base: '', addDays: 30, output: '', error: '' },
  custom(s) {
    let rows = []
    if (s.a && s.b) {
      const d1 = new Date(s.a), d2 = new Date(s.b)
      if (!isNaN(d1) && !isNaN(d2)) {
        const diff = Math.abs(d2 - d1)
        const days = Math.floor(diff / 86400000)
        rows = [['总天数', (diff / 86400000).toFixed(2) + ' 天'], ['分解', days + ' 天 ' + Math.floor(diff % 86400000 / 3600000) + ' 小时 ' + Math.floor(diff % 3600000 / 60000) + ' 分钟 ' + Math.floor(diff % 60000 / 1000) + ' 秒'], ['总小时', (diff / 3600000).toFixed(2)], ['总分钟', String(Math.round(diff / 60000))], ['约合', (days / 7).toFixed(1) + ' 周 / ' + (days / 30.44).toFixed(1) + ' 个月 / ' + (days / 365.25).toFixed(2) + ' 年'], ['方向', d2 >= d1 ? '结束 ≥ 开始' : '注意：结束早于开始（取绝对值）']]
      }
    }
    let addResult = ''
    if (s.base && s.addDays !== '') { const d = new Date(s.base); if (!isNaN(d)) { d.setDate(d.getDate() + Number(s.addDays)); addResult = d.toLocaleDateString('zh-CN') + '（星期' + '日一二三四五六'[d.getDay()] + '）' } }
    return h('div', [
      h('div', { class: 'opt-row' }, [
        field('开始日期', h('input', { type: 'datetime-local', value: s.a, onInput: (e) => { s.a = e.target.value } })),
        field('结束日期', h('input', { type: 'datetime-local', value: s.b, onInput: (e) => { s.b = e.target.value } }))
      ]),
      rows.length ? h('table', { class: 'kv-table' }, rows.map(([k, v]) => h('tr', [h('td', k), h('td', v)]))) : h('div', { style: { color: 'var(--text-secondary)', fontSize: '12.5px' } }, '选择两个日期后显示间隔。'),
      h('div', { class: 'io-label', style: { marginTop: '16px' } }, [h('span', '日期加减')]),
      h('div', { class: 'opt-row' }, [
        field('基准日期', h('input', { type: 'date', value: s.base, onInput: (e) => { s.base = e.target.value } })),
        field('加（天，可负）', num(s, 'addDays', { width: '90px' })),
        addResult ? h('span', { style: { fontSize: '13px' } }, '结果：' + addResult) : null
      ])
    ])
  } })
tool({ id: 'cron', cat: '时间计算', name: 'Cron 表达式', desc: '解析标准 5 段 cron，给出中文说明与未来 5 次执行时间（本地时区）。',
  defaults: { expr: '*/15 9-17 * * 1-5', output: '', error: '', auto: true },
  options: () => [],
  run(s) {
    const { desc } = DT.cronExplain(s.expr)
    const next = DT.cronNext(s.expr, 5).map((d) => d.toLocaleString('zh-CN', { hour12: false }) + '（星期' + '日一二三四五六'[d.getDay()] + '）')
    return '说明：' + desc + '\n\n未来 5 次执行：\n' + next.map((x, i) => (i + 1) + '. ' + x).join('\n')
  } })

/* ===== 网络运维 ===== */
tool({ id: 'subnet', cat: '网络运维', name: '子网计算', desc: 'CIDR 计算：网络/广播地址、掩码、可用主机范围。',
  defaults: { input: '192.168.1.10/24', output: '', error: '', auto: true },
  run(s) {
    const r = DT.subnetCalc(s.input)
    const rows = [['IP 地址', r.ip + ' /' + r.prefix], ['子网掩码', r.mask], ['掩码二进制', r.maskBinary], ['通配符掩码', r.wildcard], ['网络地址', r.network], ['广播地址', r.broadcast], ['可用主机范围', r.firstHost + ' – ' + r.lastHost], ['地址总数', String(r.total)], ['可用主机数', String(r.hosts)]]
    return rows.map(([k, v]) => k + '：' + v).join('\n')
  } })
tool({ id: 'ip', cat: '网络运维', name: 'IP 地址工具', desc: 'IPv4 与整数互转、地址分类判断。',
  defaults: { input: '', output: '', error: '', auto: true },
  run(s) {
    const t = s.input.trim()
    if (/^\d+$/.test(t)) {
      const v = Number(t)
      if (v > 4294967295) throw new Error('超出 IPv4 整数范围')
      return 'IP：' + [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.')
    }
    const m = t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (!m) throw new Error('请输入 IPv4 地址或其整数形式')
    const o = m.slice(1).map(Number)
    if (o.some((x) => x > 255)) throw new Error('IP 段超出 255')
    const v = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
    let cls = '公网地址'
    if (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)) cls = '私有地址（RFC 1918）'
    else if (o[0] === 127) cls = '回环地址'
    else if (o[0] === 169 && o[1] === 254) cls = '链路本地地址'
    else if (o[0] >= 224 && o[0] <= 239) cls = '组播地址'
    else if (t === '0.0.0.0') cls = '未指定地址'
    else if (t === '255.255.255.255') cls = '受限广播地址'
    return ['整数：' + v, '十六进制：0x' + v.toString(16).padStart(8, '0'), '分类：' + cls].join('\n')
  } })
const PORTS = [[20, 'FTP 数据'], [21, 'FTP 控制'], [22, 'SSH'], [23, 'Telnet'], [25, 'SMTP'], [53, 'DNS'], [67, 'DHCP 服务端'], [68, 'DHCP 客户端'], [69, 'TFTP'], [80, 'HTTP'], [110, 'POP3'], [143, 'IMAP'], [443, 'HTTPS'], [445, 'SMB'], [993, 'IMAPS'], [995, 'POP3S'], [1080, 'SOCKS 代理'], [1433, 'SQL Server'], [1521, 'Oracle DB'], [1883, 'MQTT'], [2181, 'ZooKeeper'], [2375, 'Docker API（明文）'], [2376, 'Docker API（TLS）'], [3000, 'Grafana / 开发服务'], [3306, 'MySQL'], [3389, 'RDP 远程桌面'], [5432, 'PostgreSQL'], [5672, 'RabbitMQ AMQP'], [5900, 'VNC'], [6379, 'Redis'], [6443, 'Kubernetes API'], [8000, '开发服务常用'], [8080, 'HTTP 代理/备用'], [8443, 'HTTPS 备用'], [8888, '开发服务常用'], [9092, 'Kafka'], [9200, 'Elasticsearch'], [11211, 'Memcached'], [15672, 'RabbitMQ 管理台'], [27017, 'MongoDB']]
tool({ id: 'ports', cat: '网络运维', name: '常用端口速查', desc: '按端口号或服务名过滤（内置静态表，离线可用）。',
  defaults: { q: '' },
  custom(s) {
    const q = s.q.trim().toLowerCase()
    const rows = PORTS.filter(([p, name]) => !q || String(p).includes(q) || name.toLowerCase().includes(q))
    return h('div', [
      h('div', { class: 'opt-row' }, [field('过滤', txt(s, 'q', { ph: '输入端口或服务名…', width: '260px' }))]),
      h('table', { class: 'kv-table' }, [h('tr', [h('th', '端口'), h('th', '服务')]), ...rows.map(([p, name]) => h('tr', [h('td', { class: 'mono' }, String(p)), h('td', name)]))]),
      rows.length ? null : h('div', { style: { color: 'var(--text-secondary)', marginTop: '8px' } }, '无匹配项')
    ])
  } })

/* ===== 图像生成 ===== */
tool({ id: 'qr', cat: '图像生成', name: '二维码生成', desc: '纯 JS 生成 QR 码（字节模式、纠错等级 M、版本自动 1–10），可下载 PNG。',
  defaults: { text: 'https://example.com', size: 512, err: '' },
  custom(s) {
    const draw = () => {
      const cv = document.getElementById('qrCanvas')
      if (!cv) return
      try {
        const qr = DT.qrEncode(s.text || ' ')
        const quiet = 4, total = qr.size + quiet * 2
        const scale = Math.max(1, Math.floor(Number(s.size) / total))
        cv.width = total * scale; cv.height = total * scale
        const ctx = cv.getContext('2d')
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height)
        ctx.fillStyle = '#000'
        for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale)
        s.err = ''
      } catch (e) { s.err = e.message }
    }
    nextTick(draw)
    return h('div', [
      h('div', { class: 'io-label' }, [h('span', '内容')]),
      area(s, 'text', { ph: '输入文本或链接…', h: 76 }),
      h('div', { class: 'opt-row' }, [
        field('PNG 尺寸', sel(s, 'size', [['256', '256'], ['512', '512'], ['1024', '1024']])),
        h('button', { class: 'btn', onClick: () => { const cv = document.getElementById('qrCanvas'); if (cv) cv.toBlob((b) => download('qrcode.png', b), 'image/png') } }, '下载 PNG')
      ]),
      s.err ? h('div', { class: 'err-text' }, s.err) : null,
      h('div', { class: 'qr-wrap' }, [h('div', { class: 'qr-canvas-box' }, [h('canvas', { id: 'qrCanvas', style: { width: '260px', height: '260px' } })])])
    ])
  } })
tool({ id: 'placeholder', cat: '图像生成', name: '占位图生成', desc: '生成指定尺寸/颜色/文字的占位 PNG。',
  defaults: { w: 640, h: 360, bg: '#3b4252', fg: '#eceff4', text: '', err: '' },
  custom(s) {
    const draw = () => {
      const cv = document.getElementById('phCanvas')
      if (!cv) return
      const w = Math.min(2000, Math.max(16, Number(s.w) || 640)), hgt = Math.min(2000, Math.max(16, Number(s.h) || 360))
      cv.width = w; cv.height = hgt
      const ctx = cv.getContext('2d')
      ctx.fillStyle = s.bg; ctx.fillRect(0, 0, w, hgt)
      ctx.fillStyle = s.fg
      const label = s.text || (w + ' × ' + hgt)
      ctx.font = '600 ' + Math.max(12, Math.min(64, Math.floor(w / 12))) + 'px sans-serif'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(label, w / 2, hgt / 2)
    }
    nextTick(draw)
    return h('div', [
      h('div', { class: 'opt-row' }, [
        field('宽', num(s, 'w', { min: 16, max: 2000 })), field('高', num(s, 'h', { min: 16, max: 2000 })),
        field('背景', h('input', { type: 'color', value: s.bg, style: { width: '52px', height: '32px', padding: '2px' }, onInput: (e) => { s.bg = e.target.value } })),
        field('文字色', h('input', { type: 'color', value: s.fg, style: { width: '52px', height: '32px', padding: '2px' }, onInput: (e) => { s.fg = e.target.value } })),
        field('文字（空=尺寸）', txt(s, 'text', { width: '150px' })),
        h('button', { class: 'btn', onClick: () => { const cv = document.getElementById('phCanvas'); if (cv) cv.toBlob((b) => download('placeholder.png', b), 'image/png') } }, '下载 PNG')
      ]),
      h('canvas', { id: 'phCanvas', style: { maxWidth: '100%', borderRadius: '8px', border: '1px solid var(--border-color)' } })
    ])
  } })
tool({ id: 'color', cat: '图像生成', name: '颜色工具', desc: 'HEX/RGB/HSL 互转与对比度（WCAG）计算。',
  defaults: { hex: '#2563eb', hex2: '#ffffff' },
  custom(s) {
    const parse = (v) => {
      const m = String(v).trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i)
      if (!m) return null
      let hx = m[1]; if (hx.length === 3) hx = hx.split('').map((c) => c + c).join('')
      return [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16)]
    }
    const rgb = parse(s.hex)
    let rows = [], contrast = ''
    if (rgb) {
      const [r, g, b] = rgb
      const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255
      let hh = 0; const d = mx - mn
      if (d) { const rn = r / 255, gn = g / 255, bn = b / 255; if (mx === rn) hh = ((gn - bn) / d) % 6; else if (mx === gn) hh = (bn - rn) / d + 2; else hh = (rn - gn) / d + 4; hh *= 60; if (hh < 0) hh += 360 }
      const ll = (mx + mn) / 2, ss = d === 0 ? 0 : d / (1 - Math.abs(2 * ll - 1))
      rows = [['HEX', '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()], ['RGB', 'rgb(' + r + ', ' + g + ', ' + b + ')'], ['HSL', 'hsl(' + Math.round(hh) + ', ' + Math.round(ss * 100) + '%, ' + Math.round(ll * 100) + '%)'], ['CSS 变量示例', '--color: #' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('')]]
      const rgb2 = parse(s.hex2)
      if (rgb2) {
        const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
        const ratio = (Math.max(lum(rgb), lum(rgb2)) + 0.05) / (Math.min(lum(rgb), lum(rgb2)) + 0.05)
        contrast = '与 ' + s.hex2 + ' 的对比度 ' + ratio.toFixed(2) + ':1（WCAG AA 正文需 ≥ 4.5，' + (ratio >= 4.5 ? '达标' : '未达标') + '；大字 ≥ 3，' + (ratio >= 3 ? '达标' : '未达标') + '）'
      }
    }
    return h('div', [
      h('div', { class: 'qr-wrap' }, [
        h('div', { style: { width: '220px' } }, [h('div', { class: 'swatch', style: { background: rgb ? s.hex : 'transparent' } }),
          h('div', { class: 'opt-row' }, [field('颜色', txt(s, 'hex', { width: '110px' })), h('input', { type: 'color', value: rgb ? s.hex : '#000000', style: { width: '46px', height: '32px', padding: '2px' }, onInput: (e) => { s.hex = e.target.value } })])]),
        h('div', { style: { flex: 1, minWidth: '260px' } }, [
          rows.length ? h('table', { class: 'kv-table' }, rows.map(([k, v]) => h('tr', [h('td', k), h('td', { class: 'mono' }, v)]))) : h('div', { class: 'err-text' }, '颜色格式无效（示例 #2563eb）'),
          h('div', { class: 'opt-row' }, [field('对比色', txt(s, 'hex2', { width: '110px' }))]),
          contrast ? h('div', { style: { fontSize: '12.5px' } }, contrast) : null
        ])
      ])
    ])
  } })

/* ---------- 应用外壳 ---------- */
const CATS = ['加解密', '编解码', '文本处理', '数据转换', '格式化', '时间计算', '网络运维', '图像生成']
const App = {
  setup() {
    const uiTheme = ref('dark')
    const toastText = ref('')
    const toastShow = ref(false)
    let toastTimer = null
    toastFn = (msg) => { toastText.value = msg; toastShow.value = true; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastShow.value = false }, 2600) }
    const activeId = ref('hash')
    const query = ref('')
    const nowText = ref('')
    let nowTimer = null
    async function toggleTheme() {
      uiTheme.value = uiTheme.value === 'dark' ? 'light' : 'dark'
      if (window.__osSetTheme) window.__osSetTheme(uiTheme.value)
      try { await storeBridge.set('ui-theme', uiTheme.value) } catch (_) { /* ignore */ }
    }
    function resize() {
      nextTick(() => {
        const el = document.getElementById('app')
        const hh = el ? el.scrollHeight : document.body.scrollHeight
        parent.postMessage({ type: 'newshell:resize', height: hh }, '*')
      })
    }
    watch([activeId, query], () => nextTick(resize))
    watch(S, () => nextTick(resize), { deep: true })
    onMounted(async () => {
      try { const t = await storeBridge.get('ui-theme'); if (t === 'light' || t === 'dark') { uiTheme.value = t; if (window.__osSetTheme) window.__osSetTheme(t) } } catch (_) { /* ignore */ }
      const tick = () => { const s = st('timestamp', {}); s.nowText = Math.floor(Date.now() / 1000) + ' 秒 / ' + Date.now() + ' 毫秒'; nowText.value = s.nowText }
      tick(); nowTimer = setInterval(tick, 1000)
      nextTick(resize)
    })
    onUnmounted(() => { if (nowTimer) clearInterval(nowTimer) })
    return () => {
      const def = TOOLS.find((t) => t.id === activeId.value) || TOOLS[0]
      const s = st(def.id, def.defaults || {})
      const q = query.value.trim().toLowerCase()
      const navGroups = CATS.map((cat) => {
        const items = TOOLS.filter((t) => t.cat === cat && (!q || t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)))
        if (!items.length) return null
        return h('div', [h('div', { class: 'nav-cat' }, cat), ...items.map((t) => h('button', { class: ['nav-item', { active: t.id === activeId.value }], onClick: () => { activeId.value = t.id } }, t.name))])
      }).filter(Boolean)
      return h('div', [
        h('div', { class: 'topbar' }, [
          h('h1', '开发者工具箱'),
          h('span', { style: { color: 'var(--text-secondary)', fontSize: '12px' } }, TOOLS.length + ' 个工具 · 完全离线'),
          h('span', { style: { flex: 1 } }),
          h('button', { class: ['btn', 'ghost'], onClick: toggleTheme }, uiTheme.value === 'dark' ? '切换浅色' : '切换深色')
        ]),
        h('div', { class: 'layout' }, [
          h('aside', { class: 'nav' }, [
            h('div', { class: 'nav-search' }, [h('input', { value: query.value, placeholder: '搜索工具…', style: { height: '32px', fontSize: '12.5px' }, onInput: (e) => { query.value = e.target.value } })]),
            ...navGroups
          ]),
          h('main', { class: 'main', style: { display: 'flex' } }, [
            h('div', { class: 'tool-panel' }, [
              h('div', { class: 'tool-head' }, [h('h2', def.name), h('div', { class: 'desc' }, def.desc)]),
              def.custom ? def.custom(s) : ioTool(def, s)
            ])
          ])
        ]),
        h('div', { class: ['toast', { show: toastShow.value }] }, toastText.value)
      ])
    }
  }
}
createApp(App).mount('#app')
