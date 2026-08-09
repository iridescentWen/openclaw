// Gateway Protocol QR schemas share the established PNG data-URL contract.
import { Type } from "typebox";

export const QR_PNG_DATA_URL_MAX_LENGTH = 16_384;
export const QR_PNG_DATA_URL_PREFIX = "data:image/png;base64,";

// The first ten characters plus `o-r` encode the eight-byte PNG signature. If
// the payload ends there, only `o=` has canonical zero pad bits. Longer values
// complete that quartet before using the canonical padded Base64 tail grammar.
const QR_PNG_BASE64_SIGNATURE_PATTERN = "iVBORw0KGg";
const QR_PNG_BASE64_CANONICAL_TAIL_PATTERN =
  "(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?";
const QR_PNG_DATA_URL_PATTERN = `^${QR_PNG_DATA_URL_PREFIX}${QR_PNG_BASE64_SIGNATURE_PATTERN}(?:o=|[o-r][A-Za-z0-9+/]${QR_PNG_BASE64_CANONICAL_TAIL_PATTERN})$`;

export const QrPngDataUrlSchema = Type.String({
  maxLength: QR_PNG_DATA_URL_MAX_LENGTH,
  pattern: QR_PNG_DATA_URL_PATTERN,
});
