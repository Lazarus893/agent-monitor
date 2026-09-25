const {contextBridge}=require('electron');
let stateCb,commandCb,pulseCb;
contextBridge.exposeInMainWorld('monitor',{
 subscribe:cb=>{stateCb=cb;return()=>{}},onCommand:cb=>{commandCb=cb;return()=>{}},onPulse:cb=>{pulseCb=cb;return()=>{}},
 ack:()=>{},setPage:()=>{},rendered:()=>{},openNews:()=>{},
 // 主进程那边：落盘后经 command 推回，这里直接回声
 setMidiSkin:v=>commandCb({type:'midiSkin',value:v})
});
contextBridge.exposeInMainWorld('midiVerify',{
 show:(kind,wide=false)=>{
 const iso=kind==='night'?'2026-09-15T23:32:00+08:00':'2026-09-15T14:32:00+08:00';
 const stamp=kind==='ear'?'2026-09-15T14:32:09.700+08:00':iso;
 const t=Date.parse(stamp),gap=kind==='sleep'?310000:kind==='look'?6000:kind==='night'?1000:null;
 stateCb({scene:'populated',canvas:{width:480,height:270},generatedAt:stamp,loading:false,agents:[],events:[],panelX:1.19,
 typing:{status:kind==='untrusted'?'untrusted':kind==='offline'?'offline':kind==='connecting'?'connecting':'ok',date:'2026-09-15',today:wide?123456:2864,yesterday:3192,streak:12,...(gap===null?{}:{lastInputAt:new Date(t-gap).toISOString()})}});
 commandCb({type:'midiSkin',value:new URLSearchParams(location.search).get('skin')||'siamese'});commandCb({type:'showPage',page:'f',token:1});commandCb({type:'mute',value:true});
 },
 pulse:()=>pulseCb({at:Date.now(),delta:1}),
 command:cmd=>commandCb(cmd)
});

