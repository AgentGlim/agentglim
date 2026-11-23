import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const app=path.resolve(import.meta.dirname,'..');
const server=fs.readFileSync(path.join(app,'server.mjs'),'utf8');
const html=fs.readFileSync(path.join(app,'index.html'),'utf8');
test('card uses provider snapshot over smaller Pi ledger and renders charts',()=>{
 const now=Date.now(),baseline=new Date(now-86400000);baseline.setSeconds(0,0);const base=baseline.toISOString().slice(0,16).replace('T',' ');const since=Date.parse(base.replace(' ','T'));const records={
  '/run/claude-api-credit.json':JSON.stringify({promoUsd:30,purchasedUsd:0,balanceAt:base}),
  '/run/flags/credit-history.ndjson':JSON.stringify({at:now,balanceAtMs:since,spent:8,total:30,left:22,source:'provider',completeTo:new Date(now-3600000).toISOString(),estimated:true}),
  '/run/flags/usage-history.ndjson':JSON.stringify({at:now,'5h':20,'7d':40}),
  '/run/flags/api-cost-daily.ndjson':JSON.stringify({date:new Date(now).toISOString().slice(0,10),usd:8})};
 const ctx={Date,Math,Number,JSON,RUN:'/run',readText:f=>records[f]||'',keyStatuses:()=>[],sumUsd:()=>1,esc:s=>String(s)};ctx.ndjson=f=>(records[f]||'').split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}});vm.createContext(ctx);
 let start=server.indexOf('function apiKeys() {'),end=server.indexOf('const alive =',start);assert.ok(start>=0&&end>start);vm.runInContext(server.slice(start,end)+';globalThis.actual=apiKeys();',ctx);assert.equal(ctx.actual.claude.spent,8);assert.equal(ctx.actual.claude.left,22);assert.equal(ctx.actual.claude.source,'provider');
 start=html.indexOf('const creditCharts =');end=html.indexOf('function manualReset(',start);assert.ok(start>=0&&end>start);vm.runInContext(html.slice(start,end)+';globalThis.card=apiRow({provider:"anthropic"},actual);',ctx);assert.match(ctx.card,/\$8\.00 spent/);assert.match(ctx.card,/\$22\.00 left/);assert.match(ctx.card,/Provider/);assert.match(ctx.card,/complete to/);assert.match(ctx.card,/est\./);assert.equal((ctx.card.match(/<svg/g)||[]).length,2);
});
test('changed balance baseline does not reuse old snapshot',()=>{const now=Date.now();const credit={promoUsd:20,balanceAt:'2026-01-01 00:00'};const ctx={Date,Math,Number,JSON,RUN:'/run',readText:f=>f.endsWith('claude-api-credit.json')?JSON.stringify(credit):'',keyStatuses:()=>[],sumUsd:()=>2,ndjson:f=>f.includes('credit-history')?[{at:now,balanceAtMs:1,spent:99,left:0,source:'provider'}]:[]};vm.createContext(ctx);let start=server.indexOf('function apiKeys() {'),end=server.indexOf('const alive =',start);vm.runInContext(server.slice(start,end)+';globalThis.actual=apiKeys()',ctx);assert.equal(ctx.actual.claude.source,'pi');assert.equal(ctx.actual.claude.left,18)});
test('garbled history lines and top-ups do not break the snapshot',()=>{const records={'/run/claude-api-credit.json':JSON.stringify({promoUsd:20,balanceAt:'2026-01-01 00:00',topups:[null,{at:'2026-02-01T00:00:00Z',usd:'x'}]}),'/run/flags/credit-history.ndjson':'null\n{"at":1}\n','/run/flags/usage-history.ndjson':'null','/run/flags/api-cost-daily.ndjson':'null\n[]'};const ctx={Date,Math,Number,JSON,Array,RUN:'/run',readText:f=>records[f]||'',keyStatuses:()=>[],sumUsd:()=>2,esc:s=>String(s)};ctx.ndjson=f=>(records[f]||'').split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}});vm.createContext(ctx);const start=server.indexOf('function apiKeys() {'),end=server.indexOf('const alive =',start);vm.runInContext(server.slice(start,end)+';globalThis.actual=apiKeys()',ctx);assert.equal(ctx.actual.claude.source,'pi');assert.equal(ctx.actual.claude.left,18)});
