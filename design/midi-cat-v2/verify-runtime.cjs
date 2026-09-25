const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:960,height:540,show:false,webPreferences:{offscreen:true,preload:path.join(__dirname,'verify-preload.cjs'),contextIsolation:true,sandbox:true}});
 const errors=[];win.webContents.on('console-message',(_e,_level,msg)=>{if(/error|failed|refused|uncaught/i.test(msg))errors.push(msg)});
 const dir=path.join(__dirname,'runtime-shots');fs.mkdirSync(dir,{recursive:true});const results=[];
 for(const kind of ['idle','blink','ear','typeL','typeR','look','sleep','night','untrusted','offline','connecting','wide','reduced']){
  await win.loadFile(path.join(root,'out/renderer/index.html'),{query:{debug:'1'}});
  await win.webContents.executeJavaScript(`midiVerify.show('${kind}',${kind==='wide'})`);
  for(let i=0;i<40;i++){if(await win.webContents.executeJavaScript("document.getElementById('pfScene').dataset.artwork==='ready'"))break;await sleep(50)}
  await sleep(400);
  if(kind==='reduced')await win.webContents.executeJavaScript("document.getElementById('chkRm').checked=true;document.getElementById('chkRm').dispatchEvent(new Event('change'));midiVerify.pulse()");
  if(kind==='typeL'||kind==='typeR')await win.webContents.executeJavaScript(`midiVerify.pulse();${kind==='typeR'?'midiVerify.pulse();':''}`);
  if(kind==='reduced'||kind==='typeL'||kind==='typeR')await sleep(80);
  if(kind==='blink'||kind==='ear'){
   for(let i=0;i<160;i++){
    if(await win.webContents.executeJavaScript("document.getElementById('pfScene').dataset.pose==='"+kind+"'"))break;
    await sleep(50);
   }
  }
  const state=await win.webContents.executeJavaScript(`(()=>{const s=document.getElementById('pfScene'),r=document.querySelector('.f-side');document.querySelector('.harness')?.remove();return{page:document.documentElement.dataset.page,artwork:s.dataset.artwork,pose:s.dataset.pose,sideOverflow:r.scrollWidth>r.clientWidth,text:document.getElementById('pfState').textContent}})()`);
  assert.equal(state.page,'f');assert.equal(state.artwork,'ready');assert.equal(state.sideOverflow,false);
  if(['blink','ear','typeL','typeR','look','sleep','night'].includes(kind))assert.equal(state.pose,kind);
  if(['untrusted','offline'].includes(kind))assert.equal(state.pose,'sleep');
  await win.webContents.executeJavaScript("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  results.push({kind,...state});fs.writeFileSync(path.join(dir,kind+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(dir,'checks.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify(results,null,2));win.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});

