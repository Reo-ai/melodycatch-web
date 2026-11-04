import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Scheduling/control-flow tests only: mocks do not validate acoustic quality or PCM.
function engine(file) {
  const nodes = [], events = [], cache = new Map();
  class Node {
    constructor(options) { this.options = options; this.volume = {value: 0}; this.envelope = {}; this.loaded = true; nodes.push(this); }
    connect(target) { this.target = target; return this; }
    chain(...targets) { this.targets = targets; return this; }
    dispose() {}
    stop(time) { events.push({node:this, op:'stop', args:[time]}); }
    start(...args) { events.push({node:this, op:'start', args}); }
    triggerAttackRelease(...args) { events.push({node:this, op:'hit', args}); }
    triggerRelease(...args) { events.push({node:this, op:'release', args}); }
    has() { return true; }
    get() { return {loaded:true}; }
  }
  const Tone = new Proxy({now:()=>0, gainToDb:v=>20*Math.log10(v), dbToGain:v=>10**(v/20), Frequency:()=>({toNote:()=> 'C4'})}, {get:(o,k)=>o[k] ?? Node});
  const mixer = {getMixerInput:()=>({id:'mixer'}),getReverbInput:()=>({id:'post-fader-room'})};
  function load(name) {
    if (name==='tone') return Tone;
    if (name==='./mixer') return mixer;
    if (cache.has(name)) return cache.get(name);
    const output = ts.transpileModule(readFileSync(new URL(`../src/audio/${name.replace('./','').replace(/\.ts$/,'')}.ts`,import.meta.url),'utf8').replaceAll('import.meta.env.BASE_URL',JSON.stringify('/')), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};cache.set(name,exports);
    new Function('require','exports',output)(load,exports);
    return exports;
  }
  return {api:load(file),nodes,events};
}

test('failed legacy kit can retry while healthy or pending kit avoids duplicate loads',()=>{
  const {api,nodes}=engine('./drumsAcoustic');
  api.setAcousticDrumKit('kit1');
  const count=nodes.length;
  api.setAcousticDrumKit('kit1');assert.equal(nodes.length,count);
  const old=nodes.filter(n=>n.options?.url);
  old[0].options.onerror();
  api.setAcousticDrumKit('kit1');assert.ok(nodes.length>count);
  const retryCount=nodes.length;
  old[0].options.onerror();
  api.setAcousticDrumKit('kit1');assert.equal(nodes.length,retryCount);
});
test('failed Studio kit can retry and stale failures cannot poison new load',()=>{
  const {api,nodes}=engine('./drumsAcoustic');
  api.setAcousticDrumKit('studioV2');
  const old=nodes.find(n=>n.options?.urls);
  const count=nodes.length;
  api.setAcousticDrumKit('studioV2');assert.equal(nodes.length,count);
  old.options.onerror('expected test failure');
  api.setAcousticDrumKit('studioV2');assert.ok(nodes.length>count);
  const retryCount=nodes.length;
  old.options.onerror('stale failure');
  api.setAcousticDrumKit('studioV2');assert.equal(nodes.length,retryCount);
  nodes.filter(n=>n.options?.urls).at(-1).options.onload();
  assert.equal(api.isAcousticDrumSampleMode(),true);
});
test('electronic invalid velocities do not initialize or fire; simultaneous different parts share time',()=>{
  const {api,nodes,events}=engine('./drums');
  for(const v of [0,-1,NaN,Infinity])api.triggerDrumHit(36,1,v);
  assert.equal(nodes.length,0);
  for(const midi of [36,38,42])api.triggerDrumHit(midi,1,2);
  const hits=events.filter(e=>e.op==='hit');
  assert.equal(hits.length,6);
  for(const e of hits){assert.equal(e.args.at(-2),1);assert.ok(e.args.at(-1)<=1);}
});
test('electronic closed hat releases both open-hat components at the scheduled time',()=>{
  const {api,events}=engine('./drums');
  api.triggerDrumHit(46,1,.8);const open=events.filter(e=>e.op==='hit').map(e=>e.node);
  api.triggerDrumHit(42,1.2,.8);
  assert.deepEqual(events.filter(e=>e.op==='release').map(e=>e.node),open);
  assert.ok(events.filter(e=>e.op==='release').every(e=>e.args[0]===1.2));
});
test('all 11 electronic parts schedule hits; output compressor routes through mixer',()=>{
  const {api,nodes,events}=engine('./drums');
  for(const midi of api.DRUM_MIDIS){
    const before=events.filter(e=>e.op==='hit').length;
    api.triggerDrumHit(midi,1,.8);
    assert.ok(events.filter(e=>e.op==='hit').length>before,`MIDI ${midi}`);
  }
  assert.ok(nodes.some(n=>n.options?.threshold===-18&&n.target?.id==='mixer'));
});
test('stale legacy loading callbacks cannot enable samples after switching to Studio',()=>{
  const {api,nodes}=engine('./drumsAcoustic');
  api.setAcousticDrumKit('kit1');
  const stale=nodes.filter(n=>n.options?.url);
  api.setAcousticDrumKit('studioV2');
  stale.forEach(n=>n.options.onload());
  assert.equal(api.isAcousticDrumSampleMode(),false);
  nodes.find(n=>n.options?.urls).options.onload();
  assert.equal(api.isAcousticDrumSampleMode(),true);
});
test('old legacy kit errors cannot disable newly loaded kit notes',()=>{
  const {api,nodes,events}=engine('./drumsAcoustic');
  api.setAcousticDrumKit('kit1');const old=nodes.filter(n=>n.options?.url);
  api.setAcousticDrumKit('kit2');const current=nodes.filter(n=>n.options?.url&&!old.includes(n));
  current.forEach(n=>n.options.onload());old.forEach(n=>n.options.onerror());
  api.triggerDrumHitAcoustic(36,1,.8);
  assert.ok(events.some(e=>e.op==='start'&&current.includes(e.node)));
});
test('Studio closed hat stops open sample source and kit generations cannot reactivate old kit',()=>{
  const {api,nodes,events}=engine('./drumsAcoustic');
  api.setAcousticDrumKit('studio');const original=nodes.find(n=>n.options?.urls);
  api.setAcousticDrumKit('studioV2');const current=nodes.filter(n=>n.options?.urls).at(-1);
  original.options.onload();assert.equal(api.isAcousticDrumSampleMode(),false);
  current.options.onload();api.triggerDrumHitAcoustic(46,1,.8);api.triggerDrumHitAcoustic(42,1.2,.8);
  assert.ok(events.some(e=>e.op==='stop'&&e.args[0]===1.2));
});
