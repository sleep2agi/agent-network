import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const out='/output';mkdirSync(out,{recursive:true});
const server=createServer((req,res)=>{const p=new URL(req.url,'http://localhost').pathname;const files={'/':'index.html','/style.css':'style.css','/assets/task-board.png':'assets/task-board.png','/assets/task-board-phone.png':'assets/task-board-phone.png','/assets/chat.png':'assets/chat.png'};if(!files[p]){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',p.endsWith('.png')?'image/png':p.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(readFileSync('/qa/site/'+files[p]));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({args:['--no-sandbox']});let passed=0,total=0;const checks=[];
const ck=(name,ok,data)=>{total++;if(ok)passed++;checks.push({name,ok,data});console.log(`${ok?'PASS':'FAIL'} ${name} ${JSON.stringify(data??'')}`);};
try {for(const [name,width,height] of [['desktop',1440,1000],['phone',390,844]]){
 const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#product-image').evaluate(img=>img.decode());await page.evaluate(()=>document.fonts.ready);
 ck(name+' no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 ck(name+' one primary headline',await page.locator('h1').count()===1);
 const bounds=await page.locator('.hero .primary').boundingBox();ck(name+' hero action fits',bounds.width>=44&&bounds.height>=44&&bounds.x+bounds.width<=width,bounds);
 await page.screenshot({path:`${out}/${name}-hero.png`});await page.screenshot({path:`${out}/${name}-full.png`,fullPage:true});
 await page.getByRole('tab',{name:'Agent 对话'}).click();await page.locator('#product-image').evaluate(img=>img.decode());ck(name+' screenshot tabs work',await page.locator('#product-image').getAttribute('src')==='assets/chat.png');
 await page.getByRole('tab',{name:'Agent 对话'}).press('ArrowLeft');ck(name+' tabs support keyboard',await page.getByRole('tab',{name:'任务协作'}).getAttribute('aria-selected')==='true');
 await page.locator('.hero .primary').click();const dl=await page.locator('#download').boundingBox();ck(name+' download anchor works',dl.y>=0&&dl.y<height,dl);
 await page.screenshot({path:`${out}/${name}-download.png`});
 ck(name+' no runtime errors',errors.length===0,errors);await page.close();
}}finally{await browser.close();server.close();writeFileSync(out+'/measurements.json',JSON.stringify({passed,total,checks},null,2));}
console.log(`${passed}/${total} passed`);process.exit(passed===total?0:1);
