import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommunityProviderRequest, mapCommunityProviderItems, COMMUNITY_DRIVER_IDS }
  from '../modules/providers/community-fetch.js';
import { respectProviderRateLimit } from '../modules/providers/fetch.js';
import { DRIVER_IDS } from '../modules/providers/catalog.js';

test('community drivers cover music, sport and gaming without accepting arbitrary URLs', () => {
  assert.equal(DRIVER_IDS.length,22);
  assert.deepEqual(COMMUNITY_DRIVER_IDS,[
    'musicbrainz','pokeapi','openligadb','jolpica','opendota',
  ]);
  const urls=[
    buildCommunityProviderRequest('musicbrainz','Queen',1),
    buildCommunityProviderRequest('pokeapi','',2),
    buildCommunityProviderRequest('openligadb','',3),
    buildCommunityProviderRequest('jolpica','',4),
    buildCommunityProviderRequest('opendota','',1),
  ];
  assert.deepEqual(urls.map((v)=>v.hostname),[
    'musicbrainz.org','pokeapi.co','api.openligadb.de',
    'api.jolpi.ca','api.opendota.com',
  ]);
  assert.ok(urls.every((v)=>v.protocol==='https:'));
  assert.equal(urls[0].searchParams.get('fmt'),'json');
  assert.equal(urls[0].searchParams.get('dismax'),'true');
  assert.equal(urls[1].searchParams.get('offset'),'20');
  assert.match(urls[2].pathname,/\/getmatchdata\/bl1\/\d{4}\/3$/);
  assert.equal(urls[3].searchParams.get('offset'),'75');
  assert.equal(urls[4].pathname,'/api/proMatches');
  assert.throws(()=>buildCommunityProviderRequest('musicbrainz','',1),{status:400});
  assert.throws(()=>buildCommunityProviderRequest('openligadb','arbitrary',1),{status:400});
  assert.throws(()=>buildCommunityProviderRequest('pokeapi','pikachu',1),{status:400});
  assert.throws(()=>buildCommunityProviderRequest('jolpica','2024',1),{status:400});
  assert.throws(()=>buildCommunityProviderRequest('opendota','',2),{status:400});
});
test('community provider mappings retain stable IDs, years and origins', () => {
  const cases={
    musicbrainz:{ recordings:[{ id:'music-recording-123',title:'Test Song',
      'first-release-date':'2025-04-01','artist-credit':[{artist:{name:'Singer'}}] }] },
    pokeapi:{results:[{name:'pikachu',url:'https://pokeapi.co/api/v2/pokemon/25/'}]},
    openligadb:[{matchID:93123,matchDateTime:'2026-10-01T18:30:00',
      team1:{teamName:'Home'},team2:{teamName:'Away'},group:{groupOrderID:9},
      leagueName:'Bundesliga'}],
    jolpica:{MRData:{RaceTable:{Races:[{season:'2026',round:'1',raceName:'Grand Prix',
      date:'2026-03-01',Circuit:{circuitName:'Circuit One',Location:{locality:'City'}}}]}}},
    opendota:[{match_id:9812345,radiant_name:'Team A',dire_name:'Team B',
      start_time:1790000000,league_name:'League CI'}],
  };
  for(const [id,json] of Object.entries(cases)){
    const items=mapCommunityProviderItems(id,json);
    assert.equal(items.length,1,id);
    assert.ok(items[0].id);
    assert.ok(items[0].title);
    assert.ok(['sport','gaming','muzica'].includes(items[0].category));
    assert.ok(items[0].sourceAttribution);
  }
  assert.equal(mapCommunityProviderItems('musicbrainz',cases.musicbrainz)[0].year,2025);
  assert.deepEqual(mapCommunityProviderItems('musicbrainz',cases.musicbrainz)[0].actors,['Singer']);
  assert.equal(mapCommunityProviderItems('pokeapi',cases.pokeapi)[0].id,'25');
  assert.equal(mapCommunityProviderItems('openligadb',cases.openligadb)[0].category,'sport');
  assert.equal(mapCommunityProviderItems('jolpica',cases.jolpica)[0].franchise,'Formula 1');
  assert.equal(mapCommunityProviderItems('opendota',cases.opendota)[0].franchise,'Dota 2');
  assert.deepEqual(mapCommunityProviderItems('musicbrainz',{}),[]);
});
test('MusicBrainz consecutive requests reserve >=1 second slots', async () => {
  const start=Date.now();
  await Promise.all([respectProviderRateLimit('musicbrainz'),
    respectProviderRateLimit('musicbrainz')]);
  assert.ok(Date.now()-start>=1050,'MusicBrainz throttle minimum 1150ms');
  // Other sources are not subjected to MusicBrainz throttle.
  const ordinary=Date.now();
  await respectProviderRateLimit('jolpica');
  assert.ok(Date.now()-ordinary<100);
});
