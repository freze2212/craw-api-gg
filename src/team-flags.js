import {
  inferRound,
  sectionTitleForRound,
  compareFixturesByKickoff,
} from './tournament-rounds.js';

/** Map tên đội (VI/EN từ Google) → ISO 3166-1 alpha-2 cho flagcdn */
const TEAM_ISO = {
  'nam phi': 'za',
  'south africa': 'za',
  canada: 'ca',
  'hà lan': 'nl',
  'ha lan': 'nl',
  netherlands: 'nl',
  maroc: 'ma',
  'ma rốc': 'ma',
  morocco: 'ma',
  đức: 'de',
  germany: 'de',
  mexico: 'mx',
  brasil: 'br',
  brazil: 'br',
  'nhật bản': 'jp',
  'nhat ban': 'jp',
  japan: 'jp',
  'bờ biển ngà': 'ci',
  'bo bien nga': 'ci',
  'ivory coast': 'ci',
  'côte d\'ivoire': 'ci',
  'hoa kỳ': 'us',
  'hoa ky': 'us',
  'united states': 'us',
  usa: 'us',
  'bosnia và herzegovina': 'ba',
  'bosnia va herzegovina': 'ba',
  'thụy sĩ': 'ch',
  'thuy si': 'ch',
  switzerland: 'ch',
  úc: 'au',
  uc: 'au',
  australia: 'au',
  argentina: 'ar',
  'tây ban nha': 'es',
  'tay ban nha': 'es',
  spain: 'es',
  pháp: 'fr',
  france: 'fr',
  anh: 'gb',
  england: 'gb',
  'bồ đào nha': 'pt',
  portugal: 'pt',
  bỉ: 'be',
  belgium: 'be',
  croatia: 'hr',
  colombia: 'co',
  uruguay: 'uy',
  senegal: 'sn',
  iran: 'ir',
  'hàn quốc': 'kr',
  'han quoc': 'kr',
  'south korea': 'kr',
  ecuador: 'ec',
  áo: 'at',
  austria: 'at',
  'na uy': 'no',
  norway: 'no',
  paraguay: 'py',
  'ai cập': 'eg',
  egypt: 'eg',
  algeria: 'dz',
  scotland: 'gb-sct',
  'costa rica': 'cr',
  serbia: 'rs',
  slovakia: 'sk',
  cameroon: 'cm',
  qatar: 'qa',
  'ả rập xê út': 'sa',
  'saudi arabia': 'sa',
  jordan: 'jo',
  hungary: 'hu',
  ghana: 'gh',
  tunisia: 'tn',
  haiti: 'ht',
  'new zealand': 'nz',
  'ba lan': 'pl',
  poland: 'pl',
  'thụy điển': 'se',
  sweden: 'se',
  'thổ nhĩ kỳ': 'tr',
  turkey: 'tr',
  'cộng hòa séc': 'cz',
  'cong hoa sec': 'cz',
  séc: 'cz',
  sec: 'cz',
  'czech republic': 'cz',
  congo: 'cd',
  iraq: 'iq',
  panama: 'pa',
  'trinidad và tobago': 'tt',
  uzbekistan: 'uz',
  'cabo verde': 'cv',
  'cape verde': 'cv',
  algérie: 'dz',
  algerie: 'dz',
  'chdc congo': 'cd',
  'congo dr': 'cd',
  'democratic republic of the congo': 'cd',
  sénégal: 'sn',
  'chưa xác định': '',
  tbd: '',
};

function normName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const GROUPS = 'ABCDEFGHIJKL'.split('');

export const TBD_LABEL = 'Chưa xác định';

/** Lookup đã chuẩn hóa (bỏ dấu) — tránh miss Pháp→phap vs key pháp */
const TEAM_ISO_NORM = {};
for (const [key, iso] of Object.entries(TEAM_ISO)) {
  if (iso) TEAM_ISO_NORM[normName(key)] = iso;
}

/** Cờ placeholder giống widget Google (sọc xám) — fallback nếu scrape không lấy được URL */
export const TBD_FLAG_FALLBACK =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="56" viewBox="0 0 80 56">' +
      '<rect width="80" height="56" rx="3" fill="#e8eaed"/>' +
      '<rect y="16" width="80" height="12" fill="#bdc1c6"/>' +
      '<rect y="36" width="80" height="8" fill="#bdc1c6"/>' +
      '</svg>',
  );

export function isTbdTeam(teamName) {
  const n = normName(teamName);
  return !n || n === 'tbd' || n.includes('chua xac dinh') || n.includes('to be determined');
}

export function displayTeamName(teamName) {
  return isTbdTeam(teamName) ? TBD_LABEL : String(teamName || '').trim();
}

export function resolveTeamIso(teamName) {
  if (isTbdTeam(teamName)) return '';
  const n = normName(teamName);
  if (TEAM_ISO_NORM[n]) return TEAM_ISO_NORM[n];
  for (const [key, iso] of Object.entries(TEAM_ISO_NORM)) {
    if (key.length >= 3 && (n.includes(key) || key.includes(n))) return iso;
  }
  return '';
}

export function flagUrlForTeam(teamName, tbdFlagUrl) {
  if (isTbdTeam(teamName)) return tbdFlagUrl || TBD_FLAG_FALLBACK;
  const iso = resolveTeamIso(teamName);
  if (!iso) return TBD_FLAG_FALLBACK;
  if (iso === 'gb-sct') return 'https://flagcdn.com/w80/gb-sct.png';
  return `https://flagcdn.com/w80/${iso}.png`;
}

export function enrichFixture(fx, index, options = {}) {
  const tbdFlag = options.tbdFlagUrl || TBD_FLAG_FALLBACK;
  const round = options.round || inferRound(fx.date);
  const groupLetter = GROUPS[index % GROUPS.length];
  const [d, m] = String(fx.date || '').split('/');
  const dateDisplay = d && m ? `${d.padStart(2, '0')}/${m.padStart(2, '0')}` : fx.date || '';
  return {
    ...fx,
    home: displayTeamName(fx.home),
    away: displayTeamName(fx.away),
    round,
    group: `Bảng ${groupLetter}`,
    homeFlag: flagUrlForTeam(fx.home, tbdFlag),
    awayFlag: flagUrlForTeam(fx.away, tbdFlag),
    dateDisplay,
    timeDisplay: fx.time || '',
    sectionTitle: sectionTitleForRound(round, fx.date || ''),
  };
}

export function groupFixturesByDate(fixtures, options = {}) {
  const sorted = [...fixtures].sort(compareFixturesByKickoff);
  const map = new Map();
  sorted.forEach((f, i) => {
    const enriched = enrichFixture(f, i, options);
    const key = enriched.date || 'khác';
    if (!map.has(key)) {
      map.set(key, {
        date: key,
        round: enriched.round,
        title: enriched.sectionTitle,
        matches: [],
      });
    }
    const day = map.get(key);
    day.matches.push(enriched);
  });
  return [...map.values()].sort((a, b) => {
    const pa = a.date.split('/').map(Number);
    const pb = b.date.split('/').map(Number);
    return (pa[1] || 0) - (pb[1] || 0) || (pa[0] || 0) - (pb[0] || 0);
  });
}
