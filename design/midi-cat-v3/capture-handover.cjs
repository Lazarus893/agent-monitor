// 换班动画的分镜：从暹罗（咖啡）换到虎斑（Midi），每 300ms 拍一张场景区，拼成一条胶片。
const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../..');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:960,height:540,show:false,webPreferences:{offscreen:true,preload:path.join(__dirname,'verify-preload.cjs'),contextIsolation:true,sandbox:true}});
 await win.loadFile(path.join(root,'out/renderer/index.html'),{query:{debug:'1',skin:'siamese'}});
 await win.webContents.executeJavaScript("midiVerify.show('idle')");
 for(let i=0;i<40;i++){if(await win.webContents.executeJavaScript("document.getElementById('pfScene').dataset.artwork==='ready'"))break;await sleep(50)}
 await sleep(300);await win.webContents.executeJavaScript("document.querySelector('.harness')?.remove()");
 await win.webContents.executeJavaScript("midiVerify.command({type:'midiSkin',value:'tabby'})");
 const t0=Date.now();const shots=[];
 for(const at of [150,450,750,1050,1350,1650,1950,2250,2700]){
  while(Date.now()-t0<at)await sleep(10);
  shots.push({at,png:(await win.webContents.capturePage({x:0,y:0,width:1120,height:400})).toPNG()});
 }
 const dir=path.join(__dirname,'handover-frames');fs.mkdirSync(dir,{recursive:true});
 for(const s of shots)fs.writeFileSync(path.join(dir,`t${String(s.at).padStart(4,'0')}.png`),s.png);
 console.log('frames:',shots.map(s=>s.at).join(','));win.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
