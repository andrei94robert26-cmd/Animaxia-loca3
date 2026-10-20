import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPgShadowCatalogQuery, readPgShadowCatalog } from '../modules/postgres/shadow-read.js';

test('shadow read uses bound filters and deterministic ID-keyset, never OFFSET',()=>{
  const q=buildPgShadowCatalogQuery({
    q:'Animated Adventure',category:'filme',year:'2026',
    actor:'Jane',genre:'Fantasy',studio:'Example',franchise:'Galaxy',
    trilogy:'A',collection:'Saga',description:'magic',posterId:'img002',
    limit:5,
  });
  assert.ok(q.sql.includes('plainto_tsquery'));
  assert.ok(q.sql.includes('jsonb_array_elements_text'));
  assert.ok(q.sql.includes('ORDER BY id DESC'));
  assert.ok(!q.sql.includes('OFFSET'));
  assert.ok(q.sql.includes('LIMIT $'));
  assert.ok(q.sql.includes("type = $"));
  assert.ok(q.values.includes('movie'));
  assert.ok(q.values.includes(2026));
  assert.ok(q.values.includes('Jane'));
  assert.ok(q.values.includes('Fantasy'));
  assert.ok(q.values.includes(6));
  assert.equal(q.limit,5);
  assert.equal(q.values.some((x)=>typeof x==='string'&&x.includes('DROP TABLE')),false);
  assert.throws(()=>buildPgShadowCatalogQuery({limit:51}),/limit/);
  assert.throws(()=>buildPgShadowCatalogQuery({limit:'-1'}),/limit/);
  assert.throws(()=>buildPgShadowCatalogQuery({year:'20267'}),/year/);
  assert.throws(()=>buildPgShadowCatalogQuery({actor:'x'.repeat(161)}),/too long/);
  assert.throws(()=>buildPgShadowCatalogQuery({q:'test',cursor:'not-a-cursor'}),/cursor/);
});
test('shadow cursor binds the filter signature and pages by ID',()=>{
  const original=buildPgShadowCatalogQuery({q:'Mystery',category:'anime',limit:2});
  const cursor=Buffer.from(JSON.stringify({sig:original.sig,id:99})).toString('base64url');
  const next=buildPgShadowCatalogQuery({q:'Mystery',category:'anime',limit:2,cursor});
  assert.ok(next.sql.includes('id < $'));
  assert.ok(next.values.includes(99));
  assert.throws(()=>buildPgShadowCatalogQuery({q:'Different',category:'anime',cursor}),/cursor/);
  assert.throws(()=>buildPgShadowCatalogQuery({q:'Mystery',category:'filme',cursor}),/cursor/);
  assert.throws(()=>buildPgShadowCatalogQuery({q:'Mystery',cursor:Buffer.from(
    JSON.stringify({sig:original.sig,id:-1})).toString('base64url')}),/cursor/);
});
test('PostgreSQL shadow catalog preview fails closed without configuration',async()=>{
  const original=process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL;
  try{
    delete process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL;
    await assert.rejects(readPgShadowCatalog({q:'movie'}),/not configured/);
  }finally{
    if(original===undefined)delete process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL;
    else process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL=original;
  }
});
test('shadow read emits only metadata whitelist, not player or arbitrary secrets',async()=>{
  const original=process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL;
  try{
    process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL='postgresql://ci:pass@pg.example.invalid/catalog';
    const results=await readPgShadowCatalog({category:'filme',limit:1},{
      db:{query:async(sql,values)=>{
        assert.ok(sql.includes('ORDER BY id DESC'));
        assert.ok(values.includes('movie'));
        return {rows:[
          {id:'12',title:'Test Film',year:2026,type:'movie',externalid:'api:test:12',
            thumbnail:'https://example.org/poster.jpg',
            metadata:{actors:['Alice'],genres:['Action'],rating:7.8,
              player:{sources:[{url:'https://internal.example/secret.mp4'}]},
              secretToken:'should-not-be-displayed'}},
          {id:'10',title:'Earlier Film',year:2020,type:'movie',
            metadata:{description:'Other'}}]};
      }},
    });
    assert.equal(results.shadow,true);
    assert.equal(results.authoritative,false);
    assert.equal(results.data.length,1);
    assert.equal(results.hasMore,true);
    assert.ok(results.nextCursor);
    assert.equal(results.data[0].metadata.rating,7.8);
    assert.ok(!JSON.stringify(results).includes('secret.mp4'));
    assert.ok(!JSON.stringify(results).includes('should-not-be-displayed'));
  }finally{
    if(original===undefined)delete process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL;
    else process.env.ANIMAXIA_PG_SHADOW_DATABASE_URL=original;
  }
});
