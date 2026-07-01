/** Nhãn tiêu đề section theo vòng đấu WC 2026 */

export const ROUND_LABELS = {
  group: 'VÒNG ĐẤU BẢNG',
  r32: 'VÒNG 32 ĐỘI',
  r16: 'VÒNG LOẠI 16 ĐỘI',
  qf: 'TỨ KẾT',
  sf: 'BÁN KẾT',
  third: 'TRANH HẠNG 3',
  final: 'CHUNG KẾT',
};

function parseDateParts(dateStr) {
  const [d, m] = String(dateStr || '').split('/').map(Number);
  return { d: d || 0, m: m || 0 };
}

/** So sánh ngày d/m (giả định cùng năm giải) */
function dateKey({ d, m }) {
  return m * 100 + d;
}

function inRange(parts, from, to) {
  const v = dateKey(parts);
  return v >= dateKey(from) && v <= dateKey(to);
}

/**
 * Xác định vòng đấu theo lịch knock-out FIFA World Cup 2026.
 * Vòng bảng: trước 28/6. Knock-out theo khoảng ngày chính thức.
 */
export function inferRound(dateStr) {
  const p = parseDateParts(dateStr);
  if (!p.m) return 'group';

  // Vòng bảng (11–27/6)
  if (p.m < 6 || (p.m === 6 && p.d < 28)) return 'group';

  // Vòng 32 đội (28/6 – 3/7)
  if (inRange(p, { d: 28, m: 6 }, { d: 3, m: 7 })) return 'r32';

  // Vòng loại 16 đội (4/7 – 7/7)
  if (inRange(p, { d: 4, m: 7 }, { d: 7, m: 7 })) return 'r16';

  // Tứ kết (9–11/7; Google có thể hiện 8–10/7)
  if (inRange(p, { d: 8, m: 7 }, { d: 11, m: 7 })) return 'qf';

  // Bán kết (14–15/7)
  if (inRange(p, { d: 14, m: 7 }, { d: 15, m: 7 })) return 'sf';

  // Tranh hạng 3 (18/7)
  if (p.m === 7 && p.d === 18) return 'third';

  // Chung kết (19/7)
  if (p.m === 7 && p.d === 19) return 'final';

  // Fallback: ngày lẻ trên sơ đồ bracket (vd. 12/7) — không gán nhầm Vòng 16
  if (p.m === 6 && p.d >= 28) return 'r32';

  return 'group';
}


export function sectionTitleForRound(round, dateStr) {
  const label = ROUND_LABELS[round] || ROUND_LABELS.group;
  return dateStr ? `${label} - ${dateStr}` : label;
}

export function compareFixturesByKickoff(a, b) {
  const da = parseDateParts(a.date);
  const db = parseDateParts(b.date);
  const diff = dateKey(da) - dateKey(db);
  if (diff !== 0) return diff;
  return String(a.time || '').localeCompare(String(b.time || ''));
}
