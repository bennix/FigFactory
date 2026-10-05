const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {FILES}=require('../src/local-weights.cjs'),{LocalEngine}=require('../src/local-ai.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-local-ui-'));app.setPath('userData',root);
fs.mkdirSync(path.join(root,'local-models'));const metadata={};for(const f of FILES){metadata[f.repo]??={sha:'a'.repeat(40),siblings:[]};metadata[f.repo].siblings.push({rfilename:f.file,lfs:{size:100,sha256:'b'.repeat(64)}});}fs.writeFileSync(path.join(root,'local-models/catalog.json'),JSON.stringify(metadata));
let requests=[],textRequests=[];global.fetch=async(url,options)=>{const body=JSON.parse(options.body);assert.ok(url.endsWith('/chat/completions'));textRequests.push(body);return new Response(JSON.stringify({choices:[{message:{content:'Optimized studio portrait prompt'}}]}),{headers:{'content-type':'application/json'}});};
LocalEngine.prototype.generate=async function(args){requests.push(args);return {images:['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==']};};
require('../main.js');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=BrowserWindow.getAllWindows()[0],run=code=>win.webContents.executeJavaScript(code);
 try{
 if(win.webContents.isLoading())await new Promise(r=>win.webContents.once('did-finish-load',r));
 for(let i=0;i<100;i++){if(await run(`document.querySelector('#ai-model').options.length>0`))break;await sleep(100);}
 await run(`document.querySelector('#ai-provider').value='local';document.querySelector('#ai-provider').dispatchEvent(new Event('change'));void 0`);
 for(let i=0;i<100;i++){if(await run(`document.querySelector('#local-dit').options.length>0`))break;await sleep(100);}
 assert.equal(await run(`document.querySelector('#local-dit').value`),'dit-Q4_K_M');
 assert.equal(await run(`document.querySelector('#btn-optimize').disabled`),false);
 await run(`document.querySelector('#ai-prompt').value='Fully clothed person in a cafe';document.querySelector('#ai-use-pose').checked=true;document.querySelector('#btn-generate').click();void 0`);
 for(let i=0;i<100;i++){if(await run(`!document.querySelector('#btn-generate').disabled`))break;await sleep(100);}
 assert.equal(requests.length,1);assert.equal(requests[0].images.length,1);assert.equal(requests[0].dit,'dit-Q4_K_M');
 assert.ok(requests[0].prompt.includes('当前姿态'));assert.equal(await run(`document.querySelector('#studio-history-count').textContent`),'1');
 assert.equal(textRequests.length,0);
 assert.equal((await run(`window.bodyFactory.saveAISettings({apiKey:'fixture-local-text-key'})`)).ok,true);
 await run(`document.querySelector('#ai-prompt').value='A studio portrait';document.querySelector('#btn-optimize').click();void 0`);
 for(let i=0;i<100;i++){if(await run(`!document.querySelector('#btn-optimize').disabled`))break;await sleep(100);}
 assert.equal(textRequests.length,1);assert.equal(requests.length,1);
 assert.equal(await run(`document.querySelector('#ai-final-prompt').value`),'Optimized studio portrait prompt');
 console.log('PASS local images stay local; explicit prompt optimization uses ZenMux while local image provider is selected');
 }catch(e){console.error(e);process.exitCode=1;}finally{win.destroy();fs.rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
