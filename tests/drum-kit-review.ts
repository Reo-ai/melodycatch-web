import * as Tone from 'tone';
import {setAcousticDrumKit,triggerDrumHitAcoustic,isAcousticDrumSampleMode} from '../src/audio/drumsAcoustic';
import {getReverbBus} from '../src/audio/mixer';
document.querySelector<HTMLButtonElement>('#render')!.onclick=async()=>{
 const status=document.querySelector('#status')!;
 status.textContent='生成中';
 try {
 const buffer=await Tone.Offline(async()=>{
  setAcousticDrumKit('studio'); await Tone.loaded(); await getReverbBus('room').ready;
  if(!isAcousticDrumSampleMode())throw Error('新音源が未ロード');
  [36,38,37,50,47,45,42,46,49,51].forEach((m,i)=>{
   [.35,.65,.9,.9,.9].forEach((v,j)=>triggerDrumHitAcoustic(m,.2+i*3+j*.4,v));
  });
  for(let i=0;i<32;i++){
   const t=31+i*.3;
   triggerDrumHitAcoustic(42,t,i%2?.55:.75);
   if(i%8===0||i%8===4)triggerDrumHitAcoustic(36,t,.9);
   if(i%8===2||i%8===6)triggerDrumHitAcoustic(38,t,.85);
   if(i%8===7)triggerDrumHitAcoustic(47,t,.7);
  }
 },44,2,44100);
 const a=buffer.getChannelData(0),b=buffer.getChannelData(1);
 let peak=0,sum=0; for(const ch of [a,b])for(const x of ch){if(!Number.isFinite(x))throw Error('invalid PCM');peak=Math.max(peak,Math.abs(x));sum+=x*x;}
 if(peak>=1)throw Error('clipping');
 const bytes=new ArrayBuffer(44+a.length*4),v=new DataView(bytes);
 const str=(o:number,s:string)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
 str(0,'RIFF');v.setUint32(4,bytes.byteLength-8,true);str(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,2,true);v.setUint32(24,44100,true);v.setUint32(28,176400,true);v.setUint16(32,4,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,bytes.byteLength-44,true);
 for(let i=0;i<a.length;i++){v.setInt16(44+i*4,Math.round(a[i]*32767),true);v.setInt16(46+i*4,Math.round(b[i]*32767),true);}
 const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
 document.querySelector<HTMLAudioElement>('#audio')!.src=url;
 const save=document.querySelector<HTMLAnchorElement>('#save')!;save.href=url;save.download='melodycatch-all-drums-v2.wav';
 document.querySelector('#metrics')!.textContent=JSON.stringify({peakDb:20*Math.log10(peak),rmsDb:10*Math.log10(sum/(2*a.length)),seconds:44});
 status.textContent='全パーツと合奏の生成成功・クリップなし';
 }catch(e){status.textContent=String(e);}
};
