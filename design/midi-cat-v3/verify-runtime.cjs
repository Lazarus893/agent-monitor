const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..');const SKIN=process.env.MIDI_SKIN||'siamese';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:960,height:540,show:false,webPreferences:{offscreen:true,preload:path.join(__dirname,'verify-preload.cjs'),contextIsolation:true,sandbox:true}});
 const errors=[];win.webContents.on('console-message',(_e,_level,msg)=>{if(/error|failed|refused|uncaught/i.test(msg))errors.push(msg)});
 const dir=path.join(__dirname,'runtime-shots-'+SKIN);fs.mkdirSync(dir,{recursive:true});const results=[];
 for(const kind of ['idle','blink','ear','typeL','typeR','look','sleep','night','untrusted','offline','connecting','wide','reduced','handover','swap']){
  await win.loadFile(path.join(root,'out/renderer/index.html'),{query:{debug:'1',skin:SKIN}});
  await win.webContents.executeJavaScript(`midiVerify.show('${kind}',${kind==='wide'})`);
  for(let i=0;i<40;i++){if(await win.webContents.executeJavaScript("document.getElementById('pfScene').dataset.artwork==='ready'"))break;await sleep(50)}
  await sleep(400);
  if(kind==='reduced')await win.webContents.executeJavaScript("document.getElementById('chkRm').checked=true;document.getElementById('chkRm').dispatchEvent(new Event('change'));midiVerify.pulse()");
  if(kind==='typeL'||kind==='typeR')await win.webContents.executeJavaScript(`midiVerify.pulse();${kind==='typeR'?'midiVerify.pulse();':''}`);
  if(kind==='reduced'||kind==='typeL'||kind==='typeR')await sleep(80);
  if(kind==='swap'){await win.webContents.executeJavaScript("document.getElementById('pfSwap').click()");await sleep(1500)}
  if(kind==='handover'){await win.webContents.executeJavaScript(`midiVerify.command({type:'midiSkin',value:'${SKIN==='siamese'?'tabby':'siamese'}'})`);await sleep(1500)}
  if(kind==='blink'||kind==='ear'){
   for(let i=0;i<160;i++){
    if(await win.webContents.executeJavaScript("document.getElementById('pfScene').dataset.pose==='"+kind+"'"))break;
    await sleep(50);
   }
  }
  const state=await win.webContents.executeJavaScript(`(()=>{const s=document.getElementById('pfScene'),r=document.querySelector('.f-side');document.querySelector('.harness')?.remove();return{page:document.documentElement.dataset.page,artwork:s.dataset.artwork,pose:s.dataset.pose,sideOverflow:r.scrollWidth>r.clientWidth,text:document.getElementById('pfState').textContent}})()`);
  assert.equal(state.page,'f');assert.equal(state.artwork,'ready');assert.equal(state.sideOverflow,false);
  if(['blink','ear','typeL','typeR','look','sleep','night','handover'].includes(kind))assert.equal(state.pose,kind);
  if(kind==='swap')assert.equal(state.pose,'handover');
  if(kind==='handover'||kind==='swap')assert.match(state.text,/来接班$/);
  if(['untrusted','offline'].includes(kind))assert.equal(state.pose,'sleep');
  await win.webContents.executeJavaScript("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  results.push({kind,...state});fs.writeFileSync(path.join(dir,kind+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(dir,'checks.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results,null,2));win.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});

