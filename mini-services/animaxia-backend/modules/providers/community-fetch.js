/**
 * Five documented public metadata APIs for music, game universes, football,
 * Formula 1 and Dota esports. Fixed origins, no arbitrary URL forwarding.
 */
export const COMMUNITY_DRIVER_IDS = Object.freeze([
  'musicbrainz', 'pokeapi', 'openligadb', 'jolpica', 'opendota',
]);
const text = (v, n=240) => typeof v === 'string' ? v.trim().slice(0,n) : '';
const arr = (v) => Array.isArray(v) ? v : [];
const year = (raw) => {
  const match = /^(18|19|20|21)\d\d/.exec(String(raw || ''));
  return match ? Number(match[0]) : undefined;
};
const season = () => {
  const now = new Date();
  return now.getUTCFullYear() - (now.getUTCMonth() < 6 ? 1 : 0);
};
const endpoint = (path, query={}) => {
  const u = new URL(path);
  for (const [k,v] of Object.entries(query)) if (v !== undefined && v !== null) {
    u.searchParams.set(k, String(v));
  }
  return u;
};
export function buildCommunityProviderRequest(id, rawQuery, page) {
  const q = text(rawQuery,120);
  const n = Math.max(1,Math.min(10,Number.parseInt(page,10)||1));
  switch(id) {
    case 'musicbrainz':
      if(q.length<2) throw Object.assign(new Error('MusicBrainz requires a search term (2+)'),{status:400});
      return endpoint('https://musicbrainz.org/ws/2/recording/',{
        query:q,fmt:'json',dismax:'true',limit:25,offset:(n-1)*25,
      });
    case 'pokeapi':
      if(q) throw Object.assign(new Error('PokéAPI resource listing does not support search query'),{status:400});
      return endpoint('https://pokeapi.co/api/v2/pokemon/',{limit:20,offset:(n-1)*20});
    case 'openligadb':
      if(q) throw Object.assign(new Error('OpenLigaDB driver supports matchday browsing only'),{status:400});
      // Fixed league, bounded round and current season: no user-controlled URL.
      return endpoint('https://api.openligadb.de/getmatchdata/bl1/'+season()+'/'+n);
    case 'jolpica':
      if(q) throw Object.assign(new Error('Jolpica driver supports season browsing only'),{status:400});
      return endpoint('https://api.jolpi.ca/ergast/f1/'+new Date().getUTCFullYear()+'.json',{
        limit:25,offset:(n-1)*25,
      });
    case 'opendota':
      if(q || n!==1) throw Object.assign(new Error('OpenDota proMatches uses non-paginated browsing'),{status:400});
      return endpoint('https://api.opendota.com/api/proMatches');
    default:
      throw Object.assign(new Error('Unknown community provider'),{status:501});
  }
}
function unixYear(seconds) {
  const n=Number(seconds);
  if(!Number.isFinite(n)||n<1_000_000_000||n>5_000_000_000) return undefined;
  return new Date(n*1000).getUTCFullYear();
}
export function mapCommunityProviderItems(id,json) {
  let results=[];
  switch(id) {
    case 'musicbrainz':
      results=arr(json?.recordings).map((v)=>({
        id:String(v?.id),title:text(v?.title),category:'muzica',
        year:year(v?.['first-release-date']),
        actors:arr(v?.['artist-credit']).filter((x)=>x?.artist?.name).map((x)=>text(x.artist.name,120)).slice(0,12),
        sourceAttribution:'MusicBrainz',
      }));
      break;
    case 'pokeapi':
      results=arr(json?.results).map((v)=>{
        const match=String(v?.url||'').match(/\/pokemon\/(\d+)\/?$/);
        const name=text(v?.name,90);
        return {
          id:match?.[1] || name,
          title:name ? name[0].toUpperCase()+name.slice(1)+' (Pokémon)' : '',
          category:'gaming', franchise:'Pokémon',sourceAttribution:'PokéAPI',
        };
      });
      break;
    case 'openligadb':
      results=arr(json).map((v)=>({
        id:String(v?.matchID),title:text(v?.team1?.teamName)+' vs '+text(v?.team2?.teamName),
        category:'sport', year:year(v?.matchDateTime),
        franchise:'Bundesliga',collection:text(v?.leagueName,120),
        studios:arr([v?.team1?.teamName,v?.team2?.teamName]).filter(Boolean).slice(0,2),
        description:'Matchday '+String(v?.group?.groupOrderID||''),
        sourceAttribution:'OpenLigaDB',
      }));
      break;
    case 'jolpica':
      results=arr(json?.MRData?.RaceTable?.Races).map((v)=>({
        id:String(v?.season)+'-'+String(v?.round),
        title:text(v?.raceName,200),category:'sport',year:year(v?.date),
        franchise:'Formula 1',collection:'F1 '+String(v?.season),
        studios:v?.Circuit?.circuitName?[text(v.Circuit.circuitName,120)]:[],
        description:text(v?.Circuit?.Location?.locality||'',200),
        sourceAttribution:'Jolpica F1',
      }));
      break;
    case 'opendota':
      results=arr(json).map((v)=>({
        id:String(v?.match_id),
        title:text(v?.radiant_name||'Radiant',100)+' vs '+text(v?.dire_name||'Dire',100),
        category:'gaming',year:unixYear(v?.start_time),
        franchise:'Dota 2',collection:text(v?.league_name||'',180),
        studios:arr([v?.radiant_name,v?.dire_name]).filter(Boolean).slice(0,2),
        description:'Professional Dota 2 match metadata',
        sourceAttribution:'OpenDota',
      }));
      break;
    default:return [];
  }
  return results.filter((x)=>x.id && x.id!=='undefined' && x.id!=='null' && x.title &&
    !x.title.startsWith(' vs ') && !x.title.endsWith(' vs ')).slice(0,25);
}
