require('dotenv').config();
const express=require('express');
const path=require('path');
const fs=require('fs');
const crypto=require('crypto');
const {exec}=require('child_process');
const nodemailer=require('nodemailer');
const app=express();
const PORT=Number(process.env.PORT||3000);
const API='https://api.reefapi.com';
const searchCache=new Map(), inflight=new Map(), sessions=new Map();
const CACHE_MS=30*60*1000, STORE_CACHE_MS=60*60*1000;
const dataDir=path.join(__dirname,'data');
const cacheFile=path.join(dataDir,'search-cache.json');
const historyFile=path.join(dataDir,'history.json');
const usersFile=path.join(dataDir,'users.json');
const alertsFile=path.join(dataDir,'alerts.json');
const hotFile=path.join(dataDir,'hot-deals.json');
const HOT_CACHE_MS=6*60*60*1000;
const APP_URL=String(process.env.APP_URL||'http://localhost:'+PORT).replace(/\/$/,'');
function getReefKey(req){return String(req.headers['x-reef-api-key']||'').trim()}
function requireReefKey(req,res){const key=getReefKey(req);if(!key||key.length<10){res.status(401).json({error:'ReefAPI anahtarı gerekli.',code:'REEF_KEY_REQUIRED'});return null}return key}
function keyFingerprint(key){return crypto.createHash('sha256').update(key).digest('hex').slice(0,16)}
function apiCacheKey(prefix,key,q){return `${prefix}:${keyFingerprint(key)}:${cacheKey(q)}`}
fs.mkdirSync(dataDir,{recursive:true});

function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}}
function writeJson(file,x){fs.writeFileSync(file,JSON.stringify(x,null,2),'utf8')}
function normalizeQuery(q){let s=String(q||'').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'');s=s.replace(/\btehnic\b/g,'technic').replace(/\btecknic\b/g,'technic').replace(/\btehcnic\b/g,'technic').replace(/\bsupra\s*mk\s*([0-9]+)/g,'supra mk$1').replace(/\bmk\s*([0-9]+)/g,'mk$1').replace(/\bmark\s*([0-9]+)/g,'mk$1').replace(/\s+/g,' ').trim();return s}
function cacheKey(q){return normalizeQuery(q)}
function pruneCache(){const now=Date.now();for(const [k,v] of searchCache){const max=k.startsWith('more:')?STORE_CACHE_MS:CACHE_MS;if(now-v.at>max)searchCache.delete(k)}}
function loadDiskCache(){const obj=readJson(cacheFile,{});for(const [k,v] of Object.entries(obj)){const max=k.startsWith('more:')?STORE_CACHE_MS:CACHE_MS;if(Date.now()-v.at<max)searchCache.set(k,v)}}
function saveDiskCache(){try{writeJson(cacheFile,Object.fromEntries(searchCache))}catch{}}
loadDiskCache();
const demo=[
{id:'demo-1',source:'demo',store:'Demo',name:'GeForce RTX 5070 Ti 16GB',cat:'Bilgisayar',price:34999,old:42999,img:'🖥️',url:'#',trend:[42999,41999,39999,38999,36999,35999,34999]},
{id:'demo-2',source:'demo',store:'Demo',name:'LEGO Technic Toyota Supra MK4',cat:'LEGO & Hobi',price:2125,old:2999,img:'🧱',url:'#',trend:[2999,2899,2799,2499,2299,2199,2125]},
{id:'demo-3',source:'demo',store:'Demo',name:'Samsung Galaxy S Serisi 256GB',cat:'Telefon',price:28999,old:33999,img:'📱',url:'#',trend:[33999,32999,31999,30999,29999,29499,28999]},
{id:'demo-4',source:'demo',store:'Demo',name:'Kablosuz Gaming Headset 2.4G',cat:'Gaming',price:2199,old:2999,img:'🎧',url:'#',trend:[2999,2899,2699,2599,2399,2299,2199]}];
function num(v){if(typeof v==='number')return v;if(v==null)return null;const s=String(v).replace(/\./g,'').replace(',','.').replace(/[^0-9.-]/g,'');const n=Number(s);return Number.isFinite(n)?n:null}
function pick(o,...keys){for(const k of keys)if(o&&o[k]!=null)return o[k];return null}
function imageOf(o){return pick(o,'image','image_url','thumbnail','imageUrl')||''}
function firstNumber(o, keys){for(const k of keys){const v=o?.[k];const n=num(v);if(n!=null)return n}return null}
function n11BasketPrice(row){
  if(!row)return null;
  const direct=firstNumber(row,['basket_price','cart_price','sale_price','campaign_price','discounted_price','lowest_price']);
  if(direct!=null)return direct;
  const campaign=row.campaign;
  if(campaign&&typeof campaign==='object'){
    const c=firstNumber(campaign,['price','sale_price','basket_price','cart_price','discounted_price','lowest_price']);
    if(c!=null)return c;
    const nested=campaign.offer||campaign.basket||campaign.cart;
    const n=firstNumber(nested,['price','sale_price','basket_price','cart_price','discounted_price']);
    if(n!=null)return n;
  }
  const offers=Array.isArray(row.offers)?row.offers:Array.isArray(row.variants)?row.variants:[];
  for(const offer of offers){
    const n=firstNumber(offer,['basket_price','cart_price','sale_price','discounted_price','price']);
    if(n!=null)return n;
  }
  return null;
}
function normalize(source,row,i){const hb=source==='hepsiburada',n11=source==='n11';const n11Basket=n11?n11BasketPrice(row):null;const price=n11Basket??(hb?firstNumber(row,['sale_price','price','current_price','buybox_price','price_number']):firstNumber(row,['price','current_price','sale_price','buybox_price','price_number']));const old=firstNumber(row,n11?['list_price','original_price','old_price','was_price','original_price_value','price_before_discount']:['list_price','original_price','old_price','was_price','original_price_value'])||price;const name=pick(row,'title','name','product_name')||'İsimsiz ürün';const raw=String(pick(row,hb?'sku':n11?'product_id':'content_id','product_id','id','item_id')||`${source}-${i}`);const url=pick(row,'url','product_url','link')||'#';const store=source==='trendyol'?'Trendyol':hb?'Hepsiburada':'n11';const stock=pick(row,'in_stock','stock','stock_status','available');return{id:`${source}-${raw}`,rawId:raw,source,store,name,brand:pick(row,'brand','brand_name')||'',cat:pick(row,'category','category_name')||'Genel',price,old,img:imageOf(row),url,rating:pick(row,'rating','rating_score'),comment_count:pick(row,'comment_count','review_count'),in_stock:stock,free_cargo:pick(row,'free_cargo','free_shipping'),gtin:pick(row,'gtin','ean','barcode')||'',trend:price?[price]:[],offers:[{source,store,price,old,url,img:imageOf(row),rawId:raw,stock,basket_price:n11Basket}],basket_price:n11Basket,campaign:pick(row,'campaign','campaigns')}}
async function reef(endpoint,body,signal,apiKey){if(!apiKey)throw new Error('ReefAPI anahtarı gerekli');const controller=new AbortController();const abort=()=>controller.abort();if(signal){if(signal.aborted)controller.abort();else signal.addEventListener('abort',abort,{once:true})}const timer=setTimeout(()=>controller.abort(),9000);let r;try{r=await fetch(API+endpoint,{method:'POST',headers:{'x-api-key':apiKey,'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal})}finally{clearTimeout(timer);if(signal)signal.removeEventListener('abort',abort)}const j=await r.json().catch(()=>({}));if(!r.ok||j.ok===false)throw new Error(j?.error?.message||j?.error||`ReefAPI HTTP ${r.status}`);return j}
async function searchStore(source,q,opts={},signal,apiKey){
if(source==='trendyol')return reef('/trendyol/v1/search',{query:q,page:1,max_pages:1,...opts},signal,apiKey);
if(source==='hepsiburada')return reef('/hepsiburada/v1/search',{query:q,page:1,...opts},signal,apiKey);
if(source==='n11')return reef('/n11/v1/search',{query:q,page:1,...opts},signal,apiKey);return null}
function rowsFrom(j){return j?.data?.results||j?.data?.products||j?.data?.items||[]}
function cleanText(s){return String(s||'').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/tehnic/g,'technic').replace(/tecknic/g,'technic').replace(/tehcnic/g,'technic').replace(/mk\s*([0-9]+)/g,'mk$1').replace(/[^a-z0-9]+/g,' ').trim()}
function productKey(p){if(p.gtin)return `gtin:${String(p.gtin).replace(/\D/g,'')}`;return `${cleanText(p.brand)}|${cleanText(p.name).replace(/\b(turkiye|garantili|garantisi|satici|magaza|marketplace)\b/g,' ').replace(/\s+/g,' ').trim()}`}
function mergeResults(results){const uniq=new Map();for(const p of results){const key=productKey(p);if(!uniq.has(key)){uniq.set(key,p);continue}const cur=uniq.get(key);cur.offers=[...(cur.offers||[]),...(p.offers||[])];if(p.price!=null&&(cur.price==null||p.price<cur.price)){cur.price=p.price;cur.old=p.old;cur.url=p.url;cur.store=p.store;cur.source=p.source;cur.rawId=p.rawId}if(!cur.img&&p.img)cur.img=p.img;if(!cur.brand&&p.brand)cur.brand=p.brand;if(!cur.gtin&&p.gtin)cur.gtin=p.gtin;if(!cur.rating&&p.rating)cur.rating=p.rating;if(!cur.comment_count&&p.comment_count)cur.comment_count=p.comment_count}return [...uniq.values()]}
async function runStores(sources,q,opts={},signal,apiKey){const settled=await Promise.allSettled(sources.map(s=>searchStore(s,q,opts,signal,apiKey)));const results=[],errors=[],byStore={};settled.forEach((x,i)=>{const source=sources[i];byStore[source]=[];if(x.status==='fulfilled')rowsFrom(x.value).forEach((r,k)=>{const n=normalize(source,r,k);if(n.price!=null){results.push(n);byStore[source].push(n)}});else errors.push(`${source}: ${x.reason?.message||x.reason}`)});return{results:mergeResults(results),byStore,errors}}
function makePayload(q,norm,results,errors,checked,extra={}){return{live:true,results,errors,checked,query:q,normalizedQuery:norm,cacheSeconds:CACHE_MS/1000,...extra}}
function history(){return readJson(historyFile,{})}
function recordHistory(results){const h=history(),now=new Date().toISOString();for(const p of results){if(p.price==null)continue;h[p.id]=h[p.id]||[];const arr=h[p.id];if(!arr.length||Math.abs(Number(arr[arr.length-1].price)-Number(p.price))>.001||new Date(arr[arr.length-1].at).toDateString()!==new Date(now).toDateString())arr.push({price:p.price,at:now,store:p.store});h[p.id]=arr.slice(-365)}writeJson(historyFile,h)}
function opportunity(p,hist){const arr=(hist[p.id]||[]).map(x=>Number(x.price)).filter(Number.isFinite);const current=Number(p.price);if(!Number.isFinite(current))return{score:0,label:'NORMAL'};const low=arr.length?Math.min(...arr):current;const d=p.old&&p.old>current?Math.round((1-current/p.old)*100):0;const vsLow=low>0?Math.round((current/low-1)*100):0;let score=0;if(d>=30)score+=35;else if(d>=20)score+=25;else if(d>=10)score+=12;if(arr.length>=3&&current<=low*1.01)score+=55;else if(arr.length>=3&&current<=low*1.05)score+=35;return{score:Math.min(100,score),label:score>=70?'🔥 FIRSAT':score>=35?'📉 İYİ FİYAT':'NORMAL',historyLow:arr.length?low:null,vsLow}}
function enrich(results){const h=history();return results.map(p=>({...p,opportunity:opportunity(p,h)}))}

app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/api/health',(req,res)=>res.json({ok:true,live:Boolean(getReefKey(req)),time:new Date().toISOString()}));
app.get('/api/products',(req,res)=>res.json(enrich(demo)));
app.get('/api/stores',(req,res)=>{const has=Boolean(getReefKey(req));res.json(['Trendyol','Hepsiburada','n11','Amazon TR','MediaMarkt','Teknosa','Vatan','İtopya','İncehesap'].map(name=>({name,configured:['Trendyol','Hepsiburada','n11'].includes(name)&&has,live:['Trendyol','Hepsiburada','n11'].includes(name)&&has})))}) ;

app.get('/api/search',async(req,res)=>{
const q=String(req.query.q||'').trim();const apiKey=requireReefKey(req,res);if(!apiKey)return;pruneCache();const key=cacheKey(q);
if(!q)return res.json({live:true,results:enrich(demo),message:'Arama kutusuna ürün yaz.'});
const ck=apiCacheKey('primary',apiKey,q),cached=searchCache.get(ck);if(cached&&Date.now()-cached.at<CACHE_MS)return res.json({...cached.data,results:enrich(cached.data.results),cached:true});
if(inflight.has(ck))try{return res.json({...await inflight.get(ck),deduped:true})}catch(e){return res.status(502).json({error:e.message})}
const controller=new AbortController(),closeHandler=()=>{if(req.destroyed)controller.abort()};req.on('close',closeHandler);
const job=(async()=>{const r=await runStores(['trendyol'],key,{},controller.signal,apiKey);recordHistory(r.results);const payload=makePayload(q,key,enrich(r.results),r.errors,['Trendyol'],{comparisonReady:true,comparisonLoaded:false,totalCount:r.results.length});searchCache.set(ck,{at:Date.now(),data:payload});saveDiskCache();return payload})();
inflight.set(ck,job);try{const payload=await job;if(!res.headersSent)res.json(payload)}catch(e){if(!res.headersSent)res.status(502).json({error:e.message})}finally{inflight.delete(ck);req.off('close',closeHandler)}
});
app.get('/api/search-more',async(req,res)=>{
const q=String(req.query.q||'').trim();const apiKey=requireReefKey(req,res);if(!apiKey)return;const key=cacheKey(q);pruneCache();if(!q)return res.json({live:true,results:[],errors:[],checked:[]});
const ck=apiCacheKey('more',apiKey,q),cached=searchCache.get(ck);if(cached&&Date.now()-cached.at<STORE_CACHE_MS)return res.json({...cached.data,results:enrich(cached.data.results),cached:true});
try{const r=await runStores(['hepsiburada','n11'],key,{},undefined,apiKey);const primary=searchCache.get(apiCacheKey('primary',apiKey,q))?.data?.results||[];const merged=mergeResults([...primary,...r.results]);recordHistory(merged);const payload=makePayload(q,key,enrich(merged),r.errors,['Trendyol','Hepsiburada','n11'],{comparisonReady:true,comparisonLoaded:true,storeResults:{Trendyol:primary,Hepsiburada:r.byStore.hepsiburada||[],n11:r.byStore.n11||[]}});searchCache.set(ck,{at:Date.now(),data:payload});searchCache.set(apiCacheKey('primary',apiKey,q),{at:Date.now(),data:payload});saveDiskCache();res.json(payload)}catch(e){res.status(502).json({error:e.message})}
});
app.get('/api/hot-deals',async(req,res)=>{
const apiKey=requireReefKey(req,res);if(!apiKey)return;const hotKey=keyFingerprint(apiKey),cached=readJson(hotFile,null);
if(cached&&cached.key===hotKey&&cached.at&&Date.now()-cached.at<HOT_CACHE_MS&&Array.isArray(cached.results))return res.json({live:true,results:enrich(cached.results),cached:true});
try{const queries=['lego technic','iphone','gaming laptop'],all=[];for(const q of queries){const r=await runStores(['trendyol'],q,{},undefined,apiKey);recordHistory(r.results);all.push(...r.results)}const merged=mergeResults(all);const hot=enrich(merged).filter(p=>Number(p.price)>0).sort((a,b)=>(b.opportunity?.score||0)-(a.opportunity?.score||0)).slice(0,12);writeJson(hotFile,{at:Date.now(),key:hotKey,results:hot});res.json({live:true,results:hot,cached:false})}catch(e){res.status(502).json({error:e.message,results:[]})}
});
app.get('/api/product/:source/:id',async(req,res)=>{try{const apiKey=requireReefKey(req,res);if(!apiKey)return;const{source,id}=req.params;let j;if(source==='trendyol')j=await reef('/trendyol/v1/product/detail',{content_id:id},undefined,apiKey);else if(source==='hepsiburada')j=await reef('/hepsiburada/v1/product/detail',{sku:id},undefined,apiKey);else if(source==='n11')j=await reef('/n11/v1/product/detail',{product_id:id},undefined,apiKey);else return res.status(404).json({error:'Desteklenmeyen mağaza'});res.json(j)}catch(e){res.status(502).json({error:e.message})}});


app.get('/api/history/:id',(req,res)=>{const h=history()[req.params.id]||[];const prices=h.map(x=>Number(x.price)).filter(Number.isFinite);res.json({history:h,low:prices.length?Math.min(...prices):null,high:prices.length?Math.max(...prices):null})});
app.get('/api/suggestions',async(req,res)=>{const q=String(req.query.q||'').trim().toLocaleLowerCase('tr-TR');const out=new Set();for(const k of searchCache.keys()){if(k.startsWith('primary:')){const parts=k.split(':');const s=parts.slice(2).join(':');if(!q||s.includes(q))out.add(s)}}res.json([...out].slice(0,8))});

function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')){return new Promise((resolve,reject)=>crypto.scrypt(String(password),salt,64,(e,key)=>e?reject(e):resolve({salt,hash:key.toString('hex')})))}
function checkPassword(password,user){return new Promise((resolve,reject)=>crypto.scrypt(String(password),user.salt,64,(e,key)=>e?reject(e):resolve(crypto.timingSafeEqual(Buffer.from(user.hash,'hex'),key))))}
function getUsers(){return readJson(usersFile,[])}
function saveUsers(x){writeJson(usersFile,x)}
function currentUser(req){const token=req.headers.authorization?.replace(/^Bearer\s+/i,'');return token?sessions.get(token):null}
function requireUser(req,res,next){const u=currentUser(req);if(!u)return res.status(401).json({error:'Giriş yapmalısın'});req.user=u;next()}
function isAdmin(req){return req.user?.role==='admin'}
function hashToken(token){return crypto.createHash('sha256').update(token).digest('hex')}
function authSecret(){
  const raw=String(process.env.AUTH_SECRET||'').trim();
  if(raw.length>=32)return raw;
  // Development fallback only. Set AUTH_SECRET on Render for production.
  return crypto.createHash('sha256').update(APP_URL+'|techavi-auth-fallback').digest('hex');
}
function makeVerificationToken(user){
  const payload=Buffer.from(JSON.stringify({
    v:1,id:user.id,name:user.name,email:user.email,salt:user.salt,hash:user.hash,
    role:user.role||'user',exp:Date.now()+24*60*60*1000
  })).toString('base64url');
  const iv=crypto.randomBytes(12);
  const key=crypto.createHash('sha256').update(authSecret()).digest();
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const enc=Buffer.concat([cipher.update(payload,'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return [iv.toString('base64url'),tag.toString('base64url'),enc.toString('base64url')].join('.');
}
function readVerificationToken(token){
  try{
    const [ivB64,tagB64,dataB64]=String(token||'').split('.');
    if(!ivB64||!tagB64||!dataB64) return null;
    const key=crypto.createHash('sha256').update(authSecret()).digest();
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(ivB64,'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64,'base64url'));
    const plain=Buffer.concat([decipher.update(Buffer.from(dataB64,'base64url')),decipher.final()]).toString('utf8');
    const p=JSON.parse(Buffer.from(plain,'base64url').toString('utf8'));
    if(!p?.id||!p?.email||!p?.hash||!p?.salt||Number(p.exp)<=Date.now()) return null;
    return p;
  }catch{return null}
}
function smtpReady(){return Boolean(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS)}
function smtpTransport(){if(!smtpReady())return null;return nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE||'false')==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}})}
function resendReady(){return Boolean(process.env.RESEND_API_KEY&&process.env.RESEND_FROM)}
async function sendVerificationEmail(user,rawToken){
  const link=APP_URL+'/api/auth/verify?token='+encodeURIComponent(rawToken);
  const safeName=String(user.name).replace(/[<>]/g,'');
  const html=`<div style=\"font-family:Arial,sans-serif;line-height:1.6;max-width:620px;margin:auto;padding:28px;background:#07100d;color:#eaf7f2\"><h2 style=\"color:#45e5b5\">TechAvıV1</h2><p>Merhaba ${safeName},</p><p>Hesabını doğrulamak için aşağıdaki düğmeye tıkla:</p><p><a href=\"${link}\" style=\"display:inline-block;padding:13px 20px;background:#22bfa1;color:#04120f;text-decoration:none;border-radius:9px;font-weight:bold\">E-postamı Doğrula</a></p><p>Bu bağlantı 24 saat geçerlidir ve yalnızca bir kez kullanılabilir.</p></div>`;
  const text=`Merhaba ${safeName},\n\nTechAvıV1 hesabını doğrulamak için bu bağlantıyı aç:\n${link}\n\nBağlantı 24 saat geçerlidir ve yalnızca bir kez kullanılabilir.`;
  if(resendReady()){
    const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.RESEND_FROM,to:[user.email],subject:'TechAvıV1 e-posta doğrulama',html,text})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){const detail=j?.message||j?.name||j?.error?.message||`Resend HTTP ${r.status}`;throw new Error(`Resend: ${detail}`);}
    return {sent:true,provider:'resend'};
  }
  const transporter=smtpTransport();
  if(transporter){await transporter.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to:user.email,subject:'TechAvıV1 e-posta doğrulama',text,html});return {sent:true,provider:'smtp'};}
  throw new Error('E-posta servisi yapılandırılmamış. Render Environment Variables bölümünde RESEND_API_KEY ve RESEND_FROM ayarlanmalı.');
}
app.post('/api/auth/register',async(req,res)=>{
  try{
    const name=String(req.body.name||'').trim();
    const email=String(req.body.email||'').trim().toLowerCase();
    const password=String(req.body.password||'');
    if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8)
      return res.status(400).json({error:'Geçerli ad, e-posta ve en az 8 karakter şifre gerekli.'});
    const users=getUsers();
    if(users.some(u=>u.email===email))return res.status(409).json({error:'Bu e-posta zaten kayıtlı.'});
    const hp=await hashPassword(password);
    const user={id:crypto.randomUUID(),name,email,...hp,role:'user',createdAt:new Date().toISOString(),verifiedAt:null};
    // The verification link is self-contained and encrypted, so a Render restart
    // cannot invalidate it merely because an in-memory token/file disappeared.
    const verificationToken=makeVerificationToken(user);
    const oldUsers=users.slice();
    users.push(user);
    saveUsers(users);
    try{
      const mail=await sendVerificationEmail(user,verificationToken);
      const out={needsVerification:true,email};
      if(mail.devVerificationUrl)out.devVerificationUrl=mail.devVerificationUrl;
      res.status(201).json(out);
    }catch(mailErr){
      // Don't leave a half-created account if the email provider rejects the send.
      saveUsers(oldUsers);
      throw mailErr;
    }
  }catch(e){
    res.status(500).json({error:e.message||'Kayıt veya doğrulama e-postası hazırlanırken hata oluştu.'});
  }
});
app.get('/api/auth/verify',async(req,res)=>{
  const token=String(req.query.token||'');
  const payload=readVerificationToken(token);
  if(!payload)
    return res.status(400).send('<!doctype html><meta charset="utf-8"><title>TechAvıV1</title><body style="font-family:Arial;background:#070a0f;color:#fff;padding:40px;text-align:center"><h2>Doğrulama bağlantısı geçersiz veya süresi dolmuş.</h2><p>TechAvıV1 üzerinden yeni bir doğrulama e-postası isteyebilirsin.</p></body>');
  const users=getUsers();
  let u=users.find(x=>x.id===payload.id||x.email===payload.email);
  // Recover the account from the signed/encrypted verification link if the
  // ephemeral Render filesystem was reset after the email was sent.
  if(!u){
    u={id:payload.id,name:payload.name,email:payload.email,salt:payload.salt,hash:payload.hash,role:payload.role||'user',createdAt:new Date().toISOString(),verifiedAt:null};
    users.push(u);
  }
  if(u.verifiedAt)
    return res.send('<!doctype html><meta charset="utf-8"><title>TechAvıV1</title><body style="font-family:Arial;background:#070a0f;color:#fff;padding:40px;text-align:center"><h2 style="color:#45e5b5">E-posta zaten doğrulanmış ✓</h2><p>TechAvıV1 üzerinden giriş yapabilirsin.</p></body>');
  u.verifiedAt=new Date().toISOString();
  saveUsers(users);
  res.send('<!doctype html><meta charset="utf-8"><title>TechAvıV1</title><body style="font-family:Arial;background:#070a0f;color:#fff;padding:40px;text-align:center"><h2 style="color:#45e5b5">E-posta doğrulandı ✓</h2><p>Hesabın artık kullanılabilir. TechAvıV1 sekmesine geri dönüp giriş yapabilirsin.</p></body>');
});
app.post('/api/auth/resend-verification',async(req,res)=>{
  try{
    const email=String(req.body.email||'').trim().toLowerCase();
    const users=getUsers(),u=users.find(x=>x.email===email);
    if(!u||u.verifiedAt)return res.json({ok:true});
    const verificationToken=makeVerificationToken(u);
    const mail=await sendVerificationEmail(u,verificationToken);
    res.json({ok:true,...(mail.devVerificationUrl?{devVerificationUrl:mail.devVerificationUrl}:{})});
  }catch(e){
    res.status(500).json({error:e.message||'Doğrulama e-postası gönderilemedi.'});
  }
});
app.post('/api/auth/login',async(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');const users=getUsers();let user=users.find(u=>u.email===email);const adminEmail=String(process.env.ADMIN_EMAIL||'admin@techavi.local').replace(/\s/g,'').toLowerCase();if(!user&&email===adminEmail&&password===String(process.env.ADMIN_PASSWORD||'admin123')){user={id:'admin',name:'TechAvı Admin',email:adminEmail,role:'admin',verifiedAt:true}}if(!user)return res.status(401).json({error:'E-posta veya şifre hatalı.'});if(user.id!=='admin'&&!await checkPassword(password,user))return res.status(401).json({error:'E-posta veya şifre hatalı.'});if(user.id!=='admin'&&!user.verifiedAt)return res.status(403).json({error:'Önce e-posta adresini doğrula.',needsVerification:true});const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{id:user.id,name:user.name,email:user.email,role:user.role});res.json({token,user:sessions.get(token)})});
app.get('/api/auth/me',requireUser,(req,res)=>res.json({user:req.user}));
app.post('/api/auth/logout',requireUser,(req,res)=>{const token=req.headers.authorization?.replace(/^Bearer\s+/i,'');sessions.delete(token);res.json({ok:true})});

function getAlerts(){return readJson(alertsFile,[])}
function saveAlerts(x){writeJson(alertsFile,x)}
app.get('/api/alarms',requireUser,(req,res)=>res.json(getAlerts().filter(a=>a.userId===req.user.id)));
app.post('/api/alarms',requireUser,(req,res)=>{const product=req.body.product||{};const target=Number(req.body.target);if(!product.id||!Number.isFinite(target)||target<=0)return res.status(400).json({error:'Geçerli ürün ve hedef fiyat gerekli.'});const all=getAlerts().filter(a=>!(a.userId===req.user.id&&a.productId===product.id));const item={id:crypto.randomUUID(),userId:req.user.id,productId:product.id,productName:String(product.name||''),image:String(product.img||''),currentPrice:Number(product.price)||null,target,store:String(product.store||''),createdAt:new Date().toISOString(),triggered:false};all.push(item);saveAlerts(all);res.json(item)});
app.delete('/api/alarms/:id',requireUser,(req,res)=>{saveAlerts(getAlerts().filter(a=>!(a.id===req.params.id&&a.userId===req.user.id)));res.json({ok:true})});
app.post('/api/alarms/check',requireUser,(req,res)=>{const alerts=getAlerts();let count=0;for(const a of alerts.filter(x=>x.userId===req.user.id&&!x.triggered)){const p=(req.body.products||[]).find(x=>x.id===a.productId);if(p&&Number(p.price)<=Number(a.target)){a.triggered=true;a.triggeredAt=new Date().toISOString();a.currentPrice=Number(p.price);count++}}saveAlerts(alerts);res.json({triggered:count,alerts:alerts.filter(a=>a.userId===req.user.id)})});

app.get('/api/admin/stats',requireUser,(req,res)=>{if(!isAdmin(req))return res.status(403).json({error:'Yetkisiz'});const users=getUsers(),alerts=getAlerts(),hist=history();res.json({users:users.length,alarms:alerts.length,trackedProducts:Object.keys(hist).length,cacheEntries:searchCache.size,live:true,sessions:sessions.size})});
app.get('/api/admin/users',requireUser,(req,res)=>{if(!isAdmin(req))return res.status(403).json({error:'Yetkisiz'});res.json(getUsers().map(({id,name,email,role,createdAt})=>({id,name,email,role,createdAt})))});

app.listen(PORT,'0.0.0.0',()=>{
  console.log(`TechAvıV1 http://localhost:${PORT}`);
  if(process.platform==='win32'){setTimeout(()=>exec(`start "" "http://localhost:${PORT}"`),700);}
});
