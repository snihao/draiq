/** DXF 字节流解码结果。 @author snihao */
export interface DecodedDxfText {
  /** 解码后的 DXF 文本。 */
  text: string
  /** 实际使用的文本编码。 */
  encoding: string
  /** DXF 头部声明的代码页，未声明时为空。 */
  codePage: string | null
}

const HEADER_PROBE_BYTES = 256 * 1024

const DXF_CODE_PAGE_ENCODINGS: Record<string, string> = {
  'ANSI_874': 'windows-874',
  'ANSI_932': 'shift_jis',
  'ANSI_936': 'gb18030',
  'ANSI_949': 'euc-kr',
  'ANSI_950': 'big5',
  'ANSI_1250': 'windows-1250',
  'ANSI_1251': 'windows-1251',
  'ANSI_1252': 'windows-1252',
  'ANSI_1253': 'windows-1253',
  'ANSI_1254': 'windows-1254',
  'ANSI_1255': 'windows-1255',
  'ANSI_1256': 'windows-1256',
  'ANSI_1257': 'windows-1257',
  'ANSI_1258': 'windows-1258',
  'ANSI_65001': 'utf-8',
  'DOS866': 'ibm866',
  'DOS_866': 'ibm866',
  'UTF8': 'utf-8',
  'UTF-8': 'utf-8',
}

/**
 * 以字节流读取 DXF，避免 `Blob.text()` 强制使用 UTF-8 导致旧版 CAD 文字乱码。
 * @param file 待读取的 DXF 文件。
 * @returns 解码后的 DXF 文本及编码信息。
 * @author snihao
 */
export async function readDxfFile(file: Blob): Promise<DecodedDxfText> {
  return decodeDxfBytes(await file.arrayBuffer())
}

/**
 * 根据 BOM、DXF 版本和 `$DWGCODEPAGE` 声明解码 DXF 字节流。
 * @param input DXF 原始字节流。
 * @returns 解码后的 DXF 文本及编码信息。
 * @author snihao
 */
export function decodeDxfBytes(input: ArrayBuffer | Uint8Array): DecodedDxfText {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (!bytes.length) return { text: '', encoding: 'utf-8', codePage: null }

  const bomEncoding = detectBomEncoding(bytes)
  if (bomEncoding) {
    const text = decode(bytes, bomEncoding)
    return { text, encoding: bomEncoding, codePage: headerValue(text, '$DWGCODEPAGE') }
  }

  const utf16Encoding = detectBomlessUtf16(bytes)
  if (utf16Encoding) {
    const text = decode(bytes, utf16Encoding)
    return { text, encoding: utf16Encoding, codePage: headerValue(text, '$DWGCODEPAGE') }
  }

  const probe = decode(bytes.subarray(0, Math.min(bytes.length, HEADER_PROBE_BYTES)), 'windows-1252')
  const codePage = headerValue(probe, '$DWGCODEPAGE')
  const acadVersion = headerValue(probe, '$ACADVER')
  const declaredEncoding = resolveCodePageEncoding(codePage)
  const utf8Valid = canDecode(bytes, 'utf-8')

  // AC1021（AutoCAD 2007）及更高版本使用 UTF-8，部分导出器仍会遗留旧代码页声明。
  const unicodeDxf = dxfVersionNumber(acadVersion) >= 1021
  const candidates = unicodeDxf && utf8Valid
    ? ['utf-8', declaredEncoding]
    : [declaredEncoding, ...(utf8Valid ? ['utf-8'] : []), 'gb18030', 'windows-1252']
  const encoding = candidates.find((candidate): candidate is string => !!candidate && supportsEncoding(candidate)) || 'utf-8'

  return { text: decode(bytes, encoding), encoding, codePage }
}

/**
 * 检测字节流的 Unicode BOM。
 * @param bytes DXF 原始字节流。
 * @returns BOM 对应的编码；不存在时返回空值。
 * @author snihao
 */
function detectBomEncoding(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be'
  return null
}

/**
 * 根据空字节分布检测无 BOM 的 UTF-16 字节序。
 * @param bytes DXF 原始字节流。
 * @returns 检测到的 UTF-16 编码；无法识别时返回空值。
 * @author snihao
 */
function detectBomlessUtf16(bytes: Uint8Array): string | null {
  const sampleLength = Math.min(bytes.length, 128)
  if (sampleLength < 8) return null
  let evenNulls = 0
  let oddNulls = 0
  for (let index = 0; index < sampleLength; index++) {
    if (bytes[index] !== 0) continue
    if (index % 2 === 0) evenNulls++
    else oddNulls++
  }
  if (oddNulls > sampleLength / 4 && evenNulls < sampleLength / 16) return 'utf-16le'
  if (evenNulls > sampleLength / 4 && oddNulls < sampleLength / 16) return 'utf-16be'
  return null
}

/**
 * 从 DXF HEADER 段读取指定系统变量的值。
 * @param text 已解码的 DXF 文本。
 * @param variable 系统变量名称。
 * @returns 系统变量值；未找到或值为空时返回空值。
 * @author snihao
 */
function headerValue(text: string, variable: string): string | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  for (let index = 0; index + 3 < lines.length; index++) {
    if (lines[index].trim() !== '9' || lines[index + 1].trim().toUpperCase() !== variable) continue
    return lines[index + 3].trim() || null
  }
  return null
}

/**
 * 将 DXF 代码页名称转换为 `TextDecoder` 支持的编码名称。
 * @param codePage DXF 头部声明的代码页。
 * @returns 对应编码；无法识别时返回空值。
 * @author snihao
 */
function resolveCodePageEncoding(codePage: string | null): string | null {
  if (!codePage) return null
  const normalized = codePage.trim().toUpperCase().replace(/\s+/g, '')
  if (DXF_CODE_PAGE_ENCODINGS[normalized]) return DXF_CODE_PAGE_ENCODINGS[normalized]
  const ansi = normalized.match(/^ANSI[_-]?(12\d\d)$/)
  return ansi ? `windows-${ansi[1]}` : null
}

/**
 * 提取 DXF 版本号中的数字部分。
 * @param version `$ACADVER` 系统变量值。
 * @returns DXF 数字版本号；格式无效时返回 0。
 * @author snihao
 */
function dxfVersionNumber(version: string | null): number {
  const match = version?.trim().toUpperCase().match(/^AC(\d{4})$/)
  return match ? Number(match[1]) : 0
}

/**
 * 检查当前运行环境是否支持指定文本编码。
 * @param encoding 文本编码名称。
 * @returns 是否支持该编码。
 * @author snihao
 */
function supportsEncoding(encoding: string): boolean {
  try {
    new TextDecoder(encoding)
    return true
  } catch {
    return false
  }
}

/**
 * 检查字节流能否按指定编码无损解码。
 * @param bytes 待检查的字节流。
 * @param encoding 文本编码名称。
 * @returns 是否可以无损解码。
 * @author snihao
 */
function canDecode(bytes: Uint8Array, encoding: string): boolean {
  try {
    new TextDecoder(encoding, { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * 按指定编码解码字节流，并移除文本开头的 BOM 字符。
 * @param bytes 待解码的字节流。
 * @param encoding 文本编码名称。
 * @returns 解码后的文本。
 * @author snihao
 */
function decode(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    return new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, '')
  }
}
