/**
 * Chia ngữ liệu giáo án gốc (đã thay công thức/hình vẽ bằng placeholder) thành
 * nhiều PHẦN nhỏ hơn, để gửi từng phần một cho /api/generate — mỗi lần gọi là
 * MỘT lượt Vercel serverless invocation MỚI, có nguyên vẹn ~60s ngân sách thời
 * gian riêng, thay vì dồn hết một giáo án dài vào một lượt gọi duy nhất rồi bị
 * timeout (xem api/generate.ts).
 *
 * Nguyên tắc chia: KHÔNG BAO GIỜ cắt ngang một dòng, một bảng Markdown (các
 * dòng liên tiếp bắt đầu bằng "|"), hay một đoạn văn — chỉ được cắt tại ranh
 * giới dòng trống giữa hai đoạn. Nếu một khối (ví dụ một bảng rất dài) tự nó
 * đã vượt quá kích thước mục tiêu, giữ nguyên khối đó làm một phần riêng (chấp
 * nhận phần đó lớn hơn mục tiêu) thay vì cắt ngang làm hỏng cấu trúc.
 */

/** Nhóm các dòng thành từng "khối" — một khối là một bảng Markdown liên tục,
 * hoặc một đoạn văn liên tục (không có dòng trống ở giữa). */
function splitIntoBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let currentIsTable = false;

  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
  };

  for (const line of lines) {
    const isTableLine = /^\s*\|/.test(line);
    const isBlank = line.trim() === '';

    if (isBlank) {
      flush();
      currentIsTable = false;
      continue;
    }

    if (current.length === 0) {
      currentIsTable = isTableLine;
      current.push(line);
      continue;
    }

    // Ranh giới bảng Markdown <-> văn bản thường, theo CẢ HAI CHIỀU, luôn là
    // điểm cắt an toàn — cắt ở đây không bao giờ làm hỏng một bảng (mọi dòng
    // thuộc cùng một bảng luôn liền kề nhau). Bug đã sửa: bản trước chỉ coi
    // chiều "đang trong bảng -> ra khỏi bảng" là ranh giới, bỏ sót chiều "đang
    // trong đoạn văn -> vào bảng" — khiến một đoạn văn/tiêu đề đứng NGAY TRƯỚC
    // một bảng lớn (rất phổ biến trong giáo án Việt Nam, không có dòng trống
    // ngăn cách) bị dính liền vào bảng thành MỘT khối khổng lồ không cắt được,
    // có khi gộp gần như CẢ giáo án thành 1 khối duy nhất -> chia nhỏ vô tác dụng.
    if (isTableLine !== currentIsTable) {
      flush();
      currentIsTable = isTableLine;
      current.push(line);
      continue;
    }

    current.push(line);
  }
  flush();

  return blocks;
}

/**
 * Chia `sourceText` thành các phần có độ dài khoảng `targetChars` ký tự mỗi
 * phần, không cắt ngang khối (xem splitIntoBlocks). Trả về mảng CHUỖI, mỗi
 * phần tử là ngữ liệu của một phần, ghép lại đúng thứ tự sẽ ra `sourceText`
 * ban đầu (các khối được nối lại bằng "\n\n").
 */
export function chunkSourceText(sourceText: string, targetChars = 8000): string[] {
  const blocks = splitIntoBlocks(sourceText);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const block of blocks) {
    const blockLen = block.length + 2; // +2 cho "\n\n" nối giữa các khối
    if (current.length > 0 && currentLen + blockLen > targetChars) {
      chunks.push(current.join('\n\n'));
      current = [];
      currentLen = 0;
    }
    current.push(block);
    currentLen += blockLen;
  }
  if (current.length > 0) chunks.push(current.join('\n\n'));

  return chunks;
}
