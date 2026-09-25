const {app,BrowserWindow}=require('electron');
const path=require('path'),fs=require('fs');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:600,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
 const checks=[];
 for(const sample of [{name:'size-96-physical',size:'96',mode:'physical',w:806},{name:'size-old-physical',size:'old',mode:'physical',w:806},{name:'size-96-buffer',size:'96',mode:'buffer',w:960}]){
  win.setContentSize(sample.w,540);
  await win.loadFile(path.join(__dirname,'size-preview.html'),{query:{capture:'1',size:sample.size,mode:sample.mode}});
  await win.webContents.executeJavaScript("Promise.all([...document.images].map(i=>i.decode()))");
  checks.push(await win.webContents.executeJavaScript(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{size:window.currentSize,viewport:rect('.viewport'),scene:rect('.f-scene'),cat:rect('.cat'),side:rect('.f-side'),imageLoaded:document.getElementById('cat').naturalWidth>0,sideOverflow:document.querySelector('.f-side').scrollWidth>document.querySelector('.f-side').clientWidth}})()`));
  const im=await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname,sample.name+'.png'),im.toPNG());
 }
 console.log(JSON.stringify(checks,null,2));win.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});

