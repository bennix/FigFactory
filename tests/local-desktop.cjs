const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {FILES}=require('../src/local-weights.cjs'),{LocalEngine}=require('../src/local-ai.cjs');
const {PNG}=require('pngjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ff-local-ui-'));app.setPath('userData',root);
fs.mkdirSync(path.join(root,'local-models'));const metadata={};for(const f of FILES){metadata[f.repo]??={sha:'a'.repeat(40),siblings:[]};metadata[f.repo].siblings.push({rfilename:f.file,lfs:{size:100,sha256:'b'.repeat(64)}});}fs.writeFileSync(path.join(root,'local-models/catalog.json'),JSON.stringify(metadata));
let requests=[],textRequests=[],failText=false;global.fetch=async(url,options)=>{const body=JSON.parse(options.body);assert.ok(url.endsWith('/chat/completions'));textRequests.push(body);if(failText)return new Response(JSON.stringify({error:{message:'fixture optimizer unavailable'}}),{status:503,headers:{'content-type':'application/json'}});return new Response(JSON.stringify({choices:[{message:{content:'Optimized studio portrait prompt'}}]}),{headers:{'content-type':'application/json'}});};
let results=[],failImageAt=0;
LocalEngine.prototype.generate=async function(args){requests.push(args);if(requests.length===failImageAt)throw new Error('fixture stage failed');const png=new PNG({width:2,height:2});png.data.fill(requests.length*13%255);for(let i=3;i<png.data.length;i+=4)png.data[i]=255;const url='data:image/png;base64,'+PNG.sync.write(png).toString('base64');results.push(url);return {images:[url]};};
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
 await run(`window.__bf.setFigureCount(1);window.__bf.poseReferenceAudit=[];const originalPoseRender=window.__bf.art.renderImage.bind(window.__bf.art);window.__bf.art.renderImage=(camera,options)=>{window.__bf.poseReferenceAudit.push({onlyFigure:options.onlyFigure,figures:window.__bf.figures});return originalPoseRender(camera,options);};void 0`);
 await run(`document.querySelector('#ai-prompt').value='Fully clothed person in a cafe';document.querySelector('#ai-use-pose').checked=true;document.querySelector('#btn-generate').click();void 0`);
 for(let i=0;i<100;i++){if(await run(`!document.querySelector('#btn-generate').disabled`))break;await sleep(100);}
 assert.equal(requests.length,1);assert.equal(requests[0].images.length,1);assert.equal(requests[0].dit,'dit-Q4_K_M');
 assert.ok(requests[0].prompt.includes('当前姿态'));assert.equal(await run(`document.querySelector('#studio-history-count').textContent`),'1');
 const poseAudit=await run(`window.__bf.poseReferenceAudit.filter(entry=>entry.onlyFigure).map(entry=>entry.figures.length)`);assert.deepEqual(poseAudit,[1]);
 assert.ok(requests[0].prompt.includes('单一自然姿势')&&requests[0].prompt.includes('左右上臂、前臂、肘部')&&requests[0].prompt.includes('不得输出三视图'));
 assert.equal(textRequests.length,0);
 assert.equal((await run(`window.bodyFactory.saveAISettings({apiKey:'fixture-local-text-key'})`)).ok,true);
 await run(`document.querySelector('#ai-prompt').value='A studio portrait';document.querySelector('#btn-optimize').click();void 0`);
 for(let i=0;i<100;i++){if(await run(`!document.querySelector('#btn-optimize').disabled`))break;await sleep(100);}
 assert.equal(textRequests.length,1);assert.equal(requests.length,1);
 assert.equal(await run(`document.querySelector('#ai-final-prompt').value`),'Optimized studio portrait prompt');
 assert.equal(await run(`document.querySelector('#final-prompt-section').hidden`),false);
 assert.ok((await run(`document.querySelector('#prompt-optimization-status').textContent`)).includes('优化完成'));
 await run(`document.querySelector('#btn-generate').click();void 0`);
 for(let i=0;i<100;i++){if(await run(`!document.querySelector('#btn-generate').disabled`))break;await sleep(100);}
 assert.equal(requests.length,2);assert.ok(requests[1].prompt.includes('Optimized studio portrait prompt'));assert.equal(textRequests.length,1);
 failText=true;
 await run(`document.querySelector('#btn-optimize').click();void 0`);
 for(let i=0;i<100;i++){if(await run(`!document.querySelector('#btn-optimize').disabled`))break;await sleep(100);}
 assert.equal(await run(`document.querySelector('#ai-final-prompt').value`),'Optimized studio portrait prompt');
 assert.ok((await run(`document.querySelector('#prompt-optimization-status').textContent`)).includes('优化失败'));
 const addReference=async(kind,color)=>{
  await run(`document.querySelector('#ref-kind').value=${JSON.stringify(kind)};document.querySelector('#ref-kind').dispatchEvent(new Event('change'));{const canvas=document.createElement('canvas');canvas.width=canvas.height=2;const context=canvas.getContext('2d');context.fillStyle=${JSON.stringify(color)};context.fillRect(0,0,2,2);const data=Uint8Array.from(atob(canvas.toDataURL().split(',')[1]),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([data],${JSON.stringify(kind+'.png')},{type:'image/png'}));document.querySelector('#ref-file').files=transfer.files;document.querySelector('#ref-file').dispatchEvent(new Event('change'));}void 0`);
  for(let i=0;i<100;i++){if(await run(`document.querySelectorAll('.ref-kind-select').length===${kind==='face'?1:kind==='clothing'?2:3}`))break;await sleep(50);}
 };
 await addReference('face','red');await addReference('clothing','blue');await addReference('scene','green');
 await run(`document.querySelector('#btn-generate').click();void 0`);
 for(let i=0;i<100;i++){if(await run(`!document.querySelector('#btn-generate').disabled`))break;await sleep(100);}
 assert.equal(requests.length,6);
 assert.equal(requests[2].images.length,1);assert.ok(requests[2].prompt.includes('生成形体'));
 for(let i=3;i<6;i++){assert.equal(requests[i].images.length,2);assert.equal(requests[i].images[0],results[i-1]);}
 assert.ok(requests[3].prompt.includes('换衣服'));assert.ok(requests[4].prompt.includes('换场景'));assert.ok(requests[5].prompt.includes('换脸'));
 assert.notEqual(requests[3].images[1],requests[4].images[1]);assert.notEqual(requests[4].images[1],requests[5].images[1]);
 assert.ok((await run(`document.querySelector('#studio-image-meta').textContent`)).includes('换脸'));
 assert.equal(await run(`document.querySelectorAll('#local-stage-progress li').length`),4);
 // Skip disabled stages, then stop on failure and retain the completed base.
 await run(`document.querySelector('#local-use-clothing').checked=false;document.querySelector('#ai-use-scene').checked=false;void 0`);
 failImageAt=8;
 await run(`document.querySelector('#btn-generate').click();void 0`);
 for(let i=0;i<100;i++){if(await run(`!document.querySelector('#btn-generate').disabled`))break;await sleep(100);}
 assert.equal(requests.length,8);assert.ok(requests[7].prompt.includes('换脸'));
 assert.ok((await run(`document.querySelector('#ai-status').textContent`)).includes('已保留前一步结果'));
 assert.ok((await run(`document.querySelector('#studio-image-meta').textContent`)).includes('生成形体'));
 assert.equal(await run(`document.querySelectorAll('#local-stage-progress li').length`),2);
 console.log('PASS local optimization, body/clothing/scene/face order, preceding-result chaining, optional stages and failure retention');
 }catch(e){console.error(e);process.exitCode=1;}finally{win.destroy();fs.rmSync(root,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
