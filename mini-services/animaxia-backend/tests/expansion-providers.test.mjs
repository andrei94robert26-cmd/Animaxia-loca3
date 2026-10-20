import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExpansionRequest, mapExpansionItems, EXPANSION_DRIVER_IDS }
  from '../modules/providers/expansion-fetch.js';
import { buildProviderRequest, mapProviderItems } from '../modules/providers/fetch.js';
import { providerSupportsPollQuery } from '../modules/providers/auto-sync.js';
import { DRIVER_IDS } from '../modules/providers/catalog.js';

test('22-driver catalog includes five news/music/sport expansion providers', () => {
  assert.equal(DRIVER_IDS.length,22);
  assert.deepEqual(EXPANSION_DRIVER_IDS,['deezer','radiobrowser','hackernews','openf1','nhl']);
  const urls = EXPANSION_DRIVER_IDS.map((id) =>
    buildExpansionRequest(id,['openf1','nhl'].includes(id)?'':'music',1));
  assert.deepEqual(urls.map((url)=>url.hostname),[
    'api.deezer.com','de1.api.radio-browser.info','hn.algolia.com',
    'api.openf1.org','api-web.nhle.com',
  ]);
  assert.ok(urls.every((url)=>url.protocol==='https:'));
  assert.equal(urls[1].pathname,'/json/stations/search');
  assert.equal(urls[1].searchParams.get('limit'),'25');
  assert.equal(urls[2].searchParams.get('tags'),'story');
  assert.equal(urls[2].searchParams.get('page'),'0');
  assert.equal(urls[3].searchParams.has('year'),true);
  assert.match(urls[4].pathname,/^\/v1\/schedule\/\d{4}-\d\d-\d\d$/);
  for(const id of ['deezer','radiobrowser','hackernews']){
    assert.equal(providerSupportsPollQuery(id,''),false);
    assert.equal(providerSupportsPollQuery(id,'music'),true);
    assert.throws(()=>buildProviderRequest(id,{q:''}),{status:400});
  }
  for(const id of ['openf1','nhl']){
    assert.equal(providerSupportsPollQuery(id,''),true);
    assert.equal(providerSupportsPollQuery(id,'music'),false);
    assert.throws(()=>buildProviderRequest(id,{q:'music'}),{status:400});
    assert.throws(()=>buildProviderRequest(id,{q:'',page:2}),{status:400});
  }
});
test('expansion records are searchable metadata, not inferred playable media', () => {
  const fixtures={
    deezer:{ data:[{id:4400,title:'Example Track',artist:{name:'Singer'},
      album:{title:'Record',cover_medium:'https://cover.example/img.jpg'},
      link:'https://www.deezer.com/track/4400'}] },
    radiobrowser:[{stationuuid:'radio-uuid',name:'Example Station',
      tags:'jazz,rock',country:'Romania',homepage:'https://station.example'}],
    hackernews:{hits:[{objectID:'1199',title:'Example Community Article',
      created_at:'2026-10-20T10:00:00Z',author:'poster',
      url:'https://technology.example/news'}]},
    openf1:[{meeting_key:1001,meeting_name:'Example Grand Prix',
      date_start:'2026-10-18T10:00:00Z',year:2026,
      circuit_short_name:'Test Race Circuit'}],
    nhl:{gameWeek:[{date:'2026-10-20',games:[{
      id:2026020111,season:20262027,startTimeUTC:'2026-10-20T20:00:00Z',
      awayTeam:{commonName:{default:'Away Hockey'}},
      homeTeam:{commonName:{default:'Home Hockey'}},
    }]}]},
  };
  for(const id of EXPANSION_DRIVER_IDS){
    const result=mapExpansionItems(id,fixtures[id]);
    assert.equal(result.length,1,id);
    assert.ok(result[0].title);
    assert.ok(result[0].id);
    assert.equal(result[0].sources,undefined);
    assert.equal(result[0].player,undefined);
    assert.deepEqual(mapProviderItems(id,fixtures[id]),result);
  }
  assert.equal(mapExpansionItems('deezer',fixtures.deezer)[0].actors[0],'Singer');
  assert.deepEqual(mapExpansionItems('radiobrowser',fixtures.radiobrowser)[0].genres,['jazz','rock']);
  assert.equal(mapExpansionItems('hackernews',fixtures.hackernews)[0].category,'stiri');
  assert.equal(mapExpansionItems('openf1',fixtures.openf1)[0].franchise,'Formula 1');
  assert.equal(mapExpansionItems('nhl',fixtures.nhl)[0].category,'sport');
  assert.deepEqual(mapExpansionItems('deezer',{}),[]);
});
