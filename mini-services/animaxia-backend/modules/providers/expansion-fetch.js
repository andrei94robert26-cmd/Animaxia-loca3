/**
 * Fixed-origin public metadata drivers for music, radio, community news and sports.
 * Media entries are CATALOG METADATA, not playback rights or video links.
 */
export const EXPANSION_DRIVER_IDS = Object.freeze([
  'deezer','radiobrowser','hackernews','openf1','nhl',
]);
const words = (value, max=200) => typeof value==='string' ? value.trim().slice(0,max) : '';
const list = (value) => Array.isArray(value) ? value : [];
const yyyy = (value) => {
  const m=/^((?:18|19|20|21)\d{2})/.exec(String(value||''));
  return m ? Number(m[1]) : undefined;
};
function build(base, query={}) {
  const dest=new URL(base);
  for (const [key,value] of Object.entries(query)) {
    if(value!==undefined&&value!==null&&value!=='') dest.searchParams.set(key,String(value));
  }
  return dest;
}
export function buildExpansionRequest(id,rawQuery,page) {
  const q=words(rawQuery,120);
  const n=Math.max(1,Math.min(10,Number.parseInt(page,10)||1));
  switch(id) {
    case 'deezer':
      if(q.length<2) throw Object.assign(new Error('Deezer search requires >=2 characters'),{status:400});
      return build('https://api.deezer.com/search',{q,limit:25,index:(n-1)*25});
    case 'radiobrowser':
      if(q.length<2) throw Object.assign(new Error('Radio Browser search requires >=2 characters'),{status:400});
      return build('https://de1.api.radio-browser.info/json/stations/search',
        {name:q,limit:25,offset:(n-1)*25,hidebroken:'true',order:'votes',reverse:'true'});
    case 'hackernews':
      if(q.length<2) throw Object.assign(new Error('Hacker News search requires >=2 characters'),{status:400});
      return build('https://hn.algolia.com/api/v1/search',
        {query:q,tags:'story',hitsPerPage:25,page:n-1});
    case 'openf1':
      if(q||n!==1) throw Object.assign(new Error('OpenF1 meetings connector supports current-year browse only'),{status:400});
      return build('https://api.openf1.org/v1/meetings',{year:new Date().getUTCFullYear()});
    case 'nhl':
      if(q||n!==1) throw Object.assign(new Error('NHL schedule connector supports today browse only'),{status:400});
      // Avoid /schedule/now: its server may redirect, which we deliberately disallow.
      return build('https://api-web.nhle.com/v1/schedule/'+new Date().toISOString().slice(0,10));
    default:
      throw Object.assign(new Error('Unknown expansion provider'),{status:501});
  }
}
const nice = (value) => {
  if(typeof value==='string') return words(value,100);
  if(value && typeof value==='object') return words(value.default || value.en,100);
  return '';
};
export function mapExpansionItems(id,json) {
  let items=[];
  switch(id) {
    case 'deezer':
      items=list(json?.data).map((v)=>({
        id:String(v?.id),title:words(v?.title,300),category:'muzica',
        actors:v?.artist?.name?[words(v.artist.name,120)]:[],
        studios:v?.album?.title?[words(v.album.title,120)]:[],
        thumbnail:v?.album?.cover_medium || v?.album?.cover,
        sourceAttribution:'Deezer',sourceUrl:v?.link,
      }));
      break;
    case 'radiobrowser':
      items=list(json).map((v)=>({
        id:String(v?.stationuuid),title:words(v?.name,300),category:'muzica',
        genres:words(v?.tags,180).split(',').map((x)=>x.trim()).filter(Boolean).slice(0,20),
        collection:'Radio stations',description:words(v?.country,200),
        thumbnail:v?.favicon,sourceAttribution:'Radio Browser',sourceUrl:v?.homepage,
      }));
      break;
    case 'hackernews':
      items=list(json?.hits).map((v)=>({
        id:String(v?.objectID),title:words(v?.title||v?.story_title,300),
        category:'stiri',year:yyyy(v?.created_at),
        actors:v?.author?[words(v.author,120)]:[],
        description:'Community-submitted technology news (not independently verified)',
        sourceAttribution:'Hacker News',sourceUrl:v?.url || (v?.objectID
          ? 'https://news.ycombinator.com/item?id='+encodeURIComponent(v.objectID) : undefined),
      }));
      break;
    case 'openf1':
      items=list(json).map((v)=>({
        id:String(v?.meeting_key),title:words(v?.meeting_name,300),
        category:'sport',year:yyyy(v?.date_start || v?.year),
        franchise:'Formula 1',collection:'F1 '+String(v?.year||''),
        studios:v?.circuit_short_name?[words(v.circuit_short_name,120)]:[],
        description:words(v?.location,300),thumbnail:v?.circuit_image,
        sourceAttribution:'OpenF1',
      }));
      break;
    case 'nhl':
      items=list(json?.gameWeek).flatMap((week)=>list(week?.games).map((v)=>{
        const home = nice(v?.homeTeam?.commonName) || nice(v?.homeTeam?.placeName)
          || words(v?.homeTeam?.abbrev,20);
        const away = nice(v?.awayTeam?.commonName) || nice(v?.awayTeam?.placeName)
          || words(v?.awayTeam?.abbrev,20);
        return {
          id:String(v?.id),title:away&&home?away+' vs '+home:'',
          category:'sport',year:yyyy(v?.startTimeUTC || week?.date),
          franchise:'NHL',collection:words(v?.season?String(v.season):'NHL season',80),
          studios:[away,home].filter(Boolean),
          description:'NHL hockey match schedule (not a licensed live stream)',
          sourceAttribution:'NHL',
        };
      }));
      break;
    default:return [];
  }
  return items.filter((x)=>x.title&&x.id&&x.id!=='undefined'&&x.id!=='null').slice(0,25);
}
