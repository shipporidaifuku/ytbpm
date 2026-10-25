const test = require('node:test');
const assert = require('node:assert');
const { parseTitle, parseTitleCandidates, lookupBpm } = require('../src/lookup.js');

const cases = [
  ['Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers', 'DaftPunkVEVO', 'Daft Punk', 'Get Lucky'],
  ['YOASOBI「夜に駆ける」 Official Music Video', 'Ayase / YOASOBI', 'YOASOBI', '夜に駆ける'],
  ['【MV】米津玄師『Lemon』', '米津玄師', '米津玄師', 'Lemon'],
  ['Shape of You', 'Ed Sheeran - Topic', 'Ed Sheeran', 'Shape of You'],
  ['Mr.Children「HANABI」 MUSIC VIDEO', 'Mr.Children', 'Mr.Children', 'HANABI'],
  ['The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO', 'The Weeknd', 'Blinding Lights'],
  ['Official髭男dism - Pretender［Official Video］', 'Official髭男dism', 'Official髭男dism', 'Pretender'],
  ['Queen – Bohemian Rhapsody (Official Video Remastered)', 'Queen Official', 'Queen', 'Bohemian Rhapsody'],
];

test('「曲名 - アーティスト」の順でも、チャンネル名を手がかりに曲名を先に試す', () => {
  const [first] = parseTitleCandidates('ワールズエンド・ダンスホール - wowaka (Cover) / KMNZ TINA', 'KMNZ');
  assert.deepStrictEqual(first, { artist: 'wowaka', track: 'ワールズエンド・ダンスホール' });
});

test('順番が分からないときは両方の順で試す', () => {
  const candidates = parseTitleCandidates('ワールズエンド・ダンスホール - wowaka', '');
  assert.ok(candidates.some((c) => c.artist === 'wowaka' && c.track === 'ワールズエンド・ダンスホール'));
});

test('曲名が違う検索結果は採用しない', async () => {
  const fake = async (url) => ({
    ok: true,
    json: async () =>
      url.includes('/search')
        ? { data: [{ id: 1, title: 'The Adultress' }] }
        : { id: 1, title: 'The Adultress', bpm: 133.8 },
  });
  assert.deepStrictEqual(await lookupBpm({ artist: 'Official髭男dism', track: 'Pretender' }, fake), { found: false });
});

for (const [title, channel, artist, track] of cases) {
  test(`タイトル解析: ${title}`, () => {
    assert.deepStrictEqual(parseTitle(title, channel), { artist, track });
  });
}

test('通信に失敗したときは例外になる', async () => {
  const failing = async () => ({ ok: false, status: 500 });
  await assert.rejects(lookupBpm({ artist: 'a', track: 'b' }, failing));
});

test('BPM が 0 の曲しか無ければ found: false', async () => {
  const fake = async (url) => ({
    ok: true,
    json: async () => (url.includes('/search') ? { data: [{ id: 1, title: 'b' }] } : { id: 1, title: 'b', bpm: 0 }),
  });
  assert.deepStrictEqual(await lookupBpm({ artist: 'a', track: 'b' }, fake), { found: false });
});

test('Deezer で実際に BPM が取れる', { skip: process.env.ONLINE === '0' }, async () => {
  const result = await lookupBpm(parseTitle('Daft Punk - Get Lucky (Official Audio)', ''), fetch);
  assert.ok(result.found, JSON.stringify(result));
  assert.ok(Math.abs(result.bpm - 116) < 2, `bpm=${result.bpm}`);
});
